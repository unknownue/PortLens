# 清单格式（services.json）

> 要让 agent 帮你接入一个新服务（用户只给一个基本路径），看 [onboarding.md](onboarding.md)：
> 挖取流程 + 字段决策表 + 验证门禁，配 `tools/scan-service.ps1`（只读扫描器）与 `services.schema.json`。

清单是 PortLens 的唯一真源：哪些端口要看、每个端口怎么启动、怎么判健康。

路径解析顺序：

1. 命令行 `--config <path>`
2. 环境变量 `PORTLENS_CONFIG`
3. 默认 `%LOCALAPPDATA%\PortLens\services.json`（不存在时自动创建空清单）

写入是「临时文件 + 原子改名」，保存前校验：id 非空且唯一、端口非 0 且不重复、探针参数齐全。

```json
{
  "version": 1,
  "settings": {
    "pollIntervalMs": 1000,
    "language": "zh",
    "theme": "dark",
    "stopManagedOnExit": false
  },
  "services": [
    {
      "id": "stzbmcp-host-15901",
      "name": "stzbmcp 宿主服务",
      "port": 15901,
      "command": "powershell -NoProfile -ExecutionPolicy Bypass -File host\\stzbmcp_host.ps1",
      "cwd": "E:\\Workspace\\dev-kit\\stzbmcp",
      "health": {
        "type": "http",
        "path": "/status",
        "intervalMs": 3000,
        "timeoutMs": 1500,
        "failureThreshold": 2
      },
      "logSource": { "type": "file", "path": "logs\\host-*.log", "encoding": "gbk" }
    }
  ]
}
```

## 字段

| 字段 | 说明 |
|---|---|
| `id` | 唯一标识；留空时由名称 + 端口自动生成 slug |
| `name` | 显示名 |
| `port` | 主端口（一个服务一个端口；多端口服务声明成多条） |
| `command` | 启动命令，经 `cmd /C` 执行；`null` 或空 = **仅监控**（不负责拉起）。可以是「启动器」式命令，见下 |
| `cwd` | 启动命令的工作目录；空则用本工具进程的当前目录 |
| `health.type` | `tcp` / `http` / `exec` / `none` |
| `health.path` | `http` 探针的路径，如 `/status` |
| `health.command` | `exec` 探针的命令，退出码 0 视为健康 |
| `health.intervalMs` | 该服务探针间隔，默认 2000，最小 200 |
| `health.timeoutMs` | 单次探针超时，默认 1000 |
| `health.failureThreshold` | 连续失败多少次进入「降级」，默认 2 |
| `logSource.type` | `process`（默认，抓本工具拉起的进程 stdout/stderr）或 `file`（跟踪日志文件） |
| `logSource.path` | `file` 时必填；支持 `*` / `?` 通配，每拍取修改时间最新的匹配文件（按日期切分的日志用它） |
| `logSource.encoding` | 默认 `utf-8`；可选 `gbk` / `gb18030` / `utf-16le` / `utf-16be` / `shift_jis` / `big5` |
| `page.url` | 页面标签打开哪个地址；留空 = `http://127.0.0.1:<port>/`；只支持 http(s) |
| `page.headers` | 打开该页面的请求头（键=头名）。值支持 `${env:NAME}` / `${file:PATH:KEY}`，避免明文入库 |
| `page.title` | 标签标题；留空 = 服务名 |

## 页面与请求头（需要鉴权的服务）

有些本地服务对浏览器不友好：`stzbmcp` 宿主服务除 `/health` 外都校验 `X-STZBMCP-Token`，
直接开标签只能看到一行 403 JSON。给它配上 `page` 就能正常打开：

```json
"page": {
  "url": "http://127.0.0.1:15901/status",
  "headers": { "X-STZBMCP-Token": "${file:E:\\Workspace\\ws\\trunk\\.ws.env:STZBMCP_TOKEN}" },
  "title": "stzbmcp 宿主服务"
}
```

语义与边界：

- 请求头**只发给 `page.url` 的 origin**（`scheme://host:port`）：顶层文档、同源子资源、`fetch` / `XHR`、刷新都带上；
  跨 origin 的跳转与第三方资源一律不带（`inject.rs` 过滤器 + 处理函数双重校验）。
- 支持 `${env:NAME}` 与 `${file:PATH:KEY}`（`PATH` 是 `KEY=VALUE` 文本，如 `.ws.env`，容忍 `export` 与引号）。
  清单里因此**不出现明文**；界面列表只显示 `••••••`，明文仅在编辑对话框回填与「显示/复制」时按需取。
- 受保护头（`Host`、`Content-Length`、`Connection`、`Transfer-Encoding` 等）会被拒绝保存；头名/值里的控制字符（换行注入）同样拒绝。
- `page.url` 指向非回环地址时界面会提示「会把配置的请求头发给该主机」。
- 目标文档返回 401/403 时，标签上出现可点提示（即使没配 `headers` 也会提示），文案指向这里。
- `ui.json` 只记标签的 label/title/url；重启恢复标签时请求头从清单现取，不落盘。

机制细节（WebView2 `WebResourceRequested`、时序、为什么不是 iframe）见 [pages.md](pages.md)。

`settings.stopManagedOnExit`：退出应用时是否停止由本工具启动的服务（默认 false，即保持运行）。
`settings.pollIntervalMs`：监听表与状态的轮询间隔，默认 1000。

## 启动器式命令（自己退出、服务交给别的进程）

很多服务的启动入口是个**启动器**：`bash scripts/restart_dsh.sh`、`start /b ...`、`Start-Process ...`。
它把真正的服务交给别的进程后自己以 0 退出，端口过一会儿才被监听。状态机按这么判：

| 事实 | 状态 |
|---|---|
| 命令非 0 退出 **且**端口没在听 | `crashed`（进程退出，代码 N） |
| 命令以 0 退出 **且**端口还没在听 | `starting`（启动命令已执行，等待端口监听） |
| 命令已退出但端口在听（真正监听的是它拉起的后代进程） | 按监听与探针判：`healthy` / `degraded`；被别人占用则是 `conflict` |

停止仍然是统一的进程树停止：先 `taskkill /PID <记录的 pid> /T`，记录里的进程不在了就退回到**端口占用者**（`GetExtendedTcpTable` 拿到的 PID）再杀，最后校验端口释放 —— 所以启动器式命令同样能停掉。

清单里的真实例子（本工作区的 dsh web）：

```json
{
  "id": "dsh-web-15080",
  "name": "dsh web (GUI)",
  "port": 15080,
  "command": "bash scripts/restart_dsh.sh",
  "cwd": "E:\\Workspace",
  "health": { "type": "tcp", "intervalMs": 3000, "timeoutMs": 1000, "failureThreshold": 2 },
  "logSource": { "type": "file", "path": "C:\\Users\\duzihui\\.dsh-web.out.log", "encoding": "utf-8" }
}
```

`scripts/restart_dsh.sh` 自己会：杀掉端口占用者、从 `.credentials.yaml` 取并续期 `CODEMAKER_ACCESS_TOKEN`、导出 `DSH_PERMISSION_MODE`、清理陈旧 profile 写锁、用 `Start-Process` 脱离启动 `dsh.cmd web --no-open --port 15080`（stdout/stderr 落 `~/.dsh-web.out.log` / `.err.log`）、并从日志里捞出带 token 的鉴权 URL —— 那串 URL 就在日志标签里（`logSource` 指到 `.dsh-web.out.log`）。`dsh web` 的 `/` 需要 token，所以探针用 `tcp`。

## 日志来源（外部服务为什么需要它）

Windows 没有「事后接管别的进程 stdout」的 API：进程的 stdio 句柄在创建时固定且私有，
从别的进程复制句柄等于把输出从原读者手里偷走（会破坏启动它的终端 / agent）。
控制台缓冲区抓取也只在老式 conhost 且输出未重定向时有效，实测对 Windows Terminal（ConPTY）
与 `CREATE_NO_WINDOW` + 管道启动的进程都读不到内容。

所以**不是本工具启动的服务**要在这里看日志，就用文件跟踪：

```json
"logSource": { "type": "file", "path": "E:\\svc\\logs\\app-*.log", "encoding": "gbk" }
```

行为：

- 首次挂上文件先读**尾部 64 KiB**（相当于 `tail -n`，从下一个换行开始对齐），之后只读新增字节；
  文件被截断（长度回退）时从 0 重新读。
- 带通配符时每拍重新解析目录，取修改时间最新的匹配文件；换文件（轮转）视为从头读新文件。
- 流式解码（跨读取边界的多字节字符不会碎），未成行的尾巴留在缓冲里等换行。
- 文件不存在不报错，静默等它出现（服务还没启动时就是这个状态）。
- 行进同一个环形缓冲（2000 行），与进程日志共用日志面板、`service-log` 事件与 `get_service_logs`。
- 界面入口：服务行的「日志」按钮开一个**日志标签**（实时跟随 / 过滤 / 暂停 / 清空 / 复制），详情抽屉里也有「打开日志标签」；
  `ui.json` 只记标签身份（`logTabs: [{ id, serviceId, title }]`），不存日志内容。

## 状态语义

| 状态 | 含义 |
|---|---|
| `stopped` | 端口没在听，也没有本工具的进程 |
| `starting` | 进程已拉起，探针还没成功 |
| `healthy` | 端口在听 + 探针成功 |
| `degraded` | 端口在听，但探针连续失败到阈值（典型：进程活着但接口报错） |
| `crashed` | 本工具拉起的进程已退出（非 0 退出码），日志里能看到退出码 |
| `conflict` | 端口在听，但占用者是别的进程（不是本工具拉起的那个 PID） |
| `unknown` | 探针无法执行（权限/超时等），原因写在 detail 里 |

## 端口风险

启动前服务若落在下列区间，界面显示告警徽标：

- Windows 动态端口段（本机默认从 1024 起，共 13977 个）——落在其中的端口可能被系统临时占用。
- `netsh int ipv4 show excludedportrange protocol=tcp` 列出的排除段（winnat / Hyper-V 保留）——`listen` 会直接报 EACCES。

结论：服务端口一律用 **15001 以上**，并避开本机排除段。
