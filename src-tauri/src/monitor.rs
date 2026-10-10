//! 轮询线程：状态跃迁事件、日志批量事件、监听表事件。

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use crate::health::State as ServiceState;
use crate::state::AppState;

pub fn spawn(app: AppHandle, state: Arc<AppState>) {
    std::thread::spawn(move || {
        let mut last_listeners = Vec::new();
        let mut ticks: u64 = 0;

        loop {
            let interval = state.manifest.lock().settings.poll_interval_ms.clamp(200, 10_000);
            std::thread::sleep(Duration::from_millis(interval));
            ticks += 1;

            let changed = state.tick();
            if !changed.is_empty() {
                for status in changed.iter().filter(|s| s.state == ServiceState::Crashed) {
                    let _ = app.emit(
                        "notice",
                        serde_json::json!({
                            "level": "error",
                            "code": "crashed",
                            "detail": format!("{} 已退出（代码 {}）", status.id, status.exit_code.unwrap_or(-1)),
                        }),
                    );
                }
                let _ = app.emit("port-status", changed);
            }

            let ids: Vec<String> = state.manifest.lock().services.iter().map(|def| def.id.clone()).collect();
            for id in ids {
                let lines = state.logs.drain_new(&id);
                if !lines.is_empty() {
                    let _ = app.emit("service-log", serde_json::json!({ "id": id, "lines": lines }));
                }
            }

            // 监听表每两拍发一次，避免无谓的前端刷新。
            if ticks % 2 == 0 {
                let listeners = state.listener_views();
                if listeners != last_listeners {
                    last_listeners = listeners.clone();
                    let _ = app.emit("listener-status", listeners);
                }
            }
        }
    });
}
