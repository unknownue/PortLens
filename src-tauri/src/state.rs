//! 接线层：应用状态 + 全部 Tauri 命令。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::config::{self, HealthConfig, Manifest, ServiceDef, Settings};
use crate::health::{HealthMachine, ServiceStatus, State as ServiceState, Tick};
use crate::logs::LogStore;
use crate::pages::{self, PageTab, UiState, WindowRect};
use crate::supervise::ServiceManager;
use crate::{netsh, ports, probe, proc};

pub struct AppState {
    pub manifest: Mutex<Manifest>,
    pub services: Mutex<ServiceManager>,
    pub logs: LogStore,
    pub machines: Mutex<HashMap<String, HealthMachine>>,
    pub ui: Mutex<UiState>,
    pub probe_schedule: Mutex<HashMap<String, u64>>,
    /// 最近一次观察到的退出码：`poll_exit` 只返回一次，这里粘住，让 Crashed 不抖成 Unknown。
    last_exit: Mutex<HashMap<String, i32>>,
    /// 用户主动停止的服务：标记后不再把随后的退出当成崩溃。启动时清除。
    stop_requested: Mutex<HashSet<String>>,
    port_env: Mutex<Option<netsh::PortEnv>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceView {
    pub id: String,
    pub name: String,
    pub port: u16,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub health: HealthConfig,
    pub status: ServiceStatus,
    pub risky: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenerView {
    pub port: u16,
    pub addr: String,
    pub pid: u32,
    pub name: String,
    pub exe: String,
    pub ppid: u32,
    pub parent_name: String,
    pub established: u32,
    pub service_id: Option<String>,
    pub ours: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvView {
    pub manifest_path: String,
    pub data_dir: String,
    pub dynamic_start: u16,
    pub dynamic_count: u32,
    pub excluded: Vec<(u16, u16)>,
}

impl AppState {
    pub fn new() -> Self {
        let manifest = config::load().unwrap_or_else(|e| {
            eprintln!("[portlens] 清单加载失败: {e}");
            Manifest::defaults()
        });
        let logs = LogStore::new();
        let mut services = ServiceManager::new(logs.clone());
        services.adopt(&manifest);
        let machines = manifest
            .services
            .iter()
            .map(|def| (def.id.clone(), HealthMachine::new(&def.id)))
            .collect();
        Self {
            manifest: Mutex::new(manifest),
            services: Mutex::new(services),
            logs,
            machines: Mutex::new(machines),
            ui: Mutex::new(pages::load_ui()),
            probe_schedule: Mutex::new(HashMap::new()),
            last_exit: Mutex::new(HashMap::new()),
            stop_requested: Mutex::new(HashSet::new()),
            port_env: Mutex::new(None),
        }
    }

    pub fn port_env(&self) -> netsh::PortEnv {
        let mut guard = self.port_env.lock();
        if let Some(env) = guard.as_ref() {
            return env.clone();
        }
        let env = netsh::query();
        *guard = Some(env.clone());
        env
    }

    pub fn def_of(&self, id: &str) -> Result<ServiceDef, String> {
        self.manifest
            .lock()
            .services
            .iter()
            .find(|def| def.id == id)
            .cloned()
            .ok_or_else(|| format!("服务不存在: {id}"))
    }

    pub fn status_of(&self, id: &str) -> ServiceStatus {
        self.machines
            .lock()
            .get(id)
            .map(|machine| machine.status())
            .unwrap_or_else(|| HealthMachine::new(id).status())
    }

    pub fn views(&self) -> Vec<ServiceView> {
        let defs = self.manifest.lock().services.clone();
        let env = self.port_env();
        let machines = self.machines.lock();
        defs.into_iter()
            .map(|def| {
                let status = machines
                    .get(&def.id)
                    .map(|machine| machine.status())
                    .unwrap_or_else(|| HealthMachine::new(&def.id).status());
                ServiceView {
                    id: def.id.clone(),
                    name: def.name.clone(),
                    port: def.port,
                    command: def.command.clone(),
                    cwd: def.cwd.clone(),
                    health: def.health.clone(),
                    status,
                    risky: netsh::is_risky(def.port, &env),
                }
            })
            .collect()
    }

    pub fn view_of(&self, id: &str) -> Result<ServiceView, String> {
        self.views()
            .into_iter()
            .find(|view| view.id == id)
            .ok_or_else(|| format!("服务不存在: {id}"))
    }

    pub fn listener_views(&self) -> Vec<ListenerView> {
        let defs = self.manifest.lock().services.clone();
        let services = self.services.lock();
        ports::list_tcp()
            .into_iter()
            .map(|listener| {
                let info = proc::info(listener.pid);
                let (name, exe, ppid) = info
                    .as_ref()
                    .map(|i| (i.name.clone(), i.exe.clone(), i.ppid))
                    .unwrap_or_default();
                let parent_name = proc::info(ppid).map(|p| p.name).unwrap_or_default();
                let service_id = defs.iter().find(|def| def.port == listener.port).map(|def| def.id.clone());
                let ours = service_id
                    .as_ref()
                    .and_then(|id| services.pid_of(id))
                    .map(|pid| pid == listener.pid || proc::is_descendant(listener.pid, pid))
                    .unwrap_or(false);
                ListenerView {
                    port: listener.port,
                    addr: listener.addr,
                    pid: listener.pid,
                    name,
                    exe,
                    ppid,
                    parent_name,
                    established: listener.established,
                    service_id,
                    ours,
                }
            })
            .collect()
    }

    /// 一次轮询：更新监听/存活/退出事实，按各自间隔跑探针，返回发生状态变化的服务快照。
    pub fn tick(&self) -> Vec<ServiceStatus> {
        let defs = self.manifest.lock().services.clone();
        let listeners = ports::list_tcp();
        let now = crate::health::now_ms();
        let mut changed = Vec::new();

        for def in &defs {
            let owner_pid = listeners.iter().find(|l| l.port == def.port).map(|l| l.pid);

            let (pid, alive, exit_now) = {
                let mut services = self.services.lock();
                let exit = services.poll_exit(&def.id);
                let pid = services.pid_of(&def.id);
                let alive = services.alive(&def.id);
                (pid, alive, exit)
            };

            // 主动停止的退出不算崩溃；退出码粘住一拍以上，避免 crashed 抖成 unknown。
            let intentional = self.stop_requested.lock().contains(&def.id);
            if let Some(code) = exit_now {
                let mut last = self.last_exit.lock();
                if intentional {
                    last.remove(&def.id);
                } else {
                    last.insert(def.id.clone(), code);
                }
            }
            let exit_code = if alive { None } else { self.last_exit.lock().get(&def.id).copied() };

            let managed = def.command.as_deref().map(|c| !c.trim().is_empty()).unwrap_or(false);
            // 命令经 cmd /C 执行，端口常由孙进程持有，所以按进程树判断归属。
            let owner_is_ours = match (owner_pid, pid) {
                (Some(owner), Some(mine)) => owner == mine || proc::is_descendant(owner, mine),
                _ => false,
            };

            let due = {
                let mut schedule = self.probe_schedule.lock();
                let next = schedule.entry(def.id.clone()).or_insert(0);
                if now >= *next {
                    *next = now + def.health.interval_ms.max(200);
                    true
                } else {
                    false
                }
            };
            let outcome = if due && def.health.kind != "none" {
                Some(probe::run(def.port, &def.health))
            } else {
                None
            };

            let tick = Tick {
                listening: owner_pid.is_some(),
                owner_is_ours,
                managed,
                alive,
                exit_code,
                probe: outcome,
            };

            let mut machines = self.machines.lock();
            let machine = machines
                .entry(def.id.clone())
                .or_insert_with(|| HealthMachine::new(&def.id));
            machine.set_pid(pid);
            machine.set_failure_threshold(def.health.failure_threshold);
            if machine.on_tick(tick, now) {
                changed.push(machine.status());
            }
        }

        changed
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

fn normalize_def(mut def: ServiceDef) -> ServiceDef {
    def.id = def.id.trim().to_string();
    if def.id.is_empty() {
        let slug: String = def
            .name
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
            .collect();
        let slug = slug.trim_matches('-').to_string();
        def.id = if slug.is_empty() { format!("port-{}", def.port) } else { format!("{slug}-{}", def.port) };
    }
    def.name = def.name.trim().to_string();
    if def.health.kind.trim().is_empty() {
        def.health.kind = "tcp".into();
    }
    def.health.kind = def.health.kind.to_ascii_lowercase();
    if def.health.interval_ms < 200 {
        def.health.interval_ms = 2000;
    }
    if def.health.timeout_ms == 0 {
        def.health.timeout_ms = 1000;
    }
    if def.health.failure_threshold == 0 {
        def.health.failure_threshold = 2;
    }
    if def.command.as_deref().map(|c| c.trim().is_empty()).unwrap_or(true) {
        def.command = None;
    }
    if def.cwd.as_deref().map(|c| c.trim().is_empty()).unwrap_or(true) {
        def.cwd = None;
    }
    def
}

fn save_manifest(state: &AppState) -> Result<(), String> {
    let manifest = state.manifest.lock().clone();
    config::save(&manifest)
}

// ---------------------------------------------------------------- services

#[tauri::command]
pub fn get_services(state: State<'_, Arc<AppState>>) -> Vec<ServiceView> {
    state.views()
}

#[tauri::command]
pub fn add_service(state: State<'_, Arc<AppState>>, service: ServiceDef) -> Result<Vec<ServiceView>, String> {
    let def = normalize_def(service);
    {
        let mut manifest = state.manifest.lock();
        if manifest.services.iter().any(|s| s.id == def.id) {
            return Err(format!("服务 id 已存在: {}", def.id));
        }
        manifest.services.push(def.clone());
    }
    if let Err(err) = save_manifest(&state) {
        state.manifest.lock().services.retain(|s| s.id != def.id);
        return Err(err);
    }
    state.machines.lock().insert(def.id.clone(), HealthMachine::new(&def.id));
    Ok(state.views())
}

#[tauri::command]
pub fn update_service(state: State<'_, Arc<AppState>>, service: ServiceDef) -> Result<Vec<ServiceView>, String> {
    let def = normalize_def(service);
    {
        let mut manifest = state.manifest.lock();
        let Some(slot) = manifest.services.iter_mut().find(|s| s.id == def.id) else {
            return Err(format!("服务不存在: {}", def.id));
        };
        *slot = def.clone();
    }
    save_manifest(&state)?;
    Ok(state.views())
}

#[tauri::command]
pub async fn remove_service(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<Vec<ServiceView>, String> {
    if let Ok(def) = state.def_of(&id) {
        state.stop_requested.lock().insert(id.clone());
        let _ = state.services.lock().stop(&def, true);
    }
    state.stop_requested.lock().remove(&id);
    state.last_exit.lock().remove(&id);
    state.manifest.lock().services.retain(|s| s.id != id);
    save_manifest(&state)?;
    state.machines.lock().remove(&id);
    state.logs.clear(&id);
    let views = state.views();
    let _ = app.emit("port-status", views.iter().map(|v| v.status.clone()).collect::<Vec<_>>());
    Ok(views)
}

#[tauri::command]
pub async fn start_service(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<ServiceView, String> {
    let def = state.def_of(&id)?;
    // 用户主动启动：清掉「主动停止」标记与粘住的退出码，让状态从 Starting 重新走。
    state.stop_requested.lock().remove(&id);
    state.last_exit.lock().remove(&id);
    let pid = state.services.lock().start(&def)?;
    if let Some(machine) = state.machines.lock().get_mut(&id) {
        machine.set_pid(Some(pid));
    }
    let view = state.view_of(&id)?;
    let _ = app.emit("port-status", vec![view.status.clone()]);
    Ok(view)
}

#[tauri::command]
pub async fn stop_service(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    id: String,
    force: bool,
) -> Result<ServiceView, String> {
    let def = state.def_of(&id)?;
    state.stop_requested.lock().insert(id.clone());
    let result = state.services.lock().stop(&def, force);
    let view = state.view_of(&id)?;
    let _ = app.emit("port-status", vec![view.status.clone()]);
    result.map(|_| view)
}

#[tauri::command]
pub async fn restart_service(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<ServiceView, String> {
    let def = state.def_of(&id)?;
    {
        state.stop_requested.lock().insert(id.clone());
        let mut services = state.services.lock();
        let _ = services.stop(&def, false);
    }
    state.stop_requested.lock().remove(&id);
    state.last_exit.lock().remove(&id);
    let pid = state.services.lock().start(&def)?;
    if let Some(machine) = state.machines.lock().get_mut(&id) {
        machine.set_pid(Some(pid));
    }
    let view = state.view_of(&id)?;
    let _ = app.emit("port-status", vec![view.status.clone()]);
    Ok(view)
}

#[tauri::command]
pub async fn stop_all_services(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    force: bool,
) -> Result<Vec<ServiceView>, String> {
    let manifest = state.manifest.lock().clone();
    {
        let mut flags = state.stop_requested.lock();
        for def in manifest.services.iter().filter(|s| s.command.is_some()) {
            flags.insert(def.id.clone());
        }
    }
    state.services.lock().stop_all(&manifest, force);
    let views = state.views();
    let _ = app.emit("port-status", views.iter().map(|v| v.status.clone()).collect::<Vec<_>>());
    Ok(views)
}

#[tauri::command]
pub async fn probe_now(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<ServiceView, String> {
    let def = state.def_of(&id)?;
    let changed = state.tick();
    let view = state.view_of(&id)?;
    if !changed.is_empty() {
        let _ = app.emit("port-status", changed);
    }
    let _ = &def;
    Ok(view)
}

#[tauri::command]
pub fn get_service_logs(state: State<'_, Arc<AppState>>, id: String, limit: usize) -> Vec<String> {
    state.logs.tail(&id, limit.clamp(1, 2000))
}

#[tauri::command]
pub fn clear_service_logs(state: State<'_, Arc<AppState>>, id: String) {
    state.logs.clear(&id);
}

// ---------------------------------------------------------------- ports/procs

#[tauri::command]
pub fn list_listeners(state: State<'_, Arc<AppState>>) -> Vec<ListenerView> {
    state.listener_views()
}

#[tauri::command]
pub async fn stop_pid(app: AppHandle, force: bool, pid: u32) -> Result<(), String> {
    proc::kill_tree(pid, force)?;
    std::thread::sleep(std::time::Duration::from_millis(200));
    let _ = app;
    Ok(())
}

// ---------------------------------------------------------------- pages

#[tauri::command]
pub fn list_pages(state: State<'_, Arc<AppState>>) -> Vec<PageTab> {
    state.ui.lock().tabs.clone()
}

/// 取出上次会话保存的标签（读后清空，由前端重新 open_page 建视图）。
#[tauri::command]
pub fn take_saved_pages(state: State<'_, Arc<AppState>>) -> Vec<PageTab> {
    let mut ui = state.ui.lock();
    let tabs = ui.tabs.clone();
    ui.tabs.clear();
    ui.active = None;
    pages::save_ui(&ui);
    tabs
}

#[tauri::command]
pub async fn open_page(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    url: String,
    title: String,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
) -> Result<PageTab, String> {
    let rect = WindowRect { x, y, w, h };
    let mut ui = state.ui.lock();
    let labels: Vec<String> = ui.tabs.iter().map(|tab| tab.label.clone()).collect();
    let label = pages::next_label(&labels);
    pages::open(&app, &label, &url, rect)?;
    for tab in ui.tabs.iter() {
        let _ = pages::set_visible(&app, &tab.label, false);
    }
    let tab = PageTab { label: label.clone(), title, url };
    ui.tabs.push(tab.clone());
    ui.active = Some(label.clone());
    pages::save_ui(&ui);
    Ok(tab)
}

#[tauri::command]
pub async fn close_page(app: AppHandle, state: State<'_, Arc<AppState>>, label: String) -> Result<(), String> {
    let mut ui = state.ui.lock();
    let closing_active = ui.active.as_deref() == Some(label.as_str());
    ui.tabs.retain(|tab| tab.label != label);
    if closing_active {
        ui.active = None;
    }
    let _ = pages::close(&app, &label);
    if closing_active {
        pages::hide_all(&app);
    }
    pages::save_ui(&ui);
    Ok(())
}

/// `label = None` 表示回到仪表盘（隐藏全部页面视图）。
#[tauri::command]
pub async fn activate_page(app: AppHandle, state: State<'_, Arc<AppState>>, label: Option<String>) -> Result<(), String> {
    let mut ui = state.ui.lock();
    match label {
        Some(label) => {
            for tab in ui.tabs.iter().filter(|tab| tab.label != label) {
                let _ = pages::set_visible(&app, &tab.label, false);
            }
            pages::set_visible(&app, &label, true)?;
            ui.active = Some(label);
        }
        None => {
            pages::hide_all(&app);
            ui.active = None;
        }
    }
    pages::save_ui(&ui);
    Ok(())
}

#[tauri::command]
pub async fn set_page_bounds(
    app: AppHandle,
    label: String,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
) -> Result<(), String> {
    pages::set_bounds(&app, &label, WindowRect { x, y, w, h })
}

#[tauri::command]
pub async fn navigate_page(app: AppHandle, state: State<'_, Arc<AppState>>, label: String, url: String) -> Result<(), String> {
    pages::navigate(&app, &label, &url)?;
    let mut ui = state.ui.lock();
    if let Some(tab) = ui.tabs.iter_mut().find(|tab| tab.label == label) {
        tab.url = url;
    }
    pages::save_ui(&ui);
    Ok(())
}

#[tauri::command]
pub async fn reload_page(app: AppHandle, label: String) -> Result<(), String> {
    pages::reload(&app, &label)
}

#[tauri::command]
pub fn rename_page(state: State<'_, Arc<AppState>>, label: String, title: String) -> Result<(), String> {
    let mut ui = state.ui.lock();
    if let Some(tab) = ui.tabs.iter_mut().find(|tab| tab.label == label) {
        tab.title = title;
    }
    pages::save_ui(&ui);
    Ok(())
}

// ---------------------------------------------------------------- env/settings

#[tauri::command]
pub fn get_environment(state: State<'_, Arc<AppState>>) -> EnvView {
    let env = state.port_env();
    EnvView {
        manifest_path: config::manifest_path().to_string_lossy().to_string(),
        data_dir: config::data_dir().to_string_lossy().to_string(),
        dynamic_start: env.dynamic_start,
        dynamic_count: env.dynamic_count,
        excluded: env.excluded,
    }
}

#[tauri::command]
pub fn get_settings(state: State<'_, Arc<AppState>>) -> Settings {
    state.manifest.lock().settings.clone()
}

#[tauri::command]
pub fn save_settings(state: State<'_, Arc<AppState>>, settings: Settings) -> Result<Settings, String> {
    {
        let mut manifest = state.manifest.lock();
        manifest.settings = settings.clone();
    }
    save_manifest(&state)?;
    Ok(settings)
}

#[tauri::command]
pub fn import_preset(state: State<'_, Arc<AppState>>) -> Result<Vec<ServiceView>, String> {
    let raw = include_str!("../../presets/workspace-gm10.json");
    let preset: Manifest = serde_json::from_str(raw).map_err(|e| format!("预置清单解析失败: {e}"))?;
    {
        let mut manifest = state.manifest.lock();
        for def in preset.services {
            let def = normalize_def(def);
            if !manifest.services.iter().any(|s| s.id == def.id) {
                manifest.services.push(def);
            }
        }
    }
    save_manifest(&state)?;
    Ok(state.views())
}

#[tauri::command]
pub fn notice(app: AppHandle, level: String, code: String, detail: String) {
    let _ = app.emit(
        "notice",
        serde_json::json!({ "level": level, "code": code, "detail": detail }),
    );
}

pub fn initial_statuses(state: &AppState) -> Vec<ServiceStatus> {
    state.machines.lock().values().map(|machine| machine.status()).collect()
}

pub fn is_crashed(status: &ServiceStatus) -> bool {
    status.state == ServiceState::Crashed
}
