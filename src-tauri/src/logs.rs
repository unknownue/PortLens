//! 每个服务的输出环形缓冲 + 待发送队列（事件批量用）。

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use parking_lot::Mutex;

const RING_LIMIT: usize = 2000;
const FRESH_LIMIT: usize = 500;

#[derive(Clone, Default)]
pub struct LogStore {
    inner: Arc<Mutex<Inner>>,
}

#[derive(Default)]
struct Inner {
    ring: HashMap<String, VecDeque<String>>,
    fresh: HashMap<String, VecDeque<String>>,
}

impl LogStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&self, id: &str, line: &str) {
        let mut guard = self.inner.lock();
        let ring = guard.ring.entry(id.to_string()).or_default();
        if ring.len() >= RING_LIMIT {
            ring.pop_front();
        }
        ring.push_back(line.to_string());

        let fresh = guard.fresh.entry(id.to_string()).or_default();
        if fresh.len() >= FRESH_LIMIT {
            fresh.pop_front();
        }
        fresh.push_back(line.to_string());
    }

    pub fn tail(&self, id: &str, limit: usize) -> Vec<String> {
        let guard = self.inner.lock();
        guard
            .ring
            .get(id)
            .map(|ring| ring.iter().skip(ring.len().saturating_sub(limit)).cloned().collect())
            .unwrap_or_default()
    }

    /// 取走尚未发送的行（monitor 每 200ms 批量发事件）。
    pub fn drain_new(&self, id: &str) -> Vec<String> {
        let mut guard = self.inner.lock();
        guard.fresh.get_mut(id).map(|fresh| fresh.drain(..).collect()).unwrap_or_default()
    }

    pub fn clear(&self, id: &str) {
        let mut guard = self.inner.lock();
        guard.ring.remove(id);
        guard.fresh.remove(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_is_bounded_and_fresh_is_drained() {
        let store = LogStore::new();
        for i in 0..(RING_LIMIT + 10) {
            store.push("a", &format!("line {i}"));
        }
        assert_eq!(store.tail("a", 5).len(), 5);
        assert_eq!(store.tail("a", RING_LIMIT + 100).len(), RING_LIMIT);
        assert!(!store.drain_new("a").is_empty());
        assert!(store.drain_new("a").is_empty());
    }

    #[test]
    fn tail_and_clear() {
        let store = LogStore::new();
        store.push("b", "one");
        store.push("b", "two");
        assert_eq!(store.tail("b", 10), vec!["one".to_string(), "two".to_string()]);
        store.clear("b");
        assert!(store.tail("b", 10).is_empty());
    }
}
