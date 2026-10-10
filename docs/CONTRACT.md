# PortLens 接口契约（冻结）

所有并行开发都按本文件办事；改动签名 = 改契约，先在本文件登记。

## 1. 目录与所有权

| 路径 | 内容 | 所有者 |
|---|---|---|
| `src-tauri/src/ports.rs` `proc.rs` `netsh.rs` | 系统层（TCP 表、进程、端口段诊断） | backend-system |
| `src-tauri/src/probe.rs` `health.rs` | 探针 + 状态机 | health |
| `src-tauri/src/{config,logs,supervise,pages,state,monitor,window_state,lib}.rs` | 托管/接线层 | lead |
| `src/**` | React + shadcn/ui 前端 | frontend |
| `tools/**` | node --test 校验、CDP E2E、打包冒烟 | lead |

规则：只写自己那几行文件；需要别人文件时改契约或找 lead，不要直接改。

## 2. Rust 模块签名（不许改名字/类型）

### ports.rs
```rust
pub const STATE_LISTEN: u32 = 2;
pub const STATE_ESTABLISHED: u32 = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RawRow { pub local_port: u16, pub remote_port: u16, pub pid: u32, pub state: u32 }

#[derive(Clone, Debug, Serialize)]
pub struct Listener { pub port: u16, pub addr: String, pub pid: u32, pub established: u32 }

pub fn decode_rows(buf: &[u8], v6: bool) -> Vec<RawRow>;   // 头部 4 字节 dwNumEntries；v4 行 24B，v6 行 56B
pub fn list_tcp() -> Vec<Listener>;                         // 只含 LISTEN，established 为同端口 ESTABLISHED 计数
pub fn owner_pid(port: u16) -> Option<u32>;
pub fn is_listening(port: u16) -> bool;
```
实现要点：`GetExtendedTcpTable(AF_INET/AF_INET6, TCP_TABLE_OWNER_PID_ALL)`；端口是 dword 里的网络字节序低 16 位；同端口 IPv4/IPv6 去重；addr 用点分/方括号 v6。

### proc.rs
```rust
#[derive(Clone, Debug, Serialize)]
pub struct ProcInfo { pub pid: u32, pub ppid: u32, pub name: String, pub exe: String, pub creation_time: u64 }

pub fn info(pid: u32) -> Option<ProcInfo>;          // Toolhelp32 快照 + QueryFullProcessImageNameW
pub fn creation_time(pid: u32) -> Option<u64>;      // 用于防 PID 复用
pub fn is_alive(pid: u32) -> bool;
pub fn kill_tree(pid: u32, force: bool) -> Result<(), String>;  // taskkill /PID x /T [/F]，CREATE_NO_WINDOW
```
不读外部进程命令行（PEB 读代价大）；权限不足时 `exe` 返回空串而不是失败。

### netsh.rs
```rust
#[derive(Clone, Debug, Default, Serialize)]
pub struct PortEnv { pub dynamic_start: u16, pub dynamic_count: u32, pub excluded: Vec<(u16, u16)> }

pub fn query() -> PortEnv;                            // netsh 两条命令，缓存 5 分钟，失败返回默认值
pub fn parse_dynamic(text: &str) -> Option<(u16, u32)>;
pub fn parse_excluded(text: &str) -> Vec<(u16, u16)>;
pub fn is_risky(port: u16, env: &PortEnv) -> bool;    // 落在动态段或排除段
```

### probe.rs
```rust
#[derive(Clone, Debug, Serialize)]
pub struct ProbeOutcome { pub ok: bool, pub latency_ms: u64, pub detail: String }

pub fn run(port: u16, h: &HealthConfig) -> ProbeOutcome;
pub fn parse_status_line(line: &str) -> Option<u16>;
```
- `tcp`：`TcpStream::connect_timeout` 到 `127.0.0.1:port`。
- `http`：手写 `GET {path} HTTP/1.1` + `Host` + `Connection: close`，解析状态行；2xx/3xx 视为 ok（不支持 TLS）。
- `exec`：`cmd /C <command>`，退出码 0 为 ok，超时杀进程并返回 ok=false。
- `none`：直接 ok=true，detail 说明未探测。
- 任何情况都不 panic；detail 用简短中文（如 `TCP 连接超时 1000ms`、`HTTP 404`、`exit 1`）。

### health.rs
```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State { Stopped, Starting, Healthy, Degraded, Crashed, Conflict, Unknown }

#[derive(Clone, Debug)]
pub struct Tick { pub listening: bool, pub owner_is_ours: bool, pub managed: bool, pub alive: bool, pub exit_code: Option<i32>, pub probe: Option<ProbeOutcome> }

#[derive(Clone, Debug, Serialize)]
pub struct ServiceStatus { pub id: String, pub state: State, pub detail: String, pub pid: Option<u32>, pub latency_ms: Option<u64>, pub since_ms: u64, pub uptime_ms: u64, pub exit_code: Option<i32>, pub history: Vec<bool> }

pub fn now_ms() -> u64;
pub struct HealthMachine { .. }
impl HealthMachine {
    pub fn new(id: &str) -> Self;
    pub fn on_tick(&mut self, tick: Tick, now_ms: u64) -> bool;  // 返回状态是否变化
    pub fn status(&self) -> ServiceStatus;
    pub fn set_pid(&mut self, pid: Option<u32>);
}
```
判定顺序（first match wins）：
1. `managed && !alive && exit_code.is_some()` → `Crashed`（detail 带退出码；记录 exit_code）
2. `listening && managed && !owner_is_ours` → `Conflict`（端口被外部进程占用）
3. `listening && probe.is_some()` → 探针 ok 连续成功 → `Healthy`；连续失败 ≥ `failure_threshold` → `Degraded`
4. `listening && probe.is_none()` → 保持当前状态（若当前是 Stopped/Starting 则 `Healthy`，detail 说明“仅监听事实”）
5. `managed && alive && !listening` → `Starting`
6. `!managed && !listening` → `Stopped`
7. 其它 → `Unknown`
另：`probe` 为 Some 时把结果压进 `history`（上限 120，true=ok）；`since_ms` 只在状态变化时更新；`uptime_ms` 仅在 `Healthy` 时为 `now_ms - since_ms`，否则 0；`latency_ms` 取最近一次探针耗时。

## 3. Tauri 命令（前端 `invoke` 名，snake_case）

| 命令 | 参数 | 返回 |
|---|---|---|
| `get_services` | – | `ServiceView[]` |
| `add_service` | `{ service: ServiceDef }` | `ServiceView[]` |
| `update_service` | `{ service: ServiceDef }` | `ServiceView[]` |
| `remove_service` | `{ id }` | `ServiceView[]` |
| `start_service` | `{ id }` | `ServiceView` |
| `stop_service` | `{ id, force }` | `ServiceView` |
| `restart_service` | `{ id }` | `ServiceView` |
| `stop_all_services` | `{ force }` | `ServiceView[]` |
| `probe_now` | `{ id }` | `ServiceView` |
| `get_service_logs` | `{ id, limit }` | `string[]` |
| `clear_service_logs` | `{ id }` | – |
| `list_listeners` | – | `ListenerView[]` |
| `stop_pid` | `{ pid, force }` | – |
| `get_environment` | – | `EnvView` |
| `get_settings` / `save_settings` | – / `{ settings }` | `Settings` |
| `import_preset` | – | `ServiceView[]` |
| `list_pages` | – | `PageTab[]` |
| `take_saved_pages` | – | `PageTab[]`（读后清空，前端据此重建） |
| `open_page` | `{ url, title, x, y, w, h }` | `PageTab` |
| `close_page` | `{ label }` | – |
| `activate_page` | `{ label: string \| null }`（null = 仪表盘） | – |
| `set_page_bounds` | `{ label, x, y, w, h }`（逻辑像素） | – |
| `navigate_page` | `{ label, url }` | – |
| `reload_page` | `{ label }` | – |
| `rename_page` | `{ label, title }` | – |
| `notice` | `{ level, code, detail }` | – |

参数名用 camelCase 传（Tauri 自动映射），JSON 字段见下。

## 4. 事件

| 事件 | payload |
|---|---|
| `port-status` | `ServiceStatus[]`（仅变化项） |
| `listener-status` | `ListenerView[]`（全量，变化时才发） |
| `service-log` | `{ id: string, lines: string[] }` |
| `page-load` | `{ label, url, phase: "started" \| "finished" }` |
| `notice` | `{ level: "info" \| "warn" \| "error", code, detail }` |

## 5. JSON 结构（Rust serde 字段名 = 前端字段名）

```ts
type HealthConfig = {
  type: "tcp" | "http" | "exec" | "none";
  path?: string | null;
  command?: string | null;
  intervalMs: number;        // 默认 2000
  timeoutMs: number;         // 默认 1000
  failureThreshold: number;  // 默认 2
};

type ServiceDef = {
  id: string;
  name: string;
  port: number;
  command?: string | null;   // null/空 = 仅监控
  cwd?: string | null;
  health: HealthConfig;
};

type ServiceStatus = {
  id: string;
  state: "stopped" | "starting" | "healthy" | "degraded" | "crashed" | "conflict" | "unknown";
  detail: string;
  pid: number | null;
  latencyMs: number | null;
  sinceMs: number;           // epoch ms，最近一次状态变化
  uptimeMs: number;          // 仅 healthy 时非 0
  exitCode: number | null;
  history: boolean[];        // 最近 120 次探针结果
};

type ServiceView = ServiceDef & { status: ServiceStatus; risky: boolean };

type ListenerView = {
  port: number; addr: string; pid: number; name: string; exe: string;
  ppid: number; parentName: string; established: number;
  serviceId: string | null; ours: boolean;
};

type Settings = { pollIntervalMs: number; language: "zh" | "en" | string; theme: "dark" | "light" | string; stopManagedOnExit: boolean };
type EnvView = { manifestPath: string; dataDir: string; dynamicStart: number; dynamicCount: number; excluded: [number, number][] };
type PageTab = { label: string; title: string; url: string };
```

## 6. 前端硬约束

- 应用内页面浏览 = **真实子 WebView**（`page-*`），不是 iframe。子 WebView 不匹配任何 capability ⇒ 页面没有 IPC 权限（不要给它们加权限）。
- 内容区容器负责把 `getBoundingClientRect()` 的逻辑像素（含标题栏/工具栏/标签条偏移）通过 `set_page_bounds` 下发；激活页面标签时 `activate_page(label)`，回到仪表盘 `activate_page(null)`。
- 仪表盘在内容区渲染时，必须先隐藏所有页面视图（`activate_page(null)`），否则子 WebView 会盖在表格上。
- CSP 收紧：`default-src 'self'`、`style-src 'self' 'unsafe-inline'`（Radix 定位需要内联样式）。不要引外部字体/CDN。
- 不使用 React.StrictMode。
- 文案走 `src/i18n.ts` 的 zh/en 词典；纯逻辑（状态映射、格式化、i18n key）必须是可被 `node --test` 直接 import 的纯模块。
- UI 组件用 shadcn/ui（`src/components/ui/*`），图标用 lucide-react，通知用 sonner。

## 7. 集成修订（lead：实机联调后追加，签名未变）

1. `HealthMachine::set_failure_threshold(u32)`（health 提供的附加方法）由接线层在每次 `tick()` 前按 `def.health.failureThreshold` 下发；否则清单里的阈值会被忽略。
2. 状态机补一条规则 **6b**：`managed && !alive && !listening` → `Stopped`（否则「有命令但从未启动」会落进 `Unknown`）。
3. 崩溃状态不抖：接线层把最近一次退出码粘在 `AppState.last_exit`（`supervise::poll_exit` 只返回一次）；用户主动停止会打 `stop_requested` 标记并清掉退出码，因此主动停止不会显示成 `crashed`。
4. **端口归属按进程树判断**：启动命令经 `cmd /C` 执行，真正监听端口的是孙进程（node/npm/vite）。`state.rs::tick()`、`state.rs::listener_views()`、`supervise::adopt()` 都用 `proc::is_descendant(owner, our_pid)` 而不是 pid 相等，否则托管服务会被误判成 `conflict`。
5. 优雅停止语义修正：`taskkill /T`（不带 `/F`）对控制台程序会直接失败；失败时不再白等 grace，立刻转 `/F` 强杀，只有强杀失败才向调用方返回错误。
6. `lib.rs` 的模块声明改为 `pub mod`，供 `tests/supervise.rs` 集成测试直接使用。
7. `supervise::start` 用 `CommandExt::raw_arg` 拼接 `cmd /C <用户命令>`：`arg()` 会按 C 运行时规则给内嵌引号加反斜杠，cmd.exe 不认，`node -e "..."` 这类命令会被拆坏。

## 8. 日志来源 logSource（v0.2 新增）

外部（非 PortLens 启动）进程的 stdout 抓不到（Windows 没有事后接管别人 stdout 的 API；控制台缓冲区实测对 ConPTY / 重定向进程无效）。
因此服务可声明**日志文件来源**，由 PortLens tail-follow：

```ts
type LogSource = {
  type: "process" | "file";   // 缺省 "process" = 抓到我们拉起的进程的 stdout/stderr
  path?: string | null;       // type = "file" 时必填；支持 * 与 ? 通配（取最新修改的那个文件）
  encoding?: string | null;   // 缺省 "utf-8"；可选 gbk / gb18030 / utf-16le / utf-16be / shift_jis / big5
};

type ServiceDef = {
  id: string; name: string; port: number;
  command?: string | null; cwd?: string | null;
  health: HealthConfig;
  logSource: LogSource;       // 新增，缺省 { type: "process" }
};

type ServiceView = ServiceDef & { status: ServiceStatus; risky: boolean };
```

语义（已实现，`src-tauri/src/tail.rs`）：

- 首次挂上文件时先读**尾部最多 64 KiB**（≈`tail -n`，从下一个换行开始对齐），之后只读新增字节；文件被截断（长度回退）则从 0 重新读。
- `path` 含 `*`/`?` 时按「目录 + 通配」每拍重新解析，取修改时间最新的匹配文件；路径变化视为轮转，新文件从头读。
- 解码：按 `encoding` 指定的编码流式解码（跨读取边界的多字节字符由 `encoding_rs::Decoder` 兜住），`pending` 里保留未成行的尾巴，遇到 `\n` 才落一行。
- 事件与进程日志共用一条通道：写入同一个 `LogStore` 环形缓冲（2000 行）→ `service-log` 事件 / `get_service_logs`。
- 文件不存在时不报错，静默等待它出现（例如服务尚未启动）。

