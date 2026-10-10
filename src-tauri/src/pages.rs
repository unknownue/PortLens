//! 应用内页面标签：每个标签一个真实子 WebView（`Window::add_child`），
//! 前台标签显示、其余隐藏。前端只发逻辑像素矩形，这里换算成物理像素。

use serde::{Deserialize, Serialize};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};

pub const MAIN_WINDOW: &str = "main";

/// 建视图时用的占位地址（拦截器注册完立刻导航到真实地址）。
const BLANK_URL: &str = "about:blank";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PageTab {
    pub label: String,
    pub title: String,
    pub url: String,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, Default)]
pub struct WindowRect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct UiState {
    #[serde(default)]
    pub tabs: Vec<PageTab>,
    #[serde(default)]
    pub active: Option<String>,
    #[serde(default)]
    pub window: Option<WindowRect>,
}

pub fn load_ui() -> UiState {
    let path = crate::config::ui_state_path();
    if !path.exists() {
        return UiState::default();
    }
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save_ui(state: &UiState) {
    let path = crate::config::ui_state_path();
    let Ok(text) = serde_json::to_string_pretty(state) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, text).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// 生成未被占用的标签名：page-1、page-2 …
pub fn next_label(existing: &[String]) -> String {
    let mut index = 1;
    loop {
        let label = format!("page-{index}");
        if !existing.iter().any(|item| item == &label) {
            return label;
        }
        index += 1;
    }
}

/// 建一个页面标签要用的东西：目标地址 + 要注入的请求头（已解析）。
#[derive(Clone, Debug, Default)]
pub struct PageTarget {
    pub url: String,
    pub headers: Vec<(String, String)>,
}

/// 先用 `about:blank` 建视图，装好请求头拦截器再导航到目标地址。
///
/// 顺序是硬要求：拦截器必须在首个请求发出前注册，而 `WebviewBuilder` 没有「创建后、导航前」的回调，
/// 所以用一个空白页兜住这段窗口期（`page-load` 事件会过滤掉 `about:blank`，界面看不到这一跳）。
pub fn open(app: &AppHandle, label: &str, target: &PageTarget, rect: WindowRect) -> Result<(), String> {
    let window = app.get_window(MAIN_WINDOW).ok_or_else(|| "未找到主窗口".to_string())?;
    let destination = tauri::Url::parse(&target.url).map_err(|e| format!("URL 无效 {}: {e}", target.url))?;
    let blank = tauri::Url::parse(BLANK_URL).map_err(|e| e.to_string())?;

    let handle = app.clone();
    let label_owned = label.to_string();
    let builder = WebviewBuilder::new(label, WebviewUrl::External(blank)).on_page_load(move |_webview, payload| {
        let url = payload.url().to_string();
        if url == BLANK_URL {
            return;
        }
        let phase = match payload.event() {
            PageLoadEvent::Started => "started",
            PageLoadEvent::Finished => "finished",
        };
        let _ = handle.emit("page-load", serde_json::json!({ "label": label_owned, "url": url, "phase": phase }));
    });

    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(rect.x as f64, rect.y as f64),
            LogicalSize::new(rect.w.max(1) as f64, rect.h.max(1) as f64),
        )
        .map_err(|e| format!("创建页面视图失败: {e}"))?;

    // 拦截器先装好（同步等待主线程完成注册），再导航。
    crate::inject::install(app, label, &webview, &target.url, target.headers.clone())?;
    webview
        .navigate(destination)
        .map_err(|e| format!("导航到 {} 失败: {e}", target.url))?;
    Ok(())
}

pub fn set_bounds(app: &AppHandle, label: &str, rect: WindowRect) -> Result<(), String> {
    let webview = app.get_webview(label).ok_or_else(|| format!("页面不存在: {label}"))?;
    webview
        .set_position(LogicalPosition::new(rect.x as f64, rect.y as f64))
        .map_err(|e| e.to_string())?;
    webview
        .set_size(LogicalSize::new(rect.w.max(1) as f64, rect.h.max(1) as f64))
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn set_visible(app: &AppHandle, label: &str, visible: bool) -> Result<(), String> {
    let webview = app.get_webview(label).ok_or_else(|| format!("页面不存在: {label}"))?;
    let result = if visible { webview.show() } else { webview.hide() };
    result.map_err(|e| e.to_string())
}

pub fn navigate(app: &AppHandle, label: &str, url: &str) -> Result<(), String> {
    let webview = app.get_webview(label).ok_or_else(|| format!("页面不存在: {label}"))?;
    let parsed = tauri::Url::parse(url).map_err(|e| format!("URL 无效 {url}: {e}"))?;
    webview.navigate(parsed).map_err(|e| e.to_string())
}

pub fn reload(app: &AppHandle, label: &str) -> Result<(), String> {
    let webview = app.get_webview(label).ok_or_else(|| format!("页面不存在: {label}"))?;
    webview.reload().map_err(|e| e.to_string())
}

pub fn close(app: &AppHandle, label: &str) -> Result<(), String> {
    let webview = app.get_webview(label).ok_or_else(|| format!("页面不存在: {label}"))?;
    webview.close().map_err(|e| e.to_string())
}

pub fn hide_all(app: &AppHandle) {
    for (label, webview) in app.webviews() {
        if label.starts_with("page-") {
            let _ = webview.hide();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_label_skips_used() {
        let existing = vec!["page-1".to_string(), "page-2".to_string()];
        assert_eq!(next_label(&existing), "page-3");
        assert_eq!(next_label(&[]), "page-1");
    }

    #[test]
    fn ui_state_defaults_on_bad_json() {
        let state: UiState = serde_json::from_str("{}").unwrap();
        assert!(state.tabs.is_empty());
        assert!(state.active.is_none());
    }
}
