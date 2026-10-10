//! TCP 监听表枚举（GetExtendedTcpTable）。owner: backend-system
#![allow(dead_code)]

use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr};

use serde::Serialize;

use windows::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
use windows::Win32::NetworkManagement::IpHelper::{GetExtendedTcpTable, TCP_TABLE_OWNER_PID_ALL};
use windows::Win32::Networking::WinSock::{AF_INET, AF_INET6};

pub const STATE_LISTEN: u32 = 2;
pub const STATE_ESTABLISHED: u32 = 5;

/// 表头 dwNumEntries 占 4 字节。
const HEADER_LEN: usize = 4;
/// sizeof(MIB_TCPROW_OWNER_PID)
const V4_ROW_LEN: usize = 24;
/// sizeof(MIB_TCP6ROW_OWNER_PID)
const V6_ROW_LEN: usize = 56;
/// Headroom for a table that grows between the size probe and the real call.
const SIZE_HEADROOM: usize = 64;

/// 一条 TCP 表行（IPv4 与 IPv6 统一表示）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RawRow {
    pub local_port: u16,
    pub remote_port: u16,
    pub pid: u32,
    pub state: u32,
}

/// 正在监听的端口（established 为该本地端口上 ESTABLISHED 连接数）。
#[derive(Clone, Debug, Serialize)]
pub struct Listener {
    pub port: u16,
    pub addr: String,
    pub pid: u32,
    pub established: u32,
}

/// Decode a port dword field: its low 16 bits hold the port in network byte order.
#[inline]
fn port_at(row: &[u8], off: usize) -> u16 {
    u16::from_be_bytes([row[off], row[off + 1]])
}

#[inline]
fn dword_at(row: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([row[off], row[off + 1], row[off + 2], row[off + 3]])
}

/// Decode rows together with the local address they are bound to (IPv4 dotted, IPv6 bracketed).
fn decode_full(buf: &[u8], v6: bool) -> Vec<(RawRow, String)> {
    let row_len = if v6 { V6_ROW_LEN } else { V4_ROW_LEN };
    if buf.len() < HEADER_LEN {
        return Vec::new();
    }
    let declared = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    let available = (buf.len() - HEADER_LEN) / row_len;
    let count = declared.min(available);
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let row = &buf[HEADER_LEN + i * row_len..HEADER_LEN + (i + 1) * row_len];
        let (addr, local_port, remote_port, pid, state) = if v6 {
            let mut octets = [0u8; 16];
            octets.copy_from_slice(&row[0..16]);
            (
                format!("[{}]", Ipv6Addr::from(octets)),
                port_at(row, 20),
                port_at(row, 44),
                dword_at(row, 52),
                dword_at(row, 48),
            )
        } else {
            (
                Ipv4Addr::new(row[4], row[5], row[6], row[7]).to_string(),
                port_at(row, 8),
                port_at(row, 16),
                dword_at(row, 20),
                dword_at(row, 0),
            )
        };
        out.push((
            RawRow {
                local_port,
                remote_port,
                pid,
                state,
            },
            addr,
        ));
    }
    out
}

/// 解码 MIB_TCPTABLE_OWNER_PID / MIB_TCP6TABLE_OWNER_PID 缓冲区。
/// 头部 4 字节是 dwNumEntries，之后逐行步进（v4 = 24 字节，v6 = 56 字节）。
pub fn decode_rows(buf: &[u8], v6: bool) -> Vec<RawRow> {
    decode_full(buf, v6)
        .into_iter()
        .map(|(row, _)| row)
        .collect()
}

/// Fetch one table buffer: probe the required length with a null pointer, then allocate and retry.
/// `ERROR_INSUFFICIENT_BUFFER` from the probe is the normal path, not a failure.
fn fetch_table(v6: bool) -> Option<Vec<u8>> {
    let family = if v6 { AF_INET6.0 as u32 } else { AF_INET.0 as u32 };
    let mut size: u32 = 0;
    let probe = unsafe {
        GetExtendedTcpTable(
            None,
            &mut size,
            false,
            family,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        )
    };
    if probe != ERROR_INSUFFICIENT_BUFFER.0 && probe != NO_ERROR.0 {
        return None;
    }
    if size == 0 {
        return None;
    }
    let mut buf = vec![0u8; size as usize + SIZE_HEADROOM];
    let mut written = buf.len() as u32;
    let ret = unsafe {
        GetExtendedTcpTable(
            Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
            &mut written,
            false,
            family,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        )
    };
    if ret != NO_ERROR.0 {
        return None;
    }
    if (written as usize) <= buf.len() {
        buf.truncate(written as usize);
    }
    Some(buf)
}

/// Keep one LISTEN entry per port, preferring the IPv4 row, and count ESTABLISHED rows per port.
fn merge_listeners(rows: &[(RawRow, String, bool)]) -> Vec<Listener> {
    let mut established: HashMap<u16, u32> = HashMap::new();
    for (row, _, _) in rows {
        if row.state == STATE_ESTABLISHED {
            *established.entry(row.local_port).or_insert(0) += 1;
        }
    }

    let mut out: Vec<Listener> = Vec::new();
    let mut seen: HashMap<u16, (usize, bool)> = HashMap::new();
    for (row, addr, v6) in rows {
        if row.state != STATE_LISTEN {
            continue;
        }
        match seen.get(&row.local_port).copied() {
            None => {
                seen.insert(row.local_port, (out.len(), *v6));
                out.push(Listener {
                    port: row.local_port,
                    addr: addr.clone(),
                    pid: row.pid,
                    established: 0,
                });
            }
            Some((idx, was_v6)) => {
                if was_v6 && !*v6 {
                    out[idx].addr = addr.clone();
                    out[idx].pid = row.pid;
                    seen.insert(row.local_port, (idx, false));
                }
            }
        }
    }

    for listener in out.iter_mut() {
        listener.established = established.get(&listener.port).copied().unwrap_or(0);
    }
    out.sort_by_key(|l| l.port);
    out
}

/// 当前全部 TCP 监听端口（IPv4 + IPv6，同一端口只保留一条）。
pub fn list_tcp() -> Vec<Listener> {
    let mut rows: Vec<(RawRow, String, bool)> = Vec::new();
    if let Some(buf) = fetch_table(false) {
        rows.extend(decode_full(&buf, false).into_iter().map(|(r, a)| (r, a, false)));
    }
    if let Some(buf) = fetch_table(true) {
        rows.extend(decode_full(&buf, true).into_iter().map(|(r, a)| (r, a, true)));
    }
    merge_listeners(&rows)
}

/// 指定端口的监听进程 PID。
pub fn owner_pid(port: u16) -> Option<u32> {
    list_tcp().into_iter().find(|l| l.port == port).map(|l| l.pid)
}

/// 端口是否处于监听。
pub fn is_listening(port: u16) -> bool {
    list_tcp().iter().any(|l| l.port == port)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialise one MIB_TCPROW_OWNER_PID exactly as the API lays it out in memory.
    fn push_v4_row(
        buf: &mut Vec<u8>,
        state: u32,
        local: [u8; 4],
        local_port: u16,
        remote: [u8; 4],
        remote_port: u16,
        pid: u32,
    ) {
        buf.extend_from_slice(&state.to_le_bytes());
        buf.extend_from_slice(&local);
        buf.extend_from_slice(&[(local_port >> 8) as u8, local_port as u8, 0, 0]);
        buf.extend_from_slice(&remote);
        buf.extend_from_slice(&[(remote_port >> 8) as u8, remote_port as u8, 0, 0]);
        buf.extend_from_slice(&pid.to_le_bytes());
    }

    /// Serialise one MIB_TCP6ROW_OWNER_PID.
    fn push_v6_row(
        buf: &mut Vec<u8>,
        state: u32,
        local: [u8; 16],
        local_port: u16,
        remote: [u8; 16],
        remote_port: u16,
        pid: u32,
    ) {
        buf.extend_from_slice(&local);
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(&[(local_port >> 8) as u8, local_port as u8, 0, 0]);
        buf.extend_from_slice(&remote);
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(&[(remote_port >> 8) as u8, remote_port as u8, 0, 0]);
        buf.extend_from_slice(&state.to_le_bytes());
        buf.extend_from_slice(&pid.to_le_bytes());
    }

    fn four(count: u32) -> Vec<u8> {
        count.to_le_bytes().to_vec()
    }

    #[test]
    fn decode_v4_two_listen_and_one_established() {
        let mut buf = four(3);
        // 127.0.0.1:8080 LISTEN
        push_v4_row(
            &mut buf,
            STATE_LISTEN,
            [127, 0, 0, 1],
            8080,
            [0, 0, 0, 0],
            0,
            4242,
        );
        // 0.0.0.0:3000 LISTEN
        push_v4_row(
            &mut buf,
            STATE_LISTEN,
            [0, 0, 0, 0],
            3000,
            [0, 0, 0, 0],
            0,
            1717,
        );
        // 127.0.0.1:8080 <- 127.0.0.1:51000 ESTABLISHED
        push_v4_row(
            &mut buf,
            STATE_ESTABLISHED,
            [127, 0, 0, 1],
            8080,
            [127, 0, 0, 1],
            51000,
            4242,
        );
        assert_eq!(buf.len(), HEADER_LEN + 3 * V4_ROW_LEN);

        let rows = decode_rows(&buf, false);
        assert_eq!(
            rows,
            vec![
                RawRow {
                    local_port: 8080,
                    remote_port: 0,
                    pid: 4242,
                    state: STATE_LISTEN
                },
                RawRow {
                    local_port: 3000,
                    remote_port: 0,
                    pid: 1717,
                    state: STATE_LISTEN
                },
                RawRow {
                    local_port: 8080,
                    remote_port: 51000,
                    pid: 4242,
                    state: STATE_ESTABLISHED
                },
            ]
        );
    }

    #[test]
    fn decode_v6_rows_and_bracketed_addr() {
        let mut buf = four(2);
        let mut local = [0u8; 16];
        local[15] = 1; // ::1
        push_v6_row(
            &mut buf,
            STATE_LISTEN,
            local,
            8080,
            [0u8; 16],
            0,
            900,
        );
        push_v6_row(
            &mut buf,
            STATE_ESTABLISHED,
            local,
            8080,
            local,
            51000,
            900,
        );
        assert_eq!(buf.len(), HEADER_LEN + 2 * V6_ROW_LEN);

        let decoded = decode_full(&buf, true);
        assert_eq!(decoded.len(), 2);
        assert_eq!(decoded[0].1, "[::1]");
        assert_eq!(decoded[1].1, "[::1]");
        assert_eq!(
            decoded[0].0,
            RawRow {
                local_port: 8080,
                remote_port: 0,
                pid: 900,
                state: STATE_LISTEN
            }
        );
        assert_eq!(decoded[1].0.remote_port, 51000);

        let rows = decode_rows(&buf, true);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1].state, STATE_ESTABLISHED);
    }

    #[test]
    fn decode_is_defensive_about_lengths() {
        assert!(decode_rows(&[], false).is_empty());
        assert!(decode_rows(&[1, 0, 0], false).is_empty());
        // Declared count exceeds the available rows: decode only whole rows.
        let mut buf = four(9);
        push_v4_row(
            &mut buf,
            STATE_LISTEN,
            [0, 0, 0, 0],
            80,
            [0, 0, 0, 0],
            0,
            4,
        );
        buf.extend_from_slice(&[0u8; 7]);
        assert_eq!(decode_rows(&buf, false).len(), 1);
        // Empty table header only.
        assert!(decode_rows(&four(0), false).is_empty());
    }

    #[test]
    fn merge_prefers_ipv4_and_counts_established() {
        let listen6 = RawRow {
            local_port: 8080,
            remote_port: 0,
            pid: 11,
            state: STATE_LISTEN,
        };
        let listen4 = RawRow {
            local_port: 8080,
            remote_port: 0,
            pid: 22,
            state: STATE_LISTEN,
        };
        let est4 = RawRow {
            local_port: 8080,
            remote_port: 51000,
            pid: 22,
            state: STATE_ESTABLISHED,
        };
        let listen_other = RawRow {
            local_port: 3000,
            remote_port: 0,
            pid: 33,
            state: STATE_LISTEN,
        };
        let rows = vec![
            (listen6, "[::]:8080".to_string(), true),
            (listen4, "0.0.0.0".to_string(), false),
            (est4, "127.0.0.1".to_string(), false),
            (listen_other, "127.0.0.1".to_string(), false),
        ];
        let out = merge_listeners(&rows);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].port, 3000);
        assert_eq!(out[0].established, 0);
        assert_eq!(out[1].port, 8080);
        assert_eq!(out[1].addr, "0.0.0.0");
        assert_eq!(out[1].pid, 22);
        assert_eq!(out[1].established, 1);
    }

    #[test]
    fn list_tcp_reports_our_own_listener() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let port = listener.local_addr().expect("local addr").port();
        let me = std::process::id();

        let found = list_tcp().into_iter().find(|l| l.port == port);
        let found = found.expect("own listening port must be in the TCP table");
        assert_eq!(found.pid, me);
        assert_eq!(found.addr, "127.0.0.1");
        assert_eq!(found.established, 0);
        assert_eq!(owner_pid(port), Some(me));
        assert!(is_listening(port));
        drop(listener);
    }

    #[test]
    fn owner_pid_and_is_listening_clear_after_unbind() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let port = listener.local_addr().expect("local addr").port();
        assert!(is_listening(port));

        drop(listener);
        let mut gone = false;
        for _ in 0..40 {
            if !is_listening(port) {
                gone = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(gone, "port {port} still reported as listening after unbind");
        assert_eq!(owner_pid(port), None);
    }
}
