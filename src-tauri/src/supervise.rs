//! 服务进程的启动 / 停止 / 认领（应用重启后仍认出自己拉起过的进程）。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::config::{self, Manifest, ServiceDef};
use crate::logs::LogStore;
use crate::proc;
use crate::{health, ports};

/// 不弹控制台窗口（GUI 程序拉起命令行子进程时必须）。
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const GRACE_MS: u64 = 3000;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RuntimeEntry {
    pub pid: u32,
    pub creation_time: u64,
    pub started_at: u64,
}

#[derive(Default, Serialize, Deserialize)]
pub struct RuntimeLedger {
    #[serde(default)]
    pub entries: HashMap<String, RuntimeEntry>,
}

pub struct ServiceManager {
    logs: LogStore,
    children: HashMap<String, Child>,
    pids: HashMap<String, u32>,
    ledger: RuntimeLedger,
}

impl ServiceManager {
    pub fn new(logs: LogStore) -> Self {
        Self { logs, children: HashMap::new(), pids: HashMap::new(), ledger: config::load_runtime() }
    }

    /// 认领上一进程实例（或本次运行时台账记录）里由本工具拉起、且仍在监听自己端口的进程。
    pub fn adopt(&mut self, manifest: &Manifest) {
        for def in &manifest.services {
            let Some(entry) = self.ledger.entries.get(&def.id).cloned() else { continue };
            let same_process = proc::creation_time(entry.pid).map(|c| c == entry.creation_time).unwrap_or(false);
            // 端口可能由孙进程持有（cmd /C 的直接子进程又拉起了真正监听的那个）。
            let owns_port = ports::owner_pid(def.port)
                .map(|owner| owner == entry.pid || proc::is_descendant(owner, entry.pid))
                .unwrap_or(false);
            if same_process && owns_port {
                self.pids.insert(def.id.clone(), entry.pid);
            } else {
                self.ledger.entries.remove(&def.id);
            }
        }
        self.persist();
    }

    pub fn pid_of(&self, id: &str) -> Option<u32> {
        self.pids.get(id).copied()
    }

    pub fn alive(&self, id: &str) -> bool {
        self.pids.get(id).map(|pid| proc::is_alive(*pid)).unwrap_or(false)
    }

    pub fn is_running(&self, id: &str) -> bool {
        self.children.contains_key(id) || self.alive(id)
    }

    pub fn start(&mut self, def: &ServiceDef) -> Result<u32, String> {
        let command = def
            .command
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .ok_or_else(|| format!("服务 {} 未配置启动命令（仅监控）", def.name))?;

        if self.is_running(&def.id) {
            return Err(format!("服务 {} 已在运行", def.name));
        }
        if ports::is_listening(def.port) {
            return Err(format!("端口 {} 已被占用，请先停止占用者", def.port));
        }

        let mut cmd = Command::new("cmd");
        // raw_arg：把用户命令原样接到 `cmd /C ` 后面。
        // 不能用 arg()——它会按 C 运行时的规则给内嵌引号加反斜杠（\"），
        // 而 cmd.exe 不认这种转义，形如 `node -e "..."` 的命令会被拆坏。
        cmd.arg("/C").raw_arg(command);
        if let Some(cwd) = def.cwd.as_deref() {
            if !cwd.trim().is_empty() {
                cmd.current_dir(cwd);
            }
        }
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW);

        let mut child = cmd.spawn().map_err(|e| format!("启动失败: {e}"))?;
        let pid = child.id();

        if let Some(stdout) = child.stdout.take() {
            spawn_reader(stdout, self.logs.clone(), def.id.clone(), false);
        }
        if let Some(stderr) = child.stderr.take() {
            spawn_reader(stderr, self.logs.clone(), def.id.clone(), true);
        }

        self.logs.push(&def.id, &format!("[portlens] started pid={pid} :: {command}"));
        self.children.insert(def.id.clone(), child);
        self.pids.insert(def.id.clone(), pid);
        self.ledger.entries.insert(
            def.id.clone(),
            RuntimeEntry { pid, creation_time: proc::creation_time(pid).unwrap_or(0), started_at: health::now_ms() },
        );
        self.persist();
        Ok(pid)
    }

    /// 停止服务：先不带 /F（有机会自行退出），超过 grace 再强杀整棵进程树，最后校验端口释放。
    pub fn stop(&mut self, def: &ServiceDef, force: bool) -> Result<(), String> {
        let pid = self.pids.get(&def.id).copied().or_else(|| ports::owner_pid(def.port));

        if let Some(target) = pid {
            if proc::is_alive(target) {
                if force {
                    proc::kill_tree(target, true)?;
                    std::thread::sleep(Duration::from_millis(200));
                } else {
                    // 先试优雅停止（taskkill /T，不带 /F）。控制台程序不响应 WM_CLOSE，
                    // 这时 taskkill 会直接报错——不必白等 grace，立刻转强杀。
                    let graceful = proc::kill_tree(target, false);
                    if graceful.is_ok() {
                        let deadline = Instant::now() + Duration::from_millis(GRACE_MS);
                        while Instant::now() < deadline {
                            if !proc::is_alive(target) && !ports::is_listening(def.port) {
                                break;
                            }
                            std::thread::sleep(Duration::from_millis(100));
                        }
                    }
                    if proc::is_alive(target) || ports::is_listening(def.port) {
                        proc::kill_tree(target, true)?;
                        std::thread::sleep(Duration::from_millis(200));
                    }
                }
            }
        }

        self.forget(&def.id);
        self.logs.push(&def.id, "[portlens] stopped");

        if ports::is_listening(def.port) {
            return Err(format!("端口 {} 仍被占用（可能是残留子进程），请用强制停止", def.port));
        }
        Ok(())
    }

    pub fn stop_all(&mut self, manifest: &Manifest, force: bool) {
        for def in manifest.services.iter().filter(|s| s.command.is_some()) {
            let _ = self.stop(def, force);
        }
    }

    /// 拉取已退出进程的退出码；返回 Some 表示本次观察到退出。
    pub fn poll_exit(&mut self, id: &str) -> Option<i32> {
        let code = {
            let child = self.children.get_mut(id)?;
            match child.try_wait() {
                Ok(Some(status)) => Some(status.code().unwrap_or(-1)),
                Ok(None) => None,
                Err(_) => Some(-1),
            }
        };
        if let Some(code) = code {
            self.children.remove(id);
            self.pids.remove(id);
            self.ledger.entries.remove(id);
            self.persist();
            self.logs.push(id, &format!("[portlens] exited with code {code}"));
        }
        code
    }

    pub fn persist(&self) {
        let mut ledger = RuntimeLedger::default();
        for (id, entry) in &self.ledger.entries {
            if proc::is_alive(entry.pid) {
                ledger.entries.insert(id.clone(), entry.clone());
            }
        }
        config::save_runtime(&ledger);
    }

    fn forget(&mut self, id: &str) {
        self.children.remove(id);
        self.pids.remove(id);
        self.ledger.entries.remove(id);
        self.persist();
    }
}

fn spawn_reader<R: Read + Send + 'static>(reader: R, logs: LogStore, id: String, is_stderr: bool) {
    std::thread::spawn(move || {
        let mut buf = BufReader::new(reader);
        let mut line = String::new();
        loop {
            line.clear();
            match buf.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let text = line.trim_end_matches(['\r', '\n']);
                    if is_stderr {
                        logs.push(&id, &format!("[err] {text}"));
                    } else {
                        logs.push(&id, text);
                    }
                }
            }
        }
    });
}
