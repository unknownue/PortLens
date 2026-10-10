//! 清单（services.json）与数据目录路径。

use std::collections::HashSet;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

fn default_kind() -> String {
    "tcp".into()
}
fn default_interval() -> u64 {
    2000
}
fn default_timeout() -> u64 {
    1000
}
fn default_failure() -> u32 {
    2
}
fn default_poll() -> u64 {
    1000
}
fn default_lang() -> String {
    "zh".into()
}
fn default_theme() -> String {
    "dark".into()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HealthConfig {
    #[serde(rename = "type", default = "default_kind")]
    pub kind: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(rename = "intervalMs", default = "default_interval")]
    pub interval_ms: u64,
    #[serde(rename = "timeoutMs", default = "default_timeout")]
    pub timeout_ms: u64,
    #[serde(rename = "failureThreshold", default = "default_failure")]
    pub failure_threshold: u32,
}

impl Default for HealthConfig {
    fn default() -> Self {
        Self {
            kind: default_kind(),
            path: None,
            command: None,
            interval_ms: default_interval(),
            timeout_ms: default_timeout(),
            failure_threshold: default_failure(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ServiceDef {
    pub id: String,
    pub name: String,
    pub port: u16,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub health: HealthConfig,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Settings {
    #[serde(rename = "pollIntervalMs", default = "default_poll")]
    pub poll_interval_ms: u64,
    #[serde(default = "default_lang")]
    pub language: String,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(rename = "stopManagedOnExit", default)]
    pub stop_managed_on_exit: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            poll_interval_ms: default_poll(),
            language: default_lang(),
            theme: default_theme(),
            stop_managed_on_exit: false,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Manifest {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub settings: Settings,
    #[serde(default)]
    pub services: Vec<ServiceDef>,
}

fn default_version() -> u32 {
    1
}

impl Manifest {
    pub fn defaults() -> Self {
        Self { version: 1, settings: Settings::default(), services: Vec::new() }
    }
}

pub fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("PORTLENS_DATA_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join("PortLens")
}

/// `--config <path>` 参数优先，其次 `PORTLENS_CONFIG`，最后 `%LOCALAPPDATA%\PortLens\services.json`。
pub fn manifest_path() -> PathBuf {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(pos) = args.iter().position(|a| a == "--config") {
        if let Some(value) = args.get(pos + 1) {
            return PathBuf::from(value);
        }
    }
    if let Ok(value) = std::env::var("PORTLENS_CONFIG") {
        if !value.trim().is_empty() {
            return PathBuf::from(value);
        }
    }
    data_dir().join("services.json")
}

pub fn ui_state_path() -> PathBuf {
    data_dir().join("ui.json")
}

pub fn runtime_path() -> PathBuf {
    data_dir().join("runtime.json")
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &PathBuf, what: &str) -> Result<T, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("读取{what}失败 {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{what} JSON 解析失败 {}: {e}", path.display()))
}

fn write_json<T: Serialize>(path: &PathBuf, value: &T) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败 {}: {e}", dir.display()))?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("写入失败 {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("替换失败 {}: {e}", path.display()))?;
    Ok(())
}

/// 补齐缺省值（intervalMs = 0 之类的手改清单）。
pub fn normalize(m: &mut Manifest) {
    if m.version == 0 {
        m.version = 1;
    }
    if m.settings.poll_interval_ms == 0 {
        m.settings.poll_interval_ms = default_poll();
    }
    if m.settings.language.trim().is_empty() {
        m.settings.language = default_lang();
    }
    if m.settings.theme.trim().is_empty() {
        m.settings.theme = default_theme();
    }
    for s in &mut m.services {
        if s.health.kind.trim().is_empty() {
            s.health.kind = default_kind();
        }
        s.health.kind = s.health.kind.to_ascii_lowercase();
        if s.health.interval_ms < 200 {
            s.health.interval_ms = default_interval();
        }
        if s.health.timeout_ms == 0 {
            s.health.timeout_ms = default_timeout();
        }
        if s.health.failure_threshold == 0 {
            s.health.failure_threshold = default_failure();
        }
    }
}

pub fn validate(m: &Manifest) -> Result<(), String> {
    let mut ids = HashSet::new();
    let mut ports = HashSet::new();
    for s in &m.services {
        if s.id.trim().is_empty() {
            return Err("服务 id 不能为空".into());
        }
        if s.name.trim().is_empty() {
            return Err(format!("服务 {} 的名称不能为空", s.id));
        }
        if s.port == 0 {
            return Err(format!("服务 {} 的端口无效", s.id));
        }
        if !ids.insert(s.id.clone()) {
            return Err(format!("服务 id 重复: {}", s.id));
        }
        if !ports.insert(s.port) {
            return Err(format!("端口重复: {}", s.port));
        }
        match s.health.kind.as_str() {
            "tcp" | "none" => {}
            "http" => {
                if s.health.path.as_deref().unwrap_or("").trim().is_empty() {
                    return Err(format!("服务 {} 的 http 探针缺少 path", s.id));
                }
            }
            "exec" => {
                if s.health.command.as_deref().unwrap_or("").trim().is_empty() {
                    return Err(format!("服务 {} 的 exec 探针缺少 command", s.id));
                }
            }
            other => return Err(format!("服务 {} 的探针类型不支持: {other}", s.id)),
        }
    }
    Ok(())
}

pub fn load() -> Result<Manifest, String> {
    let path = manifest_path();
    if !path.exists() {
        let m = Manifest::defaults();
        save(&m)?;
        return Ok(m);
    }
    let mut m: Manifest = read_json(&path, "清单")?;
    normalize(&mut m);
    validate(&m)?;
    Ok(m)
}

pub fn save(m: &Manifest) -> Result<(), String> {
    validate(m)?;
    write_json(&manifest_path(), m)
}

pub fn load_runtime<T: for<'de> Deserialize<'de> + Default>() -> T {
    read_json(&runtime_path(), "运行时台账").unwrap_or_default()
}

pub fn save_runtime<T: Serialize>(value: &T) {
    let _ = write_json(&runtime_path(), value);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def(id: &str, port: u16) -> ServiceDef {
        ServiceDef { id: id.into(), name: id.into(), port, command: None, cwd: None, health: HealthConfig::default() }
    }

    #[test]
    fn validate_rejects_duplicate_port_and_id() {
        let mut m = Manifest::defaults();
        m.services = vec![def("a", 15001), def("b", 15001)];
        assert!(validate(&m).is_err());
        m.services = vec![def("a", 15001), def("a", 15002)];
        assert!(validate(&m).is_err());
        m.services = vec![def("a", 15001), def("b", 15002)];
        assert!(validate(&m).is_ok());
    }

    #[test]
    fn validate_requires_probe_params() {
        let mut m = Manifest::defaults();
        let mut s = def("a", 15001);
        s.health.kind = "http".into();
        m.services = vec![s.clone()];
        assert!(validate(&m).is_err());
        s.health.path = Some("/".into());
        m.services = vec![s.clone()];
        assert!(validate(&m).is_ok());
        s.health.kind = "exec".into();
        m.services = vec![s];
        assert!(validate(&m).is_err());
    }

    #[test]
    fn normalize_fills_defaults() {
        let mut m: Manifest = serde_json::from_str(r#"{"services":[{"id":"a","name":"a","port":15001}]}"#).unwrap();
        normalize(&mut m);
        assert_eq!(m.settings.poll_interval_ms, 1000);
        assert_eq!(m.services[0].health.kind, "tcp");
        assert_eq!(m.services[0].health.interval_ms, 2000);
        assert_eq!(m.services[0].health.timeout_ms, 1000);
        assert_eq!(m.services[0].health.failure_threshold, 2);
    }

    #[test]
    fn manifest_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("services.json");
        let m = Manifest { version: 1, settings: Settings::default(), services: vec![def("x", 16000)] };
        write_json(&path, &m).unwrap();
        let back: Manifest = read_json(&path, "清单").unwrap();
        assert_eq!(back.services.len(), 1);
        assert_eq!(back.services[0].port, 16000);
    }
}
