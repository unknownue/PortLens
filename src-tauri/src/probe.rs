//! 健康探针（tcp / http / exec）。owner: health
#![allow(dead_code)]

use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::config::HealthConfig;

/// `CREATE_NO_WINDOW`：子进程不弹控制台窗口。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// 轮询子进程退出码的间隔。
const POLL_INTERVAL: Duration = Duration::from_millis(20);
/// 超时后等 taskkill 生效的最长时间。
const KILL_GRACE: Duration = Duration::from_millis(2_000);
/// 状态行无法解析时，detail 里保留的最大字符数。
const SNIPPET_LIMIT: usize = 80;

#[derive(Clone, Debug, Serialize)]
pub struct ProbeOutcome {
    pub ok: bool,
    pub latency_ms: u64,
    pub detail: String,
}

/// 按健康配置执行一次探针；任何错误都体现在 ok=false + detail，不 panic。
pub fn run(port: u16, h: &HealthConfig) -> ProbeOutcome {
    let started = Instant::now();
    let (ok, detail) = match h.kind.trim().to_ascii_lowercase().as_str() {
        "tcp" => probe_tcp(port, h.timeout_ms),
        "http" => probe_http(port, h),
        "exec" => probe_exec(h),
        "none" => (true, "未配置探针".to_string()),
        _ => (true, "未配置探针".to_string()),
    };
    ProbeOutcome { ok, latency_ms: started.elapsed().as_millis() as u64, detail }
}

/// 从 HTTP 状态行（如 `HTTP/1.1 200 OK`）解析状态码。
///
/// 要求 `HTTP/` 前缀（版本号非空）+ 3 位数字状态码，否则 `None`；末尾 `\r\n` 不影响。
pub fn parse_status_line(line: &str) -> Option<u16> {
    let mut parts = line.split_whitespace();
    let version = parts.next()?;
    if version.len() <= "HTTP/".len() || !version.starts_with("HTTP/") {
        return None;
    }
    let code = parts.next()?;
    if code.len() != 3 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    code.parse::<u16>().ok()
}

// ------------------------------------------------------------------ tcp

/// 只要 TCP 能连上就算健康（不校验应用层协议）。
fn probe_tcp(port: u16, timeout_ms: u64) -> (bool, String) {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    match TcpStream::connect_timeout(&addr, timeout_of(timeout_ms)) {
        Ok(_) => (true, "TCP 已连接".to_string()),
        Err(err) => (false, format!("TCP 连接失败: {err}")),
    }
}

// ------------------------------------------------------------------ http

/// 手写 HTTP/1.1 请求（不支持 TLS），只看状态行：2xx/3xx 为 ok。
fn probe_http(port: u16, h: &HealthConfig) -> (bool, String) {
    let timeout = timeout_of(h.timeout_ms);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = match TcpStream::connect_timeout(&addr, timeout) {
        Ok(stream) => stream,
        Err(err) => return (false, format!("TCP 连接失败: {err}")),
    };
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));

    let path = normalize_path(h.path.as_deref().unwrap_or("/"));
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nUser-Agent: PortLens\r\n\r\n"
    );
    if let Err(err) = stream.write_all(request.as_bytes()) {
        return (false, format!("HTTP 请求发送失败: {err}"));
    }
    if let Err(err) = stream.flush() {
        return (false, format!("HTTP 请求发送失败: {err}"));
    }

    let mut line = String::new();
    match BufReader::new(stream).read_line(&mut line) {
        Ok(0) => (false, "HTTP 无响应".to_string()),
        Ok(_) => match parse_status_line(&line) {
            Some(code) if (200..=399).contains(&code) => (true, format!("HTTP {code}")),
            Some(code) => (false, format!("HTTP {code}")),
            None => (false, format!("HTTP 状态行无法解析: {}", snippet(&line))),
        },
        Err(err) => (false, format!("HTTP 读取失败: {err}")),
    }
}

fn normalize_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        "/".to_string()
    } else if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    }
}

/// 截断到 `SNIPPET_LIMIT` 个字符，供 detail 展示读到的原始内容。
fn snippet(text: &str) -> String {
    let cleaned = text.trim_end_matches(['\r', '\n']).trim();
    let cut: String = cleaned.chars().take(SNIPPET_LIMIT).collect();
    if cut.is_empty() {
        "(空)".to_string()
    } else {
        cut
    }
}

// ------------------------------------------------------------------ exec

/// 跑 `cmd /C <command>`：退出码 0 为 ok，超时杀整棵进程树并返回 ok=false。
fn probe_exec(h: &HealthConfig) -> (bool, String) {
    let command = h.command.as_deref().map(str::trim).unwrap_or("");
    if command.is_empty() {
        return (false, "exec 探针缺少 command".to_string());
    }
    let timeout_ms = h.timeout_ms.max(1);

    let mut child = {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C")
            .arg(command)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        match hide_window(&mut cmd).spawn() {
            Ok(child) => child,
            Err(err) => return (false, format!("exec 启动失败: {err}")),
        }
    };

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return match status.code() {
                    Some(0) => (true, "exit 0".to_string()),
                    Some(code) => (false, format!("exit {code}")),
                    None => (false, "exec 被强制结束".to_string()),
                };
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    kill_tree(child.id());
                    reap(&mut child);
                    return (false, format!("exec 探针超时 {timeout_ms}ms"));
                }
                std::thread::sleep(POLL_INTERVAL);
            }
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                return (false, format!("exec 等待失败: {err}"));
            }
        }
    }
}

/// `taskkill /PID <pid> /T /F`，不弹窗口、不阻塞在输出上。
fn kill_tree(pid: u32) {
    let mut cmd = Command::new("taskkill");
    cmd.arg("/PID")
        .arg(pid.to_string())
        .arg("/T")
        .arg("/F")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let _ = hide_window(&mut cmd).status();
}

/// 给被 taskkill 的子进程收尸；宽限期内没退出就再强杀一次。
fn reap(child: &mut Child) {
    let deadline = Instant::now() + KILL_GRACE;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(POLL_INTERVAL),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
            Err(_) => return,
        }
    }
}

/// 超时下限 1ms：0 会让 `connect_timeout` / `set_read_timeout` 直接报参数错误。
fn timeout_of(ms: u64) -> Duration {
    Duration::from_millis(ms.max(1))
}

#[cfg(windows)]
fn hide_window(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(CREATE_NO_WINDOW)
}

#[cfg(not(windows))]
fn hide_window(cmd: &mut Command) -> &mut Command {
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn config(kind: &str) -> HealthConfig {
        HealthConfig { kind: kind.to_string(), ..HealthConfig::default() }
    }

    // ------------------------------------------------------------ parse

    #[test]
    fn parse_status_line_accepts_valid_lines() {
        assert_eq!(parse_status_line("HTTP/1.1 200 OK"), Some(200));
        assert_eq!(parse_status_line("HTTP/1.0 404 Not Found"), Some(404));
        assert_eq!(parse_status_line("HTTP/1.1 204 No Content\r\n"), Some(204));
        assert_eq!(parse_status_line("HTTP/1.1 500"), Some(500));
        assert_eq!(parse_status_line("HTTP/1.1 302 Found\r\n"), Some(302));
    }

    #[test]
    fn parse_status_line_rejects_garbage() {
        assert_eq!(parse_status_line(""), None);
        assert_eq!(parse_status_line("HTTP/"), None);
        assert_eq!(parse_status_line("HTTP/1.1"), None);
        assert_eq!(parse_status_line("GET / HTTP/1.1"), None);
        assert_eq!(parse_status_line("HTTP/1.1 20 OK"), None);
        assert_eq!(parse_status_line("HTTP/1.1 2000 OK"), None);
        assert_eq!(parse_status_line("HTTP/1.1 abc OK"), None);
        assert_eq!(parse_status_line("HTTP/1.1 2a0 OK"), None);
    }

    // ------------------------------------------------------------ tcp

    #[test]
    fn tcp_probe_sees_listening_and_closed_ports() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        let open = run(port, &config("tcp"));
        assert!(open.ok, "detail={}", open.detail);
        assert_eq!(open.detail, "TCP 已连接");

        drop(listener);
        let closed = run(port, &config("tcp"));
        assert!(!closed.ok, "detail={}", closed.detail);
        assert!(closed.detail.starts_with("TCP 连接失败"), "detail={}", closed.detail);
    }

    // ------------------------------------------------------------ http

    /// 极简 HTTP 服务：收一个连接，回一行固定文本。
    fn serve_once(listener: TcpListener, reply: &'static [u8]) -> thread::JoinHandle<()> {
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 512];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(reply);
                let _ = stream.flush();
            }
        })
    }

    #[test]
    fn http_probe_accepts_2xx() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = serve_once(listener, b"HTTP/1.1 204 No Content\r\n\r\n");

        let mut h = config("http");
        h.path = Some("/health".to_string());
        let outcome = run(port, &h);
        assert!(outcome.ok, "detail={}", outcome.detail);
        assert_eq!(outcome.detail, "HTTP 204");
        server.join().unwrap();
    }

    #[test]
    fn http_probe_rejects_unparsable_status_line() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = serve_once(listener, b"NOT-HTTP really\r\n\r\n");

        let outcome = run(port, &config("http"));
        assert!(!outcome.ok, "detail={}", outcome.detail);
        assert!(outcome.detail.contains("NOT-HTTP"), "detail={}", outcome.detail);
        server.join().unwrap();
    }

    #[test]
    fn http_probe_fails_when_port_closed() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let outcome = run(port, &config("http"));
        assert!(!outcome.ok, "detail={}", outcome.detail);
        assert!(outcome.detail.starts_with("TCP 连接失败"), "detail={}", outcome.detail);
    }

    // ------------------------------------------------------------ exec / none

    #[cfg(windows)]
    #[test]
    fn exec_probe_reports_exit_code() {
        let mut ok_cfg = config("exec");
        ok_cfg.command = Some("exit 0".to_string());
        let ok = run(0, &ok_cfg);
        assert!(ok.ok, "detail={}", ok.detail);
        assert_eq!(ok.detail, "exit 0");

        let mut bad_cfg = config("exec");
        bad_cfg.command = Some("exit 3".to_string());
        let bad = run(0, &bad_cfg);
        assert!(!bad.ok, "detail={}", bad.detail);
        assert_eq!(bad.detail, "exit 3");
    }

    #[cfg(windows)]
    #[test]
    fn exec_probe_kills_on_timeout() {
        let mut h = config("exec");
        h.command = Some("ping -n 6 127.0.0.1".to_string());
        h.timeout_ms = 400;

        let outcome = run(0, &h);
        assert!(!outcome.ok, "detail={}", outcome.detail);
        assert_eq!(outcome.detail, "exec 探针超时 400ms");
        assert!(outcome.latency_ms >= 400, "latency={}", outcome.latency_ms);
    }

    #[test]
    fn exec_probe_without_command_fails() {
        let outcome = run(0, &config("exec"));
        assert!(!outcome.ok, "detail={}", outcome.detail);
        assert!(outcome.detail.contains("command"), "detail={}", outcome.detail);
    }

    #[test]
    fn none_and_unknown_kinds_are_ok() {
        let none = run(15999, &config("none"));
        assert!(none.ok);
        assert_eq!(none.detail, "未配置探针");

        let unknown = run(15999, &config("carrier-pigeon"));
        assert!(unknown.ok);
        assert_eq!(unknown.detail, "未配置探针");
    }
}
