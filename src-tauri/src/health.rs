//! 单个服务的健康状态机。owner: health
#![allow(dead_code)]

use serde::Serialize;

use crate::probe::ProbeOutcome;

/// 探针历史的保留条数。
const HISTORY_LIMIT: usize = 120;
/// 连续失败降级阈值：`Tick` 里没有该字段（契约冻结），默认与 `HealthConfig::default` 一致。
const DEFAULT_FAILURE_THRESHOLD: u32 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Stopped,
    Starting,
    Healthy,
    Degraded,
    Crashed,
    Conflict,
    Unknown,
}

/// 一次轮询的输入事实（由 monitor 采集）。
#[derive(Clone, Debug)]
pub struct Tick {
    pub listening: bool,
    pub owner_is_ours: bool,
    pub managed: bool,
    pub alive: bool,
    pub exit_code: Option<i32>,
    pub probe: Option<ProbeOutcome>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    pub id: String,
    pub state: State,
    pub detail: String,
    pub pid: Option<u32>,
    pub latency_ms: Option<u64>,
    pub since_ms: u64,
    pub uptime_ms: u64,
    pub exit_code: Option<i32>,
    pub history: Vec<bool>,
}

pub fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub struct HealthMachine {
    id: String,
    state: State,
    detail: String,
    /// 对外展示的 PID（受本拍事实约束）。
    pid: Option<u32>,
    /// `set_pid` 记下的 PID（跨拍保留）。
    stored_pid: Option<u32>,
    latency_ms: Option<u64>,
    since_ms: u64,
    exit_code: Option<i32>,
    ok_streak: u32,
    fail_streak: u32,
    failure_threshold: u32,
    history: Vec<bool>,
}

impl HealthMachine {
    pub fn new(id: &str) -> Self {
        Self {
            id: id.to_string(),
            state: State::Stopped,
            detail: String::new(),
            pid: None,
            stored_pid: None,
            latency_ms: None,
            since_ms: now_ms(),
            exit_code: None,
            ok_streak: 0,
            fail_streak: 0,
            failure_threshold: DEFAULT_FAILURE_THRESHOLD,
            history: Vec::new(),
        }
    }

    /// 应用一次轮询事实；返回状态是否发生变化。
    pub fn on_tick(&mut self, tick: Tick, now_ms: u64) -> bool {
        // 只有本拍真的跑了探针才动统计量，缺探针的一拍不重置连续计数。
        if let Some(outcome) = tick.probe.as_ref() {
            if outcome.ok {
                self.ok_streak = self.ok_streak.saturating_add(1);
                self.fail_streak = 0;
            } else {
                self.fail_streak = self.fail_streak.saturating_add(1);
                self.ok_streak = 0;
            }
            // 无探针时保留上次耗时。
            self.latency_ms = Some(outcome.latency_ms);
            self.history.push(outcome.ok);
            if self.history.len() > HISTORY_LIMIT {
                let excess = self.history.len() - HISTORY_LIMIT;
                self.history.drain(..excess);
            }
        }

        let previous = self.state;
        let (state, detail) = self.decide(&tick);
        self.state = state;
        self.detail = detail;
        self.exit_code = if state == State::Crashed { tick.exit_code } else { None };
        self.pid = if state == State::Conflict {
            // 占用者是别的进程，本机 PID 对用户没有意义。
            None
        } else if tick.owner_is_ours || tick.alive {
            self.stored_pid
        } else {
            None
        };

        if state != previous {
            self.since_ms = now_ms;
            true
        } else {
            false
        }
    }

    pub fn status(&self) -> ServiceStatus {
        let uptime_ms = if self.state == State::Healthy {
            now_ms().saturating_sub(self.since_ms)
        } else {
            0
        };
        ServiceStatus {
            id: self.id.clone(),
            state: self.state,
            detail: self.detail.clone(),
            pid: self.pid,
            latency_ms: self.latency_ms,
            since_ms: self.since_ms,
            uptime_ms,
            exit_code: self.exit_code,
            history: self.history.clone(),
        }
    }

    /// 记录由本工具拉起的 PID（用于状态快照展示）。
    pub fn set_pid(&mut self, pid: Option<u32>) {
        self.stored_pid = pid;
        self.pid = pid;
    }

    /// 连续失败降级阈值；契约的 `Tick` 里没有这个字段，默认 2，接线层可按清单下发。
    pub fn set_failure_threshold(&mut self, threshold: u32) {
        self.failure_threshold = threshold.max(1);
    }

    /// 判定顺序（first match wins，契约第 2 节 1..7 条）。
    fn decide(&self, tick: &Tick) -> (State, String) {
        // 1. 托管进程非 0 退出且端口没在听 —— 真崩了。
        //    退出码为 0 的命令是「启动器」（`start /b`、`Start-Process`、`bash restart_xx.sh` 之类）：
        //    它把服务交给别的进程后自己退出，端口随后才起来，不能当崩溃。
        let failed_exit = matches!(tick.exit_code, Some(code) if code != 0);
        if tick.managed && !tick.alive && failed_exit && !tick.listening {
            let code = tick.exit_code.unwrap_or(-1);
            return (State::Crashed, format!("进程退出（代码 {code}）"));
        }
        // 2. 我们记录的进程还活着，端口却被别的进程占了 -> 冲突。
        //    没有记录进程（从未由本工具启动/认领）时端口在听 = 服务在外面跑着，按探针判健康，
        //    不当冲突：`make restart-dsh` 起的服务被 PortLens 接管监控就是这种情形。
        if tick.listening && tick.managed && !tick.owner_is_ours && tick.alive {
            return (State::Conflict, "端口被其它进程占用".to_string());
        }
        // 3. 在监听，且本拍有探针结果。
        if tick.listening {
            if let Some(outcome) = tick.probe.as_ref() {
                if outcome.ok {
                    return (State::Healthy, probe_detail(outcome));
                }
                let threshold = self.failure_threshold.max(1);
                if self.fail_streak >= threshold {
                    return (
                        State::Degraded,
                        format!("探针连续失败 {} 次: {}", self.fail_streak, outcome.detail),
                    );
                }
                // 未到阈值：容忍单次抖动，保持当前状态（达到阈值才降级）。
                return (
                    self.state,
                    format!("探针失败 {}/{} 次: {}", self.fail_streak, threshold, outcome.detail),
                );
            }
            // 4. 在监听但没有探针结果：只按监听事实，Stopped/Starting 提升为 Healthy。
            if matches!(self.state, State::Stopped | State::Starting) {
                return (State::Healthy, "已监听，等待探针".to_string());
            }
            let detail = if self.detail.trim().is_empty() {
                "已监听，等待探针".to_string()
            } else {
                self.detail.clone()
            };
            return (self.state, detail);
        }
        // 5. 托管进程活着但还没监听。
        if tick.managed && tick.alive {
            return (State::Starting, "已启动，等待监听".to_string());
        }
        // 5b. 启动器式命令：它以 0 退出（服务交给别的进程），端口还没起来 —— 仍在启动中。
        if tick.managed && !tick.alive && tick.exit_code == Some(0) {
            return (State::Starting, "启动命令已执行（代码 0），等待端口监听".to_string());
        }
        // 6. 非托管且没在监听（走到这里 listening 一定为 false）。
        if !tick.managed {
            return (State::Stopped, "未运行".to_string());
        }
        // 6b. 托管服务当前既没有进程也没在监听：未运行（从未启动，或退出码已被消费/被主动停止）。
        if !tick.alive {
            return (State::Stopped, "未运行".to_string());
        }
        // 7. 其它组合（例如托管进程已退出但拿不到退出码）。
        (State::Unknown, "状态未知".to_string())
    }
}

/// 探针自带的 detail 就是最合适的健康说明；为空时给个兜底。
fn probe_detail(outcome: &ProbeOutcome) -> String {
    let text = outcome.detail.trim();
    if text.is_empty() {
        "探针正常".to_string()
    } else {
        text.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(ok: bool) -> ProbeOutcome {
        ProbeOutcome {
            ok,
            latency_ms: 7,
            detail: if ok { "TCP 已连接".to_string() } else { "TCP 连接失败: refused".to_string() },
        }
    }

    /// 托管进程中、活着、有监听、端口归我们：Healthy 的起点。
    fn live_tick() -> Tick {
        Tick { listening: true, owner_is_ours: true, managed: true, alive: true, exit_code: None, probe: None }
    }

    fn tick_with(probe: Option<ProbeOutcome>) -> Tick {
        Tick { probe, ..live_tick() }
    }

    #[test]
    fn managed_alive_without_listener_is_starting() {
        let mut machine = HealthMachine::new("svc");
        let tick = Tick {
            listening: false,
            owner_is_ours: false,
            managed: true,
            alive: true,
            exit_code: None,
            probe: None,
        };
        assert!(machine.on_tick(tick, 1_000));
        assert_eq!(machine.status().state, State::Starting);
        assert!(machine.status().detail.contains("监听"), "detail={}", machine.status().detail);
    }

    #[test]
    fn listen_without_probe_promotes_stopped_to_healthy_then_holds() {
        let mut machine = HealthMachine::new("svc");
        // 首次：在监听、没有探针结果 -> Healthy（仅监听事实）。
        assert!(machine.on_tick(live_tick(), 1_000));
        let status = machine.status();
        assert_eq!(status.state, State::Healthy);
        assert_eq!(status.detail, "已监听，等待探针");
        assert_eq!(status.since_ms, 1_000);

        // 再次：仍然没有探针 -> 状态保持，不产生变化事件。
        assert!(!machine.on_tick(live_tick(), 2_000));
        assert_eq!(machine.status().state, State::Healthy);
        assert_eq!(machine.status().since_ms, 1_000);
    }

    #[test]
    fn probe_failures_degrade_at_threshold() {
        let mut machine = HealthMachine::new("svc");
        assert!(machine.on_tick(tick_with(Some(probe(true))), 1_000));
        assert_eq!(machine.status().state, State::Healthy);

        // 第一次失败：未到阈值（默认 2），状态保持 Healthy。
        assert!(!machine.on_tick(tick_with(Some(probe(false))), 2_000));
        assert_eq!(machine.status().state, State::Healthy);

        // 第二次失败：到阈值 -> Degraded。
        assert!(machine.on_tick(tick_with(Some(probe(false))), 3_000));
        let status = machine.status();
        assert_eq!(status.state, State::Degraded);
        assert!(status.detail.contains("连续失败 2 次"), "detail={}", status.detail);
        assert_eq!(status.since_ms, 3_000);

        // 恢复：一次成功即回到 Healthy。
        assert!(machine.on_tick(tick_with(Some(probe(true))), 4_000));
        assert_eq!(machine.status().state, State::Healthy);
        assert_eq!(machine.status().detail, "TCP 已连接");
    }

    #[test]
    fn custom_failure_threshold_is_respected() {
        let mut machine = HealthMachine::new("svc");
        machine.set_failure_threshold(3);
        machine.on_tick(tick_with(Some(probe(true))), 1_000);
        assert!(!machine.on_tick(tick_with(Some(probe(false))), 2_000));
        assert!(!machine.on_tick(tick_with(Some(probe(false))), 3_000));
        assert_eq!(machine.status().state, State::Healthy);
        assert!(machine.on_tick(tick_with(Some(probe(false))), 4_000));
        assert_eq!(machine.status().state, State::Degraded);
    }

    #[test]
    fn external_owner_is_conflict_without_pid() {
        let mut machine = HealthMachine::new("svc");
        machine.set_pid(Some(4321));
        let tick = Tick { owner_is_ours: false, ..live_tick() };
        assert!(machine.on_tick(tick, 1_000));
        let status = machine.status();
        assert_eq!(status.state, State::Conflict);
        assert_eq!(status.pid, None);
        assert!(status.detail.contains("占用"), "detail={}", status.detail);
    }

    #[test]
    fn exited_process_is_crashed_with_exit_code() {
        let mut machine = HealthMachine::new("svc");
        let tick = Tick {
            listening: false,
            owner_is_ours: false,
            managed: true,
            alive: false,
            exit_code: Some(3),
            probe: None,
        };
        assert!(machine.on_tick(tick.clone(), 1_000));
        let status = machine.status();
        assert_eq!(status.state, State::Crashed);
        assert_eq!(status.exit_code, Some(3));
        assert!(status.detail.contains("3"), "detail={}", status.detail);

        // 同样的事实再来一拍：状态没变。
        assert!(!machine.on_tick(tick, 2_000));
        assert_eq!(machine.status().since_ms, 1_000);
    }

    #[test]
    fn unmanaged_and_idle_is_stopped() {
        let mut machine = HealthMachine::new("svc");
        let idle = Tick {
            listening: false,
            owner_is_ours: false,
            managed: false,
            alive: false,
            exit_code: None,
            probe: None,
        };
        // 初始状态就是 Stopped：同样的事实不产生变化事件。
        assert!(!machine.on_tick(idle.clone(), 1_000));
        assert_eq!(machine.status().state, State::Stopped);
        assert_eq!(machine.status().detail, "未运行");

        // 先进入 Starting，再变成非托管空闲 -> Stopped。
        let starting = Tick { managed: true, alive: true, ..idle.clone() };
        assert!(machine.on_tick(starting, 2_000));
        assert_eq!(machine.status().state, State::Starting);
        assert!(machine.on_tick(idle, 3_000));
        assert_eq!(machine.status().state, State::Stopped);
        assert_eq!(machine.status().since_ms, 3_000);
    }

    #[test]
    fn history_is_capped_at_120() {
        let mut machine = HealthMachine::new("svc");
        let mut now = 1_000;
        for index in 0..130u32 {
            machine.on_tick(tick_with(Some(probe(index % 2 == 0))), now);
            now += 10;
        }
        let history = machine.status().history;
        assert_eq!(history.len(), HISTORY_LIMIT);
        // 丢掉最旧的 10 条：剩的第一条是第 11 次（index 10，偶数 -> true）。
        assert!(history[0]);
        assert!(!history[HISTORY_LIMIT - 1]);
    }

    #[test]
    fn latency_keeps_last_probe_value() {
        let mut machine = HealthMachine::new("svc");
        machine.on_tick(tick_with(Some(probe(true))), 1_000);
        assert_eq!(machine.status().latency_ms, Some(7));
        // 缺探针的一拍沿用上次耗时。
        machine.on_tick(live_tick(), 2_000);
        assert_eq!(machine.status().latency_ms, Some(7));
    }

    #[test]
    fn uptime_is_non_zero_only_when_healthy() {
        let mut machine = HealthMachine::new("svc");
        machine.on_tick(tick_with(Some(probe(true))), 1_000);
        assert_eq!(machine.status().state, State::Healthy);
        assert!(machine.status().uptime_ms > 0, "uptime={}", machine.status().uptime_ms);

        machine.on_tick(tick_with(Some(probe(false))), 2_000);
        machine.on_tick(tick_with(Some(probe(false))), 3_000);
        assert_eq!(machine.status().state, State::Degraded);
        assert_eq!(machine.status().uptime_ms, 0);
    }

    #[test]
    fn since_ms_follows_state_changes_only() {
        let mut machine = HealthMachine::new("svc");
        machine.on_tick(live_tick(), 1_000);
        assert_eq!(machine.status().since_ms, 1_000);
        assert!(!machine.on_tick(live_tick(), 2_000));
        assert_eq!(machine.status().since_ms, 1_000);

        let crash = Tick { alive: false, exit_code: Some(1), listening: false, ..live_tick() };
        assert!(machine.on_tick(crash, 3_000));
        assert_eq!(machine.status().state, State::Crashed);
        assert_eq!(machine.status().since_ms, 3_000);
    }

    #[test]
    fn managed_service_running_outside_is_not_a_conflict() {
        // Never tracked a pid (started by `make restart-dsh`, not by PortLens): the port owner is
        // someone else but nothing of ours is running, so the probe decides the state.
        let outside = Tick {
            listening: true,
            owner_is_ours: false,
            managed: true,
            alive: false,
            exit_code: None,
            probe: Some(probe(true)),
        };
        let mut machine = HealthMachine::new("dsh-web");
        machine.on_tick(outside, 1_000);
        assert_eq!(machine.status().state, State::Healthy);
        assert!(machine.status().pid.is_none());
    }

    #[test]
    fn launcher_style_command_is_not_a_crash() {
        let mut machine = HealthMachine::new("dsh-web");
        // `bash restart_dsh.sh` starts the service detached and exits 0 while the port is not
        // listening yet: that is "starting", not "crashed".
        let launcher = Tick {
            listening: false,
            owner_is_ours: false,
            managed: true,
            alive: false,
            exit_code: Some(0),
            probe: None,
        };
        machine.on_tick(launcher, 1_000);
        assert_eq!(machine.status().state, State::Starting);
        assert!(machine.status().detail.contains("启动命令已执行"), "{}", machine.status().detail);

        // The port comes up afterwards (served by the detached child) -> healthy.
        let up = Tick { listening: true, owner_is_ours: true, managed: true, alive: false, exit_code: Some(0), probe: Some(probe(true)) };
        machine.on_tick(up, 2_000);
        assert_eq!(machine.status().state, State::Healthy);

        // A non-zero exit with the port still served by someone else is not a crash either: the
        // service answers, the listener view tells who owns it.
        let mut other = HealthMachine::new("svc");
        let foreign = Tick { listening: true, owner_is_ours: false, managed: true, alive: false, exit_code: Some(2), probe: None };
        other.on_tick(foreign, 1_000);
        assert_eq!(other.status().state, State::Healthy);
    }

    #[test]
    fn pid_reflects_stored_value_and_liveness() {
        let mut machine = HealthMachine::new("svc");
        machine.set_pid(Some(4321));
        assert_eq!(machine.status().pid, Some(4321));

        machine.on_tick(live_tick(), 1_000);
        assert_eq!(machine.status().pid, Some(4321));

        // 既不是我们的监听、进程也不活 -> 不展示 PID。
        let foreign = Tick { owner_is_ours: false, managed: false, alive: false, ..live_tick() };
        machine.on_tick(foreign, 2_000);
        assert_eq!(machine.status().pid, None);

        // 下一拍 set_pid + 存活，PID 回来。
        machine.set_pid(Some(4321));
        machine.on_tick(live_tick(), 3_000);
        assert_eq!(machine.status().pid, Some(4321));
    }
}
