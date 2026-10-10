# 页面标签（应用内多标签浏览）

PortLens 的「页面标签」用来在同一个窗口里打开被监控服务的页面（如 `http://127.0.0.1:15080`），开多个、来回切、关掉，不改外面浏览器。

## 机制

**每个标签一个真实子 WebView**，不是 iframe：

- 主窗口（label `main`）渲染整个界面：标题栏、工具栏、标签条、仪表盘。
- 页面标签各自是一个子 WebView（label `page-1`、`page-2`…），由 Rust 侧 `Window::add_child(WebviewBuilder::new(label, WebviewUrl::External(url)))` 创建。
- 切标签 = 后端的 `show()` / `hide()`；回到仪表盘 = 隐藏全部页面视图（`activate_page(null)`）。
- 为什么不用 iframe：目标页的 `X-Frame-Options` / CSP `frame-ancestors` 会直接拒载，而且拿不到完整的浏览器行为。

## 坐标同步

子 WebView 是原生子窗口，位置尺寸由 Rust 侧设置，前端只负责算矩形：

1. 内容容器 `getBoundingClientRect()` 得到逻辑像素 `x/y/w/h`（含标题栏、工具栏、标签条的高度偏移）。
2. 切标签、窗口 resize、`ResizeObserver` 触发时调 `set_page_bounds(label, x, y, w, h)`。
3. Rust 侧用 `LogicalPosition` / `LogicalSize`，由 Tauri 按窗口缩放比换算成物理像素 —— 高 DPI 下不用前端操心。

仪表盘渲染时容器里没有子 WebView，所以**必须先 `activate_page(null)`** 再画表格，否则子窗口会盖在表格上。

## 隔离与安全

- `capabilities/default.json` 只授权 `windows: ["main"]`；页面标签的 label 是 `page-*`，**不匹配任何 capability**，因此被加载的页面拿不到任何 IPC 权限（不能调 Tauri 命令）。
- 没有配置 `dangerousRemoteDomainIpcAccess`，`withGlobalTauri` 也是 false。
- 主界面 CSP 收紧到 `default-src 'self'`（`style-src` 放行 `unsafe-inline`，Radix 定位需要内联样式）；子 WebView 用目标页自己的 CSP。

## 请求头注入（鉴权服务）

需要 token 的本地服务不能在标签里裸开。做法：服务声明 `page.url` 与 `page.headers`，PortLens 在加载该页面时注入。

- **拦截点**：WebView2 的 `WebResourceRequested`。过滤器先限定到 `page.url` 的 origin（`scheme://host:port/*`），
  处理函数里再校验一次请求 URL 的 origin，然后 `SetHeader` 把配置的头追加上去 —— 顶层文档、同源子资源、`fetch`/`XHR`、刷新全覆盖；
  跨 origin 的请求（含第三方 CDN、外部跳转）**一个头都不带**。
- **时序**：拦截器必须在首个请求之前注册，而 `WebviewBuilder` 没有「创建后、导航前」的回调。
  所以标签先以 `about:blank` 建视图 → `with_webview` 里同步注册过滤器与处理函数 → 再 `navigate()` 到 `page.url`。
  `about:blank` 的那一跳不会产生 `page-load` 事件，界面看不到闪烁。
- **失败提示**：`ICoreWebView2_2::WebResourceResponseReceived` 只看顶层文档（用 `NavigationStarting` 跟踪的当前地址比对），
  401/403 时发 `page-status` 事件，标签条上给「该页面可能需要请求头」的可点提示。没配 headers 也会提示。
- **凭据**：值支持 `${env:NAME}` / `${file:PATH:KEY}`，清单里不落明文；列表只显示 `••••••`，
  明文只在编辑对话框回填与「显示/复制」时按需取；`ui.json` 不写 headers，重启恢复标签时从清单现取（按 `page.url` 匹配服务）。
- **受保护头**：`Host`、`Content-Length`、`Connection`、`Transfer-Encoding` 等由 HTTP 栈自己管理的头会被拒绝保存，头名/值含控制字符（换行注入）同样拒绝。
- **不做的事**：不注入 Cookie、不代填表单、不信任自签证书、不给页面标签任何 IPC 权限。

实测（`tools/e2e-headers.mjs`，25 项）：同源 `<script>`/`fetch`/`XHR` 都带上头，跨 origin 请求 0 泄漏，
无头配置时 403 触发提示，`ui.json` / `list_pages` / `get_services` 中检索不到明文；
真实服务验收见 `tmp/acceptance-stzbmcp.mjs`（stzbmcp 宿主服务 `/status` 从 403 变成完整 JSON）。

## 持久化与恢复

`%LOCALAPPDATA%\PortLens\ui.json`：

```json
{
  "tabs": [{ "label": "page-1", "title": "dsh web", "url": "http://127.0.0.1:15080/" }],
  "active": "page-1",
  "window": { "x": 120, "y": 80, "w": 1280, "h": 800 }
}
```

启动时前端调 `take_saved_pages()`（读后清空），对每个标签重新 `open_page`（此时才知道真实容器矩形），最后按 `active` 激活；未保存 active 就停在仪表盘。

## 已知限制

- 不抓取网页标题（子 WebView 无法回传 `document.title`）；标签标题默认是服务名或 `host:port`，可双击重命名。
- 页面加载失败由 WebView2 自己的错误页呈现，应用只在标签上显示加载中/完成（`page-load` 事件）。
- 多 WebView 用到 Tauri 的 `unstable` feature，接口封装在 `src-tauri/src/pages.rs` 一处，便于跟随升级。
