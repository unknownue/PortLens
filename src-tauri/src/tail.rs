//! 日志文件 tail-follow：外部（非本工具启动）服务与自建服务共用一条通路。

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use encoding_rs::Encoding;

use crate::config::{LogSource, ServiceDef};
use crate::logs::LogStore;

/// 首次挂上文件时最多回看的字节数（相当于 `tail -n` 的种子，避免把整份大日志灌进环形缓冲）。
const SEED_BYTES: u64 = 64 * 1024;
/// 一直没有换行的超长行上限，超过就强制断行，避免缓冲无限增长。
const MAX_PENDING: usize = 64 * 1024;

/// `*` / `?` 通配匹配（只用文件名，够用且零依赖）。
pub fn wildcard_match(pattern: &str, name: &str) -> bool {
    let pat: Vec<char> = pattern.chars().collect();
    let text: Vec<char> = name.chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut mark) = (usize::MAX, 0usize);
    while ti < text.len() {
        if pi < pat.len() && (pat[pi] == '?' || pat[pi] == text[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < pat.len() && pat[pi] == '*' {
            star = pi;
            pi += 1;
            mark = ti;
        } else if star != usize::MAX {
            pi = star + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < pat.len() && pat[pi] == '*' {
        pi += 1;
    }
    pi == pat.len()
}

/// 解析日志路径：没有通配符就是它自己；有通配符时在所在目录里挑修改时间最新的匹配文件。
pub fn resolve_path(pattern: &str) -> Option<PathBuf> {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return None;
    }
    if !pattern.contains('*') && !pattern.contains('?') {
        return Some(PathBuf::from(pattern));
    }

    let raw = Path::new(pattern);
    let file_pattern = raw.file_name()?.to_string_lossy().to_string();
    let dir = match raw.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
        _ => PathBuf::from("."),
    };

    let mut best: Option<(SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(&dir).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !wildcard_match(&file_pattern, &name) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        if best.as_ref().map(|(time, _)| modified > *time).unwrap_or(true) {
            best = Some((modified, entry.path()));
        }
    }
    best.map(|(_, path)| path)
}

fn terminator(encoding: &'static Encoding) -> &'static [u8] {
    if encoding == encoding_rs::UTF_16LE {
        &[0x0A, 0x00]
    } else if encoding == encoding_rs::UTF_16BE {
        &[0x00, 0x0A]
    } else {
        &[0x0A]
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|window| window == needle)
}

fn decode_line(encoding: &'static Encoding, bytes: &[u8]) -> String {
    let (text, _had_errors) = encoding.decode_without_bom_handling(bytes);
    text.trim_start_matches('\u{feff}').trim_end_matches(['\r', '\n']).to_string()
}

/// 单个日志文件的跟随器：只认「新增的字节」，处理截断与轮转。
pub struct FileTailer {
    pattern: String,
    encoding: &'static Encoding,
    current: Option<PathBuf>,
    offset: u64,
    pending: Vec<u8>,
    /// 从文件中段开始时，第一段残缺内容要丢掉。
    skip_first_line: bool,
}

impl FileTailer {
    pub fn new(source: &LogSource) -> Self {
        let encoding = Encoding::for_label(source.encoding_label().as_bytes()).unwrap_or(encoding_rs::UTF_8);
        Self {
            pattern: source.file_pattern().unwrap_or_default().to_string(),
            encoding,
            current: None,
            offset: 0,
            pending: Vec::new(),
            skip_first_line: false,
        }
    }

    pub fn pattern(&self) -> &str {
        &self.pattern
    }

    /// 读一次增量；返回新落的行数（行已写进 `logs`）。
    pub fn poll(&mut self, id: &str, logs: &LogStore) -> usize {
        let Some(path) = resolve_path(&self.pattern) else { return 0 };
        let rotated = self.current.as_deref() != Some(path.as_path());
        let Ok(mut file) = File::open(&path) else { return 0 };
        let len = file.metadata().map(|meta| meta.len()).unwrap_or(0);

        if rotated {
            self.current = Some(path);
            self.pending.clear();
            let mut start = len.saturating_sub(SEED_BYTES);
            if self.encoding == encoding_rs::UTF_16LE || self.encoding == encoding_rs::UTF_16BE {
                start -= start % 2;
            }
            self.offset = start;
            self.skip_first_line = start > 0;
        } else if len < self.offset {
            // 文件被截断（清空/重写）：从头再读。
            self.offset = 0;
            self.pending.clear();
            self.skip_first_line = false;
        }

        if len <= self.offset {
            return 0;
        }
        if file.seek(SeekFrom::Start(self.offset)).is_err() {
            return 0;
        }
        let mut buf = Vec::with_capacity((len - self.offset).min(1 << 20) as usize);
        if file.take(len - self.offset).read_to_end(&mut buf).is_err() {
            return 0;
        }
        self.offset += buf.len() as u64;
        self.pending.extend_from_slice(&buf);

        let term = terminator(self.encoding);
        let mut lines: Vec<String> = Vec::new();
        while let Some(pos) = find(&self.pending, term) {
            let raw = &self.pending[..pos];
            if self.skip_first_line {
                self.skip_first_line = false;
            } else {
                lines.push(decode_line(self.encoding, raw));
            }
            self.pending.drain(..pos + term.len());
        }
        if !self.skip_first_line && self.pending.len() > MAX_PENDING {
            let raw = std::mem::take(&mut self.pending);
            lines.push(decode_line(self.encoding, &raw));
        }

        for line in &lines {
            logs.push(id, line);
        }
        lines.len()
    }
}

/// 按当前清单维护「服务 id -> 文件跟随器」，清单变了就增删。
#[derive(Default)]
pub struct TailRegistry {
    tailers: HashMap<String, (String, FileTailer)>,
}

impl TailRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn sync(&mut self, defs: &[ServiceDef]) {
        let mut wanted: HashMap<String, String> = HashMap::new();
        for def in defs {
            if let Some(pattern) = def.log_source.file_pattern() {
                wanted.insert(def.id.clone(), pattern.to_string());
            }
        }
        for (id, pattern) in &wanted {
            let stale = self
                .tailers
                .get(id)
                .map(|(current, _)| current != pattern)
                .unwrap_or(true);
            if stale {
                let source = defs
                    .iter()
                    .find(|def| &def.id == id)
                    .map(|def| def.log_source.clone())
                    .unwrap_or_default();
                self.tailers
                    .insert(id.clone(), (pattern.clone(), FileTailer::new(&source)));
            }
        }
        self.tailers.retain(|id, _| wanted.contains_key(id));
    }

    pub fn poll_all(&mut self, logs: &LogStore) -> usize {
        self.tailers
            .iter_mut()
            .map(|(id, (_, tailer))| tailer.poll(id, logs))
            .sum()
    }

    pub fn len(&self) -> usize {
        self.tailers.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tailers.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{HealthConfig, LogSource};

    fn file_source(pattern: &str, encoding: Option<&str>) -> LogSource {
        LogSource {
            kind: "file".into(),
            path: Some(pattern.to_string()),
            encoding: encoding.map(str::to_string),
        }
    }

    fn def_with(id: &str, source: LogSource) -> ServiceDef {
        ServiceDef {
            id: id.into(),
            name: id.into(),
            port: 15999,
            command: None,
            cwd: None,
            health: HealthConfig::default(),
            log_source: source,
        }
    }

    fn write(path: &Path, text: &str) {
        std::fs::write(path, text).expect("write log file");
    }

    fn append(path: &Path, text: &str) {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new().append(true).open(path).expect("open log file");
        file.write_all(text.as_bytes()).expect("append log file");
    }

    #[test]
    fn wildcard_matches_expected_names() {
        assert!(wildcard_match("app*.log", "app-2026-10-10.log"));
        assert!(wildcard_match("*.log", "server.log"));
        assert!(wildcard_match("app?.log", "app1.log"));
        assert!(!wildcard_match("app?.log", "app12.log"));
        assert!(!wildcard_match("*.log", "server.txt"));
        assert!(wildcard_match("server.log", "server.log"));
        assert!(wildcard_match("*", "anything"));
    }

    #[test]
    fn resolve_path_picks_newest_match() {
        let dir = tempfile::tempdir().expect("tempdir");
        let older = dir.path().join("app-1.log");
        let newer = dir.path().join("app-2.log");
        write(&older, "old\n");
        std::thread::sleep(std::time::Duration::from_millis(20));
        write(&newer, "new\n");
        let resolved = resolve_path(&format!("{}\\app-*.log", dir.path().display())).expect("resolve");
        assert_eq!(resolved, newer);

        let literal = dir.path().join("plain.log");
        assert_eq!(resolve_path(&literal.to_string_lossy()), Some(literal));
        assert_eq!(resolve_path("   "), None);
    }

    #[test]
    fn tails_only_new_lines_and_buffers_partial() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("plain.log");
        write(&path, "first\n");
        let store = LogStore::new();
        let mut tailer = FileTailer::new(&file_source(&path.to_string_lossy(), None));

        assert_eq!(tailer.poll("svc", &store), 1);
        assert_eq!(store.tail("svc", 10), vec!["first".to_string()]);

        // 半行不入库
        append(&path, "sec");
        assert_eq!(tailer.poll("svc", &store), 0);
        assert_eq!(store.tail("svc", 10).len(), 1);

        // 补上换行才落一行
        append(&path, "ond\nthird\n");
        assert_eq!(tailer.poll("svc", &store), 2);
        assert_eq!(
            store.tail("svc", 10),
            vec!["first".to_string(), "second".to_string(), "third".to_string()]
        );

        // 没有新内容时不再重复
        assert_eq!(tailer.poll("svc", &store), 0);
    }

    #[test]
    fn truncated_file_is_read_from_the_start_again() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("trunc.log");
        write(&path, "one\ntwo\n");
        let store = LogStore::new();
        let mut tailer = FileTailer::new(&file_source(&path.to_string_lossy(), None));
        assert_eq!(tailer.poll("svc", &store), 2);

        write(&path, "reset\n");
        assert_eq!(tailer.poll("svc", &store), 1);
        assert_eq!(store.tail("svc", 10).last().map(String::as_str), Some("reset"));
    }

    #[test]
    fn rotation_to_a_new_glob_match_is_followed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let first = dir.path().join("run-1.log");
        write(&first, "old-run\n");
        let pattern = format!("{}\\run-*.log", dir.path().display());
        let store = LogStore::new();
        let mut tailer = FileTailer::new(&file_source(&pattern, None));
        assert_eq!(tailer.poll("svc", &store), 1);

        std::thread::sleep(std::time::Duration::from_millis(20));
        let second = dir.path().join("run-2.log");
        write(&second, "new-run\n");
        assert_eq!(tailer.poll("svc", &store), 1);
        assert_eq!(store.tail("svc", 10).last().map(String::as_str), Some("new-run"));
    }

    #[test]
    fn decodes_gbk_and_utf16_lines() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = LogStore::new();

        let gbk_path = dir.path().join("gbk.log");
        std::fs::write(&gbk_path, [0xD6, 0xD0, 0xCE, 0xC4, 0x0A]).expect("write gbk");
        let mut gbk = FileTailer::new(&file_source(&gbk_path.to_string_lossy(), Some("gbk")));
        assert_eq!(gbk.poll("gbk", &store), 1);
        assert_eq!(store.tail("gbk", 5), vec!["中文".to_string()]);

        let utf16_path = dir.path().join("utf16.log");
        std::fs::write(&utf16_path, [0x68, 0x00, 0x69, 0x00, 0x0A, 0x00]).expect("write utf16");
        let mut utf16 = FileTailer::new(&file_source(&utf16_path.to_string_lossy(), Some("utf-16le")));
        assert_eq!(utf16.poll("u16", &store), 1);
        assert_eq!(store.tail("u16", 5), vec!["hi".to_string()]);
    }

    #[test]
    fn big_file_seeds_from_the_tail() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("big.log");
        let mut text = String::new();
        for index in 0..20000 {
            text.push_str(&format!("line-{index}\n"));
        }
        write(&path, &text);
        let store = LogStore::new();
        let mut tailer = FileTailer::new(&file_source(&path.to_string_lossy(), None));
        let seeded = tailer.poll("svc", &store);
        assert!(seeded > 100 && seeded < 20000, "seeded {seeded} lines");
        // 种子之后追加的行也要能跟上
        append(&path, "after-seed\n");
        assert_eq!(tailer.poll("svc", &store), 1);
        assert_eq!(store.tail("svc", 5).last().map(String::as_str), Some("after-seed"));
    }

    #[test]
    fn registry_tracks_manifest_changes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("reg.log");
        write(&path, "hello\n");
        let store = LogStore::new();
        let mut registry = TailRegistry::new();

        registry.sync(&[def_with("a", file_source(&path.to_string_lossy(), None))]);
        assert_eq!(registry.len(), 1);
        assert_eq!(registry.poll_all(&store), 1);

        // 换成 process 来源 -> 跟随器被移除
        registry.sync(&[def_with("a", LogSource::default())]);
        assert!(registry.is_empty());

        // 两个服务各自跟随
        let second = dir.path().join("reg2.log");
        write(&second, "world\n");
        registry.sync(&[
            def_with("a", file_source(&path.to_string_lossy(), None)),
            def_with("b", file_source(&second.to_string_lossy(), None)),
        ]);
        assert_eq!(registry.len(), 2);
        assert_eq!(registry.poll_all(&store), 2);
        // 重新挂上的跟随器把小文件从头再读一遍（64 KiB 的种子规则只对大文件生效）：
        // a 的 "hello" 因此出现两次，b 只读了一次。
        assert_eq!(store.tail("a", 5), vec!["hello".to_string(), "hello".to_string()]);
        assert_eq!(store.tail("b", 5), vec!["world".to_string()]);
    }

    #[test]
    fn missing_file_is_silent_and_late_file_is_picked_up() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("late.log");
        let store = LogStore::new();
        let mut tailer = FileTailer::new(&file_source(&path.to_string_lossy(), None));
        assert_eq!(tailer.poll("svc", &store), 0);
        write(&path, "arrived\n");
        assert_eq!(tailer.poll("svc", &store), 1);
        assert_eq!(store.tail("svc", 5), vec!["arrived".to_string()]);
    }
}

