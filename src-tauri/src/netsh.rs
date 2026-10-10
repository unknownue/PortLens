//! Windows 端口段诊断（动态段 + winnat/Hyper-V 排除段）。owner: backend-system
#![allow(dead_code)]

use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;

/// CREATE_NO_WINDOW: keep netsh from flashing a console window.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CACHE_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Debug, Default, Serialize)]
pub struct PortEnv {
    pub dynamic_start: u16,
    pub dynamic_count: u32,
    pub excluded: Vec<(u16, u16)>,
}

struct Cached {
    at: Instant,
    env: PortEnv,
}

fn cache() -> &'static Mutex<Option<Cached>> {
    static CACHE: OnceLock<Mutex<Option<Cached>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Run one netsh subcommand, returning stdout only on a zero exit code.
fn run_netsh(args: &[&str]) -> Option<String> {
    let out = Command::new("netsh")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Number printed after `label` and a colon (`Start Port      : 1024`).
fn number_after_label(text: &str, label: &str) -> Option<u32> {
    for line in text.lines() {
        let Some(pos) = line.find(label) else {
            continue;
        };
        let rest = &line[pos + label.len()..];
        let Some(colon) = rest.find(':') else {
            continue;
        };
        let digits: String = rest[colon + 1..]
            .trim_start()
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        if let Ok(value) = digits.parse::<u32>() {
            return Some(value);
        }
    }
    None
}

fn detect() -> PortEnv {
    let mut env = PortEnv::default();
    if let Some(text) = run_netsh(&["int", "ipv4", "show", "dynamicport", "tcp"]) {
        if let Some((start, count)) = parse_dynamic(&text) {
            env.dynamic_start = start;
            env.dynamic_count = count;
        }
    }
    if let Some(text) = run_netsh(&[
        "int",
        "ipv4",
        "show",
        "excludedportrange",
        "protocol=tcp",
    ]) {
        env.excluded = parse_excluded(&text);
    }
    env
}

/// 查询并缓存（5 分钟）动态端口段与 TCP 排除段。命令失败时返回默认值。
pub fn query() -> PortEnv {
    let cell = cache();
    let mut guard = cell.lock();
    if let Some(cached) = guard.as_ref() {
        if cached.at.elapsed() < CACHE_TTL {
            return cached.env.clone();
        }
    }
    // Hold the lock while probing: one netsh round trip, and no cache stampede.
    let env = detect();
    *guard = Some(Cached {
        at: Instant::now(),
        env: env.clone(),
    });
    env
}

/// 解析 `netsh int ipv4 show dynamicport tcp` 输出。
pub fn parse_dynamic(text: &str) -> Option<(u16, u32)> {
    let start = u16::try_from(number_after_label(text, "Start Port")?).ok()?;
    let count = number_after_label(text, "Number of Ports")?;
    Some((start, count))
}

/// 解析 `netsh int ipv4 show excludedportrange protocol=tcp` 输出。
pub fn parse_excluded(text: &str) -> Vec<(u16, u16)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.len() < 2 {
            continue;
        }
        // Header and separator lines do not start with two numbers.
        let (Ok(start), Ok(end)) = (tokens[0].parse::<u16>(), tokens[1].parse::<u16>()) else {
            continue;
        };
        out.push((start, end));
    }
    out
}

/// 端口是否落在动态段或排除段内（落在其中的端口可能被 winnat 抢占，listen 报 EACCES）。
pub fn is_risky(port: u16, env: &PortEnv) -> bool {
    if env.dynamic_count > 0 {
        let start = env.dynamic_start as u64;
        // Dynamic range is [start, start + count).
        let end = start + env.dynamic_count as u64;
        if (port as u64) >= start && (port as u64) < end {
            return true;
        }
    }
    env.excluded
        .iter()
        .any(|&(start, end)| port >= start && port <= end)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DYNAMIC_SAMPLE: &str = "Protocol tcp Dynamic Port Range\r\n\
---------------------------------\r\n\
Start Port      : 1024\r\n\
Number of Ports : 13977\r\n";

    const EXCLUDED_SAMPLE: &str = "Protocol tcp Port Exclusion Ranges\r\n\
\r\n\
Start Port    End Port\r\n\
----------    --------\r\n\
     50000        50059     *\r\n\
     51000        51009\r\n\
\r\n\
* - Administered port exclusions.\r\n";

    fn env() -> PortEnv {
        PortEnv {
            dynamic_start: 1024,
            dynamic_count: 13977,
            excluded: vec![(50000, 50059), (51000, 51009)],
        }
    }

    #[test]
    fn parse_dynamic_reads_both_labels() {
        assert_eq!(parse_dynamic(DYNAMIC_SAMPLE), Some((1024, 13977)));
        // Extra spacing around the colon is tolerated.
        assert_eq!(
            parse_dynamic("Start Port    : 49152\nNumber of Ports:  16384\n"),
            Some((49152, 16384))
        );
        assert_eq!(parse_dynamic("no such output"), None);
        assert_eq!(parse_dynamic("Start Port : 1024"), None);
    }

    #[test]
    fn parse_excluded_skips_header_and_keeps_rows() {
        assert_eq!(
            parse_excluded(EXCLUDED_SAMPLE),
            vec![(50000, 50059), (51000, 51009)]
        );
        assert!(parse_excluded("Start Port    End Port\n----------    --------\n").is_empty());
        assert!(parse_excluded("").is_empty());
    }

    #[test]
    fn is_risky_covers_dynamic_and_excluded_ranges() {
        let env = env();
        // Dynamic range is 1024..=15000 (start + count = 15001, exclusive).
        assert!(is_risky(1024, &env));
        assert!(is_risky(8080, &env));
        assert!(is_risky(15000, &env));
        assert!(!is_risky(15001, &env));
        assert!(!is_risky(1023, &env));
        // Excluded ranges are inclusive on both ends.
        assert!(is_risky(50000, &env));
        assert!(is_risky(50059, &env));
        assert!(is_risky(51005, &env));
        assert!(!is_risky(50060, &env));
        // A safe port above both ranges.
        assert!(!is_risky(15080, &env));
    }

    #[test]
    fn is_risky_is_false_for_default_env() {
        let env = PortEnv::default();
        assert!(!is_risky(0, &env));
        assert!(!is_risky(8080, &env));
        assert!(!is_risky(65535, &env));
    }

    #[test]
    fn query_is_cached_and_self_consistent() {
        let first = query();
        let second = query();
        assert_eq!(first.dynamic_start, second.dynamic_start);
        assert_eq!(first.dynamic_count, second.dynamic_count);
        assert_eq!(first.excluded, second.excluded);
        if first.dynamic_count > 0 {
            assert!(is_risky(first.dynamic_start, &first));
        }
    }
}
