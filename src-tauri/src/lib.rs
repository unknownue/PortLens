//! Tauri 后端入口：注册命令、启动轮询线程。

// 模块公开：集成测试（tests/）直接用这些类型，不经过 Tauri 命令层。
pub mod config;
pub mod health;
pub mod inject;
pub mod logs;
pub mod monitor;
pub mod netsh;
pub mod pages;
pub mod ports;
pub mod probe;
pub mod proc;
pub mod secrets;
pub mod state;
pub mod supervise;
pub mod tail;
pub mod window_state;

use std::sync::Arc;

use tauri::Manager;

use state::AppState;

/// 同一会话只允许一个实例：第二个实例直接退出（第一个实例可能正在托管服务进程）。
fn already_running() -> bool {
    use windows::core::w;
    use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows::Win32::System::Threading::CreateMutexW;

    unsafe {
        let _ = CreateMutexW(None, true, w!("Local\\PortLens.SingleInstance"));
        GetLastError() == ERROR_ALREADY_EXISTS
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if already_running() {
        eprintln!("[portlens] 已有实例在运行，本次启动退出。");
        std::process::exit(2);
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(AppState::new()))
        .setup(|app| {
            let handle = app.handle().clone();
            window_state::install(&handle);
            let state = app.state::<Arc<AppState>>().inner().clone();
            monitor::spawn(handle, state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            state::get_services,
            state::add_service,
            state::update_service,
            state::remove_service,
            state::start_service,
            state::stop_service,
            state::restart_service,
            state::stop_all_services,
            state::probe_now,
            state::get_service_logs,
            state::clear_service_logs,
            state::list_listeners,
            state::stop_pid,
            state::get_environment,
            state::get_settings,
            state::save_settings,
            state::import_preset,
            state::list_pages,
            state::take_saved_pages,
            state::open_page,
            state::open_service_page,
            state::get_page_config,
            state::reveal_page_header,
            state::close_page,
            state::activate_page,
            state::set_page_bounds,
            state::navigate_page,
            state::reload_page,
            state::rename_page,
            state::notice,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            let state = app_handle.state::<Arc<AppState>>();
            let manifest = state.manifest.lock().clone();
            if manifest.settings.stop_managed_on_exit {
                state.services.lock().stop_all(&manifest, true);
            } else {
                state.services.lock().persist();
            }
        }
    });
}
