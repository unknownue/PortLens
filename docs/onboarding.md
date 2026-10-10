# 服务接入规范（agent 执行手册）

**用途**：用户只想说一句「把这个服务加到 PortLens」，最多给一个**基本路径**。挖端口、挖启动命令、选探针、定日志来源、写清单、验状态，全由 agent 按本规范完成。

**输入**

| 输入 | 必填 | 说明 |
|---|---|---|
| 基本路径 | 是 | 服务所在目录（可以是 junction，脚本会解析真实路径）。例：`E:\Workspace\dev-kit\stzbmcp` |
| 端口 | 否 | 已知就带上（`-Port 15901`），省掉候选确认 |
| 显示名 | 否 | 缺省用目录名 |
| 清单位置 | 否 | 缺省用用户级清单；工程内清单见「落地方式」 |

**输出**：一条 `services.json` 记录 + 一份验证结论（端口、状态、日志证据）。

**硬规则**

1. **不许猜**：每个字段都要有出处（文件:行、`Get-NetTCPConnection` 结果、或用户明说）。给不出出处就在结尾列成待确认项。
2. **不许擅自启停**：挖取阶段只读。要启动服务来确认端口/健康，先问用户。
3. **端口必须 ≥ 15001**：本机 TCP 动态端口段是 `1024-15000`，另有 winnat/Hyper-V 排除段，落在里面的端口可能被系统抓走、`listen` 直接 EACCES。服务原本用低端口就照实填，但要在待确认项里点出这个风险。
4. **一个服务一条记录**：多端口服务拆成多条，不合并。

## 一、跑扫描器（机械部分）

```powershell
# 人读的报告
powershell -NoProfile -ExecutionPolicy Bypass -File tools\scan-service.ps1 -Path <基本路径>
# 结构化（agent 解析用）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\scan-service.ps1 -Path <基本路径> -Port <端口> -Name "<显示名>" -Json
```

输出字段：`detected.kinds`（node/python/dotnet/go/rust/powershell）、`portCandidates`（按「源码命中数」排序，附 `file:line`）、`listeningShown`（候选端口当前是否在听、谁的 PID）、`portRisk`（动态段起点、排除段、所选端口是否有风险）、`commandCandidates`（带优先级 p1..p4）、`healthCandidates`、`logFileCandidates`、`logHints`、`draft`（可直接填的草稿）、`openQuestions`（必须由人确认的点）。

扫描器**永远不写文件、不启动进程**。

## 二、挖取流程（扫描器给不出答案时自己挖）

| 步骤 | 动作 | 判据 |
|---|---|---|
| 1 认技术栈 | 看 `detected.kinds` + 目录里的 `package.json` / `pyproject.toml` / `*.csproj` / `go.mod` / `Cargo.toml` / `*.ps1` | 决定启动命令的形态 |
| 2 找端口 | 扫描器的 `portCandidates`；不够就 grep 关键字：`listen(`、`--port`、`PORT`、`"port"`、`127.0.0.1:<n>`、配置里的 `port` 段 | 同一个端口在**源码**里出现 ≥1 次，且与 `listeningShown` 一致；只有文档命中不算证据 |
| 3 定启动命令 | `commandCandidates` 优先级：p1 `package.json` 的 dev/start/serve 脚本 → p2 `Makefile` 目标 → p3 目录里的启动脚本（`host*/serve*/start*/run*/dev*`）→ p4 README 里的运行示例 | p1/p2/p3 可直接用；只有 p4 时要回读 README 上下文，确认那是**服务本身**而不是客户端/测试命令 |
| 4 选探针 | 有 `/health`、`/healthz`、`/status` 之类的稳定无鉴权路径 → `http`；否则 `tcp` | http 探针只认 2xx/3xx：目标要鉴权（401/403）或根路径返回 404 的服务，一律用 `tcp`（例：`dsh web` 的 `/` 返回 401 → 用 tcp） |
| 5 定日志来源 | 该服务自己写日志文件 → `logSource.type = "file"`，路径取最新那个日志文件，按日期切分的用通配（`app-*.log`）；中文 Windows 控制台日志多半是 `gbk` | 拿不到日志文件、且服务由 PortLens 启动 → 用默认 `process`（stdout/stderr 管道）；**外部**进程没有日志文件就没有日志可看（Windows 抓不到别人 stdout），要在结论里说明 |

## 三、字段决策表

| 字段 | 取值 | 缺省 |
|---|---|---|
| `id` | `{名称 slug}-{端口}`，小写、连字符 | 由名称+端口自动生成 |
| `name` | 用户给的名字；没给就用目录名 | 目录名 |
| `port` | 见流程 2 | 无（必填） |
| `command` | 见流程 3，经 `cmd /C` 执行；**留空 = 只监控不托管** | `null` |
| `cwd` | 基本路径的真实路径（相对路径的脚本、资源都按它解析） | 本工具进程的当前目录 |
| `health.type` | `tcp`（默认）/ `http` / `exec` / `none` | `tcp` |
| `health.path` | http 探针路径 | 无 |
| `health.command` | exec 探针命令（退出码 0 = 健康） | 无 |
| `health.intervalMs` / `timeoutMs` / `failureThreshold` | 2000 / 1000 / 2 起调；慢启动服务把 threshold 调到 3-4 | 同左 |
| `logSource.type` | `process`（本工具拉起的进程输出）/ `file`（tail 日志文件） | `process` |
| `logSource.path` | 日志文件，支持 `*` `?`（每拍取最新匹配，天然支持轮转） | 无 |
| `logSource.encoding` | `utf-8` / `gbk` / `gb18030` / `utf-16le` / `utf-16be` / `shift_jis` / `big5` | `utf-8` |

## 四、落地方式

| 场景 | 做法 |
|---|---|
| 用户手动加 | 应用里「新增服务」对话框（日志来源 → 文件跟踪时会出现路径/编码，带原生文件选择器） |
| agent 代填（用户级） | 写 `%LOCALAPPDATA%\PortLens\services.json`，**改完要重启 PortLens**（清单只在启动时读一次） |
| agent 代填（工程内） | 把清单放工程里，用 `PORTLENS_CONFIG=<路径>` 或命令行 `--config <路径>` 启动 PortLens |

写文件前先过 schema：

```powershell
$manifest = Get-Content -Raw services.json | ConvertFrom-Json
$schema = Get-Content -Raw docs\services.schema.json | ConvertFrom-Json
$manifest | Test-Json -Schema $schema -ErrorAction Stop   # 失败会抛出具体路径
```

**注意**：清单解析失败时 PortLens 会回落到「空清单」并只在 stderr 打印原因 —— 界面上看起来就是「一个服务都没有」。所以写完一定要重启并确认服务出现在列表里。

## 五、验证门禁（全部要过）

1. 重启 PortLens 后服务出现在列表里（说明清单解析成功）。
2. 端口风险徽标不出现（出现就说明端口落在动态段/排除段，回报用户换端口）。
3. 状态到 `healthy`；`tcp` 探针只证明端口在听，`http`/`exec` 才证明服务真的能用。
   外部服务（`command` 为空）显示 `healthy` 且 PID 是别人的，`conflict` 表示端口被**另一个**进程占用。
4. `logSource.type = file` 时：抽屉里能看到历史行（尾部 64 KiB 会先喂进来），并且新写入的行会持续出现。
   命令行等价检查（E2E 脚本同一套 API）：
   ```powershell
   node tools\e2e-logs.mjs      # 会拉起打包 exe + 跑一个外部写日志的服务，8 项断言
   ```
5. 把这条记录喂给 `tools\e2e-ports.mjs` 那套语义（启停 + 端口释放）如果用户要求托管：启动 → 状态 healthy → 停止 → 端口释放。

## 六、失败模式对照

| 现象 | 原因 | 处理 |
|---|---|---|
| 列表空白 | 清单 JSON 坏了（校验失败回落默认） | 看 stderr；用 schema 校验；修好重启 |
| `端口冲突` | 端口被别的进程占着（不是本工具记录的 PID） | 停占用者，或确认归属后改 id/端口 |
| 状态一直 `启动中` | 命令起来了但没监听（端口不对/需要参数/需要先跑依赖） | 看日志面板；核对端口与 `cwd` |
| `降级` | 端口在听但探针失败 | http 路径/期望码不对（如 401/404），改路径或换 `tcp` |
| 日志乱码 | 编码猜错（中文 Windows 控制台/文件多为 GBK） | `logSource.encoding = "gbk"` |
| 日志不更新 | 路径不对、服务换了新日志文件、或日志根本没写文件 | 用通配路径；确认服务确实落了盘 |
| 外部服务没有日志 | Windows 拿不到别人 stdout | 要么配 `logSource` 文件跟踪，要么让用户接受「停止后用 PortLens 启动」 |

## 七、完整示例（真实扫描结果）

基本路径 `E:\Workspace\dev-kit\stzbmcp`，扫描器给出的证据：

```
port candidates: 15910(src=2) 9601(src=2) 15901(src=1) 9588(src=0)
listening:       15901 pid=13080 powershell      # 与路径相关
start commands:  p3 host\stzbmcp_host.ps1  p3 host\stzbmcp_host_supervisor.ps1  p3 viewer\start-viewer.ps1 ...
health paths:    /status  /health
log files:       logs\host.log (969976 B)  ...
port risk:       dynamic 1024 + 13977 ports; 15901 risky = False
open questions:  4 port candidates - confirm which one is the real listen port
                 service is not listening right now - start it once to confirm port and health
```

由 15901 + `host\stzbmcp_host.ps1` 填成（用户确认端口后）：

```json
{
  "id": "stzbmcp-host-15901",
  "name": "stzbmcp 宿主服务",
  "port": 15901,
  "command": "powershell -NoProfile -ExecutionPolicy Bypass -File host\\stzbmcp_host.ps1",
  "cwd": "E:\\Workspace\\dev-kit\\stzbmcp",
  "health": { "type": "http", "path": "/status", "intervalMs": 3000, "timeoutMs": 1500, "failureThreshold": 2 },
  "logSource": { "type": "file", "path": "logs\\host.log", "encoding": "utf-8" }
}
```

同一个仓库里的查看器是另一条记录：`15910` + `python3 serve.py --port 15910`，`cwd` 指到 `viewer\`。
它的实测接入过程（2026-10-10，`tmp/onboard-demo.mjs`，7/7 通过）里有两点值得照抄：

- 扫描器给的是 p3 候选 `start-viewer.bat`（双击友好包装，会顺手开浏览器）；回读 `serve.py` 的 docstring 后改用直接命令 `python3 serve.py --port 15910`，并把 `-NoOpen` 这类交互副作用留在用户手里。
- 扫描器的 health 候选是 `/health`，而真实路由是 `/api/health`（docstring 里写的）——**探针路径必须回读源码确认**；用错路径的表现是端口在听、状态却是「降级」。

## 八、相关文件

| 文件 | 内容 |
|---|---|
| `docs/manifest.md` | 清单字段、状态语义、端口风险的完整说明 |
| `docs/services.schema.json` | JSON Schema（`Test-Json -Schema` 可直接用） |
| `tools/scan-service.ps1` | 扫描器：只读，产出证据报告与草稿 |
| `tools/e2e-logs.mjs` | 外部服务日志跟踪的端到端验证（8 项） |
| `presets/workspace-gm10.json` | 本工作区常用端口的内置预置（设置页可一键导入） |
