# 清单格式（services.json）

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
      }
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
| `command` | 启动命令，经 `cmd /C` 执行；`null` 或空 = **仅监控**（不负责拉起） |
| `cwd` | 启动命令的工作目录；空则用本工具进程的当前目录 |
| `health.type` | `tcp` / `http` / `exec` / `none` |
| `health.path` | `http` 探针的路径，如 `/status` |
| `health.command` | `exec` 探针的命令，退出码 0 视为健康 |
| `health.intervalMs` | 该服务探针间隔，默认 2000，最小 200 |
| `health.timeoutMs` | 单次探针超时，默认 1000 |
| `health.failureThreshold` | 连续失败多少次进入「降级」，默认 2 |

`settings.stopManagedOnExit`：退出应用时是否停止由本工具启动的服务（默认 false，即保持运行）。
`settings.pollIntervalMs`：监听表与状态的轮询间隔，默认 1000。

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
