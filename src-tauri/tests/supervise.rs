//! 真实进程集成测试：启动托管服务 → 端口在听 → 停止 → 端口释放（进程树整体结束）。

use std::net::TcpListener;
use std::time::{Duration, Instant};

use portlens_lib::config::{HealthConfig, ServiceDef};
use portlens_lib::logs::LogStore;
use portlens_lib::ports;
use portlens_lib::proc;
use portlens_lib::supervise::ServiceManager;

/// 取一个 15001 以上的空闲端口：动态端口段（1024-15000）与排除段里的端口可能被系统抢占，
/// 落在其中的端口 bind 会直接 EACCES。
fn free_port() -> u16 {
    for port in 15250..15400u16 {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)) {
            drop(listener);
            return port;
        }
    }
    panic!("no free test port in 15250..15400");
}

fn wait_until(mut probe: impl FnMut() -> bool, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if probe() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    probe()
}

/// 断言失败时也要收掉被测进程：否则残留子进程会继承 cargo 的输出管道，
/// 让上层的 | Select-Object / 管道永远等不到 EOF。
struct KillOnDrop(Option<u32>);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        if let Some(pid) = self.0 {
            let _ = proc::kill_tree(pid, true);
        }
    }
}

#[test]
fn start_and_stop_a_real_node_listener() {
    // 隔离运行时台账：ServiceManager 会把台账写进 PORTLENS_DATA_DIR。
    let data_dir = tempfile::tempdir().expect("tempdir");
    std::env::set_var("PORTLENS_DATA_DIR", data_dir.path());

    let port = free_port();
    let command = format!("node -e \"require('net').createServer(s=>s.end()).listen({port})\"");
    let def = ServiceDef {
        id: "it-managed".into(),
        name: "integration managed".into(),
        port,
        command: Some(command.clone()),
        cwd: None,
        health: HealthConfig::default(),
    };

    let logs = LogStore::new();
    let mut manager = ServiceManager::new(logs.clone());

    let pid = manager.start(&def).expect("start managed service");
    let mut guard = KillOnDrop(Some(pid));
    assert!(pid > 0, "pid should be non-zero");
    assert_eq!(manager.pid_of(&def.id), Some(pid));
    assert!(proc::is_alive(pid), "spawned process should be alive");

    assert!(
        wait_until(|| ports::is_listening(port), Duration::from_secs(15)),
        "managed service should start listening on {port}"
    );
    let owner = ports::owner_pid(port).expect("port must have an owner process");
    assert!(
        owner == pid || proc::is_descendant(owner, pid),
        "owner pid {owner} should be the spawned process {pid} or one of its descendants"
    );
    assert!(manager.poll_exit(&def.id).is_none(), "process should still be running");

    assert!(
        wait_until(
            || logs.tail(&def.id, 50).iter().any(|line| line.contains("started pid=")),
            Duration::from_secs(5)
        ),
        "startup line should be captured in the log ring"
    );

    manager.stop(&def, false).expect("stop managed service");
    guard.0 = None;

    assert!(!manager.alive(&def.id), "manager should forget the pid after stop");
    assert!(
        wait_until(|| !ports::is_listening(port), Duration::from_secs(10)),
        "port {port} should be released (whole process tree gone)"
    );
    assert!(manager.pid_of(&def.id).is_none());
}

#[test]
fn start_refuses_when_port_is_taken() {
    let data_dir = tempfile::tempdir().expect("tempdir");
    std::env::set_var("PORTLENS_DATA_DIR", data_dir.path());

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral");
    let port = listener.local_addr().expect("local_addr").port();

    let def = ServiceDef {
        id: "it-conflict".into(),
        name: "integration conflict".into(),
        port,
        command: Some("cmd /C exit 0".into()),
        cwd: None,
        health: HealthConfig::default(),
    };

    let mut manager = ServiceManager::new(LogStore::new());
    let err = manager.start(&def).expect_err("start must fail while the port is occupied");
    assert!(err.contains("已被占用"), "unexpected error: {err}");
    drop(listener);
}
