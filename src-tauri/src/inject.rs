//! 页面标签的请求头注入（WebView2 `WebResourceRequested` / `WebResourceResponseReceived`）。
//!
//! 只对目标 origin 生效：注册过滤器时就把 URI 限定到 `scheme://host:port`，处理函数里再校验一次，
//! 所以跨 origin 的跳转、第三方 CDN 的子资源都不会带上 `page.headers`。
//!
//! 时序：拦截器必须在首个请求发出前注册。`pages.rs` 因此先用 `about:blank` 建视图，
//! 注册完成后再 `navigate()` 到目标地址（注册是同步的，`with_webview` 返回即已生效）。

use std::sync::Arc;

use parking_lot::Mutex;
use tauri::webview::PlatformWebview;
use tauri::{AppHandle, Emitter};

/// `scheme://host:port`（端口缺省时补协议默认端口），非 http(s) 返回 None。
pub fn origin_of(url: &str) -> Option<String> {
    let parsed = tauri::Url::parse(url).ok()?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return None,
    }
    let host = parsed.host_str()?;
    match parsed.port_or_known_default() {
        Some(port) => Some(format!("{}://{}:{}", parsed.scheme(), host, port)),
        None => Some(format!("{}://{}", parsed.scheme(), host)),
    }
}

/// 请求 URL 是否属于该 origin。
pub fn same_origin(url: &str, origin: &str) -> bool {
    origin_of(url).as_deref() == Some(origin)
}

/// 给一个页面标签装拦截器：`headers` 追加到目标 origin 的每个请求上；
/// 目标文档返回 401/403 时发 `page-status` 事件。
pub fn install(
    app: &AppHandle,
    label: &str,
    webview: &tauri::Webview,
    url: &str,
    headers: Vec<(String, String)>,
) -> Result<(), String> {
    let Some(origin) = origin_of(url) else {
        // 非 http(s) 页面（about:blank、data: 等）没有请求头可言。
        return Ok(());
    };

    let handle = app.clone();
    let tab = label.to_string();
    let document = url.to_string();
    webview
        .with_webview(move |platform: PlatformWebview| {
            if let Err(err) = register(platform, handle.clone(), tab.clone(), origin, headers, document) {
                // 注册失败不能静默：页面会以「没有注入」的形态出现，用户需要知道。
                eprintln!("[portlens] 页面 {tab} 的请求头拦截注册失败: {err}");
                let _ = handle.emit(
                    "notice",
                    serde_json::json!({
                        "level": "warn",
                        "code": "inject_failed",
                        "detail": format!("页面 {tab} 的请求头拦截注册失败：{err}"),
                    }),
                );
            }
        })
        .map_err(|e| format!("注册请求头拦截失败: {e}"))
}

#[cfg(windows)]
fn register(
    platform: PlatformWebview,
    app: AppHandle,
    label: String,
    origin: String,
    headers: Vec<(String, String)>,
    document_url: String,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2NavigationStartingEventArgs, ICoreWebView2WebResourceRequestedEventArgs,
        ICoreWebView2WebResourceResponseReceivedEventArgs, ICoreWebView2_2,
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
    };
    use webview2_com::{
        take_pwstr, EventClosure, NavigationStartingEventHandler, WebResourceRequestedEventHandler,
        WebResourceResponseReceivedEventHandler,
    };
    use windows_core::{HSTRING, PWSTR, Interface as _};

    let controller = platform.controller();
    let core = unsafe { controller.CoreWebView2() }.map_err(|e| format!("取 CoreWebView2 失败: {e}"))?;

    // 1) 只拦截目标 origin 的请求（子资源也在内，context 用 ALL）。
    let pattern = HSTRING::from(format!("{origin}/*"));
    unsafe { core.AddWebResourceRequestedFilter(&pattern, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL) }
        .map_err(|e| format!("AddWebResourceRequestedFilter 失败: {e}"))?;

    // 2) 请求头注入。
    let filter_origin = origin.clone();
    let inject: EventClosure<Option<ICoreWebView2>, Option<ICoreWebView2WebResourceRequestedEventArgs>> =
        Box::new(move |_sender, args| {
            unsafe {
                let Some(args) = args else { return Ok(()) };
                let Ok(request) = args.Request() else { return Ok(()) };
                let mut raw = PWSTR::null();
                let uri = if request.Uri(&mut raw).is_ok() { take_pwstr(raw) } else { String::new() };
                // 过滤器之外再校验一次：跨 origin 的请求一个头都不带。
                if same_origin(&uri, &filter_origin) {
                    if let Ok(request_headers) = request.Headers() {
                        for (name, value) in &headers {
                            let name = HSTRING::from(name.as_str());
                            let value = HSTRING::from(value.as_str());
                            let _ = request_headers.SetHeader(&name, &value);
                        }
                    }
                }
            }
            Ok(())
        });
    let request_handler = WebResourceRequestedEventHandler::create(inject);
    let mut token = 0i64;
    unsafe { core.add_WebResourceRequested(&request_handler, &mut token) }
        .map_err(|e| format!("add_WebResourceRequested 失败: {e}"))?;

    // 3) 跟踪当前文档地址，用于把 401/403 限定在顶层文档上（重定向会更新它）。
    let document = Arc::new(Mutex::new(document_url));
    let nav_document = document.clone();
    let track: EventClosure<Option<ICoreWebView2>, Option<ICoreWebView2NavigationStartingEventArgs>> =
        Box::new(move |_sender, args| {
            unsafe {
                let Some(args) = args else { return Ok(()) };
                let mut raw = PWSTR::null();
                if args.Uri(&mut raw).is_ok() {
                    let uri = take_pwstr(raw);
                    if !uri.is_empty() {
                        *nav_document.lock() = uri;
                    }
                }
            }
            Ok(())
        });
    let nav_handler = NavigationStartingEventHandler::create(track);
    let mut nav_token = 0i64;
    unsafe { core.add_NavigationStarting(&nav_handler, &mut nav_token) }
        .map_err(|e| format!("add_NavigationStarting 失败: {e}"))?;

    // 4) 顶层文档 401/403 -> 界面提示（同一个地址只提示一次）。
    //    WebResourceResponseReceived 在 ICoreWebView2_2 上，需要先 QueryInterface。
    let core2: ICoreWebView2_2 = core.cast().map_err(|e| format!("取 ICoreWebView2_2 失败: {e}"))?;
    let response_document = document.clone();
    let hint_state = Arc::new(Mutex::new(String::new()));
    let inspect: EventClosure<Option<ICoreWebView2>, Option<ICoreWebView2WebResourceResponseReceivedEventArgs>> =
        Box::new(move |_sender, args| {
            unsafe {
                let Some(args) = args else { return Ok(()) };
                let Ok(request) = args.Request() else { return Ok(()) };
                let mut raw = PWSTR::null();
                let uri = if request.Uri(&mut raw).is_ok() { take_pwstr(raw) } else { return Ok(()) };
                let current = response_document.lock().clone();
                if uri.split('#').next() != current.split('#').next() {
                    return Ok(());
                }
                let Ok(response) = args.Response() else { return Ok(()) };
                let mut status = 0i32;
                if response.StatusCode(&mut status).is_ok() && (status == 401 || status == 403) {
                    let mut last = hint_state.lock();
                    if *last != uri {
                        *last = uri.clone();
                        let _ = app.emit(
                            "page-status",
                            serde_json::json!({ "label": label, "url": uri, "status": status }),
                        );
                    }
                }
            }
            Ok(())
        });
    let response_handler = WebResourceResponseReceivedEventHandler::create(inspect);
    let mut response_token = 0i64;
    unsafe { core2.add_WebResourceResponseReceived(&response_handler, &mut response_token) }
        .map_err(|e| format!("add_WebResourceResponseReceived 失败: {e}"))?;

    Ok(())
}

#[cfg(not(windows))]
fn register(
    _platform: PlatformWebview,
    _app: AppHandle,
    _label: String,
    _origin: String,
    _headers: Vec<(String, String)>,
    _document_url: String,
) -> Result<(), String> {
    Err("请求头注入目前只在 Windows（WebView2）上实现".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_of_normalises_scheme_host_port() {
        assert_eq!(origin_of("http://127.0.0.1:15901/status").as_deref(), Some("http://127.0.0.1:15901"));
        assert_eq!(origin_of("http://127.0.0.1/status").as_deref(), Some("http://127.0.0.1:80"));
        assert_eq!(origin_of("https://example.com/").as_deref(), Some("https://example.com:443"));
        assert_eq!(origin_of("http://localhost:15080").as_deref(), Some("http://localhost:15080"));
        assert!(origin_of("about:blank").is_none());
        assert!(origin_of("file:///C:/x.html").is_none());
        assert!(origin_of("not a url").is_none());
    }

    #[test]
    fn same_origin_is_strict() {
        let origin = "http://127.0.0.1:15901";
        assert!(same_origin("http://127.0.0.1:15901/", origin));
        assert!(same_origin("http://127.0.0.1:15901/api/status?x=1", origin));
        assert!(!same_origin("http://127.0.0.1:15902/", origin));
        assert!(!same_origin("http://localhost:15901/", origin));
        assert!(!same_origin("https://127.0.0.1:15901/", origin));
        assert!(!same_origin("https://cdn.example.com/lib.js", origin));
    }
}
