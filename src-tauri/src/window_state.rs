//! 窗口尺寸/位置记忆（写在 ui.json，和标签状态同一个文件）。

use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WindowEvent};

use crate::pages::{self, WindowRect};

pub fn install(app: &AppHandle) {
    let Some(window) = app.get_window(pages::MAIN_WINDOW) else { return };

    let saved = pages::load_ui().window;
    if let Some(rect) = saved {
        if rect.w > 200 && rect.h > 200 {
            let _ = window.set_size(PhysicalSize::new(rect.w, rect.h));
            let _ = window.set_position(PhysicalPosition::new(rect.x, rect.y));
        }
    }

    let handle = app.clone();
    let last_save = Arc::new(Mutex::new(Instant::now() - Duration::from_secs(10)));
    window.on_window_event(move |event| match event {
        WindowEvent::Resized(_) | WindowEvent::Moved(_) => {
            let mut guard = last_save.lock();
            if guard.elapsed() < Duration::from_millis(500) {
                return;
            }
            *guard = Instant::now();
            drop(guard);
            save_bounds(&handle);
        }
        WindowEvent::CloseRequested { .. } => save_bounds(&handle),
        _ => {}
    });
}

fn save_bounds(app: &AppHandle) {
    let Some(window) = app.get_window(pages::MAIN_WINDOW) else { return };
    let (Ok(size), Ok(position)) = (window.outer_size(), window.outer_position()) else { return };
    let mut ui = pages::load_ui();
    ui.window = Some(WindowRect { x: position.x, y: position.y, w: size.width, h: size.height });
    pages::save_ui(&ui);
}
