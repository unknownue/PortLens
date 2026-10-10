//! `page.headers` 的值可以引用环境变量或文件，避免清单里落明文。
//!
//! 语法：
//! - `${env:NAME}`：取环境变量；
//! - `${file:PATH:KEY}`：从 `PATH`（形如 `.ws.env` 的 `KEY=VALUE` 文本）里取 `KEY`。
//!
//! 其它 `${...}` 形式一律报错（宁可让用户看见问题，也不要静默当成字面量发出去）。

use std::path::Path;

/// 是否是引用语法（`${...}` 且整体闭合）。
pub fn is_reference(raw: &str) -> bool {
    let trimmed = raw.trim();
    trimmed.starts_with("${") && trimmed.ends_with('}')
}

/// 把配置里的值解析成实际要发送的值。字面量原样返回。
pub fn resolve(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if !is_reference(trimmed) {
        if trimmed.contains("${") {
            return Err(format!("请求头值里的 ${{ 没有闭合: {trimmed}"));
        }
        return Ok(raw.to_string());
    }

    let inner = &trimmed[2..trimmed.len() - 1];
    if let Some(name) = inner.strip_prefix("env:") {
        let name = name.trim();
        if name.is_empty() {
            return Err("${env:} 缺少变量名".into());
        }
        return std::env::var(name)
            .map_err(|_| format!("环境变量 {name} 没有设置（请求头值引用了 ${{env:{name}}}）"));
    }
    if let Some(spec) = inner.strip_prefix("file:") {
        // PATH:KEY —— 路径本身可能含盘符冒号，所以从右边切最后一个冒号。
        let (path, key) = spec
            .rsplit_once(':')
            .ok_or_else(|| format!("${{file:...}} 需要写成 ${{file:路径:键名}}，现在是 ${{file:{spec}}}"))?;
        let path = path.trim();
        let key = key.trim();
        if path.is_empty() || key.is_empty() {
            return Err(format!("${{file:{spec}}} 的路径或键名为空"));
        }
        let text = std::fs::read_to_string(Path::new(path))
            .map_err(|e| format!("读取 {path} 失败: {e}（请求头值引用了 ${{file:{path}:{key}}}）"))?;
        return lookup_key(&text, key)
            .ok_or_else(|| format!("{path} 里没有找到 {key}"));
    }
    Err(format!("无法识别的引用语法: ${{{inner}}}（只支持 ${{env:NAME}} 与 ${{file:PATH:KEY}}）"))
}

/// 从 `KEY=VALUE` 文本里取一个键；容忍 `export ` 前缀、行内空白与成对引号。
pub fn lookup_key(text: &str, key: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line).trim_start();
        let Some((name, value)) = line.split_once('=') else { continue };
        if name.trim() != key {
            continue;
        }
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value);
        return Some(value.to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literals_pass_through() {
        assert_eq!(resolve("Bearer abc").unwrap(), "Bearer abc");
        assert_eq!(resolve("").unwrap(), "");
        assert!(!is_reference("Bearer ${abc"));
        assert!(resolve("Bearer ${abc").is_err());
    }

    #[test]
    fn env_reference_resolves_and_reports_missing() {
        std::env::set_var("PORTLENS_TEST_TOKEN", "s3cret");
        assert_eq!(resolve("${env:PORTLENS_TEST_TOKEN}").unwrap(), "s3cret");
        let err = resolve("${env:PORTLENS_TEST_TOKEN_MISSING}").unwrap_err();
        assert!(err.contains("没有设置"), "{err}");
        assert!(resolve("${env:}").is_err());
    }

    #[test]
    fn file_reference_reads_dotenv_style_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".ws.env");
        std::fs::write(
            &path,
            "# comment\nSTZBMCP_PORT=15901\nexport STZBMCP_TOKEN=\"stzbmcp-dev-2026\"\nOTHER='x'\n",
        )
        .unwrap();
        let spec = format!("${{file:{}:STZBMCP_TOKEN}}", path.display());
        assert_eq!(resolve(&spec).unwrap(), "stzbmcp-dev-2026");
        let port_spec = format!("${{file:{}:STZBMCP_PORT}}", path.display());
        assert_eq!(resolve(&port_spec).unwrap(), "15901");
        assert!(resolve(&format!("${{file:{}:NOPE}}", path.display())).is_err());
        assert!(resolve(&format!("${{file:{}:}}", path.display())).is_err());
        assert!(resolve("${file:C:\\nope\\.env:KEY}").is_err());
        assert!(resolve("${bogus:x}").is_err());
    }

    #[test]
    fn lookup_key_handles_comments_and_quoting() {
        let text = "# c\nA=1\nexport B = 2 \nC=\"three\"\nD='four'\n";
        assert_eq!(lookup_key(text, "A").unwrap(), "1");
        assert_eq!(lookup_key(text, "B").unwrap(), "2");
        assert_eq!(lookup_key(text, "C").unwrap(), "three");
        assert_eq!(lookup_key(text, "D").unwrap(), "four");
        assert!(lookup_key(text, "E").is_none());
    }
}
