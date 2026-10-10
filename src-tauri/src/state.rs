//! 接线层：应用状态 + 全部 Tauri 命令。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::config::{self, HealthConfig, LogSource, Manifest, ServiceDef, Settings};
use crate::health::{HealthMachine, ServiceStatus, State as ServiceState, Tick};
use crate::logs::LogStore;
use crate::pages::{self, LogTab, PageTab, PageTarget, UiState, WindowRect};
use crate::supervise::ServiceManager;
use crate::tail::TailRegistry;
use crate::{netsh, ports, probe, proc, secrets};

pub struct AppState {
    pub manifest: Mutex<Manifest>,
    pub services: Mutex<ServiceManager>,
    pub logs: LogStore,
    pub machines: Mutex<HashMap<String, HealthMachine>>,
    pub ui: Mutex<UiState>,
    pub probe_schedule: Mutex<HashMap<String, u64>>,
    /// 文件日志跟随器（外部服务与自建服务共用）。
    pub tails: Mutex<TailRegistry>,
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
    pub log_source: LogSource,
    pub status: ServiceStatus,
    pub risky: bool,
    pub page: PageView,
}

/// 请求头的展示形式：只有名字 + 掩码，明文永远不走这里。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderView {
    pub name: String,
    pub masked: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageView {
    /// 生效地址：`page.url`，否则 `http://127.0.0.1:<port>/`。
    pub url: String,
    pub title: String,
    pub headers: Vec<HeaderView>,
    /// 目标不是回环地址：界面要提示「会把配置的请求头发给该主机」。
    pub external_host: bool,
}

/// 编辑对话框回填用的明文视图（只由 `get_page_config` 返回）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageConfigView {
    pub url: String,
    pub title: String,
    pub headers: Vec<HeaderViewRaw>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderViewRaw {
    pub name: String,
    pub value: String,
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
            tails: Mutex::new(TailRegistry::new()),
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
                    log_source: def.log_source.clone(),
                    status,
                    risky: netsh::is_risky(def.port, &env),
                    page: page_view(&def),
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

    /// 某条 URL 是否命中某个服务的 `page.url`；命中就返回该服务的请求头（解析后的）。
    ///
    /// 用于「恢复上次会话的标签」：`ui.json` 里只有 URL，请求头必须从当前清单现取。
    /// 解析失败不报错（恢复标签不该被一个坏引用卡住），只留一行日志。
    fn headers_for_url(&self, url: &str) -> Vec<(String, String)> {
        let target = url.trim().trim_end_matches('/').to_string();
        let def = self
            .manifest
            .lock()
            .services
            .iter()
            .find(|def| def.page_url().trim_end_matches('/') == target)
            .cloned();
        let Some(def) = def else { return Vec::new() };
        match resolve_page_headers(&def) {
            Ok(headers) => headers,
            Err(err) => {
                eprintln!("[portlens] 标签 {url} 的请求头解析失败: {err}");
                Vec::new()
            }
        }
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

    /// 按当前清单同步文件日志跟随器并读一次增量；返回新增行数。
    /// 与进程输出共用 `LogStore`，monitor 之后统一按 `service-log` 事件发出去。
    pub fn poll_file_logs(&self) -> usize {
        let defs = self.manifest.lock().services.clone();
        let mut tails = self.tails.lock();
        tails.sync(&defs);
        tails.poll_all(&self.logs)
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

fn page_view(def: &ServiceDef) -> PageView {
    let url = def.page_url();
    let headers = def
        .page
        .as_ref()
        .map(|page| {
            page.headers
                .iter()
                .map(|(name, value)| HeaderView { name: name.clone(), masked: config::mask(value) })
                .collect()
        })
        .unwrap_or_default();
    PageView {
        url: url.clone(),
        title: def.page_title(),
        headers,
        external_host: !config::is_loopback_host(&url),
    }
}

/// 把 `page.headers` 里的引用（`${env:...}` / `${file:...:...}`）解析成实际值。
fn resolve_page_headers(def: &ServiceDef) -> Result<Vec<(String, String)>, String> {
    let Some(page) = def.page.as_ref() else { return Ok(Vec::new()) };
    let mut out = Vec::with_capacity(page.headers.len());
    for (name, raw) in &page.headers {
        let value = secrets::resolve(raw).map_err(|err| format!("服务 {} 的请求头 {name} 解析失败：{err}", def.id))?;
        if value.is_empty() {
            continue;
        }
        out.push((name.clone(), value));
    }
    Ok(out)
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
    def.log_source.kind = def.log_source.kind.trim().to_ascii_lowercase();
    if def.log_source.kind.is_empty() {
        def.log_source.kind = "process".into();
    }
    def.log_source.path = def
        .log_source
        .path
        .take()
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty());
    def.log_source.encoding = def
        .log_source
        .encoding
        .take()
        .map(|encoding| encoding.trim().to_ascii_lowercase())
        .filter(|encoding| !encoding.is_empty());
    if def.log_source.kind == "file" && def.log_source.encoding.is_none() {
        def.log_source.encoding = Some("utf-8".into());
    }
    if let Some(page) = def.page.as_mut() {
        page.url = page.url.take().map(|url| url.trim().to_string()).filter(|url| !url.is_empty());
        page.title = page.title.take().map(|title| title.trim().to_string()).filter(|title| !title.is_empty());
        page.headers = page
            .headers
            .iter()
            .map(|(name, value)| (name.trim().to_string(), value.clone()))
            .filter(|(name, _)| !name.is_empty())
            .collect();
    }
    if def
        .page
        .as_ref()
        .map(|page| page.url.is_none() && page.headers.is_empty() && page.title.is_none())
        .unwrap_or(false)
    {
        def.page = None;
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

/// 日志标签列表（日志视图是纯前端的，这里只存标签身份；读后**不清空**）。
#[tauri::command]
pub fn list_log_tabs(state: State<'_, Arc<AppState>>) -> Vec<LogTab> {
    state.ui.lock().log_tabs.clone()
}

/// 前端在新建/关闭/改名日志标签后回写。
#[tauri::command]
pub fn save_log_tabs(state: State<'_, Arc<AppState>>, tabs: Vec<LogTab>) -> Result<(), String> {
    let mut ui = state.ui.lock();
    ui.log_tabs = tabs
        .into_iter()
        .map(|tab| LogTab {
            id: tab.id.trim().to_string(),
            service_id: tab.service_id.trim().to_string(),
            title: tab.title.trim().to_string(),
        })
        .filter(|tab| !tab.id.is_empty() && !tab.service_id.is_empty())
        .collect();
    pages::save_ui(&ui);
    Ok(())
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
    // 任意 URL 的标签：如果这个地址正好是某个服务配的 page.url，就按那个服务注入请求头
    // （恢复上次会话的标签走的就是这条路：ui.json 只存 url，请求头从清单现取）。
    let headers = state.headers_for_url(&url);
    let target = PageTarget { url: url.clone(), headers };
    open_tab(&app, &state, target, title, WindowRect { x, y, w, h }).await
}

/// 按服务的 `page` 配置开标签：地址、标题、注入的请求头都从清单现取。
#[tauri::command]
pub async fn open_service_page(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    id: String,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
) -> Result<PageTab, String> {
    let def = state.def_of(&id)?;
    let headers = resolve_page_headers(&def)?;
    let target = PageTarget { url: def.page_url(), headers };
    open_tab(&app, &state, target, def.page_title(), WindowRect { x, y, w, h }).await
}

/// 编辑对话框回填：返回**明文**（只有这一条命令与 `reveal_page_header` 会给出明文）。
#[tauri::command]
pub fn get_page_config(state: State<'_, Arc<AppState>>, id: String) -> Result<PageConfigView, String> {
    let def = state.def_of(&id)?;
    Ok(PageConfigView {
        url: def.page.as_ref().and_then(|p| p.url.clone()).unwrap_or_default(),
        title: def.page.as_ref().and_then(|p| p.title.clone()).unwrap_or_default(),
        headers: def
            .page
            .as_ref()
            .map(|page| {
                page.headers
                    .iter()
                    .map(|(name, value)| HeaderViewRaw { name: name.clone(), value: value.clone() })
                    .collect()
            })
            .unwrap_or_default(),
    })
}

/// 单个请求头的明文（解析 `${env:...}` / `${file:...:...}` 之后的实际值），供「显示/复制」使用。
#[tauri::command]
pub fn reveal_page_header(state: State<'_, Arc<AppState>>, id: String, name: String) -> Result<String, String> {
    let def = state.def_of(&id)?;
    let raw = def
        .page
        .as_ref()
        .and_then(|page| page.headers.get(&name))
        .ok_or_else(|| format!("服务 {} 没有请求头 {name}", def.id))?;
    secrets::resolve(raw)
}

async fn open_tab(
    app: &AppHandle,
    state: &State<'_, Arc<AppState>>,
    target: PageTarget,
    title: String,
    rect: WindowRect,
) -> Result<PageTab, String> {
    let mut ui = state.ui.lock();
    let labels: Vec<String> = ui.tabs.iter().map(|tab| tab.label.clone()).collect();
    let label = pages::next_label(&labels);
    pages::open(app, &label, &target, rect)?;
    for tab in ui.tabs.iter() {
        let _ = pages::set_visible(app, &tab.label, false);
    }
    // ui.json 只存 label/title/url：请求头永远不落盘（启动恢复时从清单现取）。
    let tab = PageTab { label: label.clone(), title, url: target.url.clone() };
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
