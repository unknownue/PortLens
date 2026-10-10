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
