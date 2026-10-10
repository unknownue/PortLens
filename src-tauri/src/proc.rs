//! 进程信息与进程树停止。owner: backend-system
#![allow(dead_code)]

use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};

use serde::Serialize;

use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, FILETIME, STILL_ACTIVE};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    GetExitCodeProcess, GetProcessTimes, OpenProcess, QueryFullProcessImageNameW,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// CREATE_NO_WINDOW: keep taskkill from flashing a console window.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// Upper bound for QueryFullProcessImageNameW on long paths (\\?\ prefixed).
const EXE_BUF_LEN: usize = 32_768;

#[derive(Clone, Debug, Serialize)]
pub struct ProcInfo {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
    pub exe: String,
    pub creation_time: u64,
}

/// Look one process up in a Toolhelp snapshot; returns (image name, parent pid).
fn snapshot_entry(pid: u32) -> Option<(String, u32)> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut found = None;
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                if entry.th32ProcessID == pid {
                    let len = entry
                        .szExeFile
                        .iter()
                        .position(|&c| c == 0)
                        .unwrap_or(entry.szExeFile.len());
                    found = Some((
                        String::from_utf16_lossy(&entry.szExeFile[..len]),
                        entry.th32ParentProcessID,
                    ));
                    break;
                }
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
        found
    }
}

/// Full image path via QueryFullProcessImageNameW. Permission failures yield None, not an error.
fn exe_path(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = vec![0u16; EXE_BUF_LEN];
        let mut len = buf.len() as u32;
        let res = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(handle);
        res.ok()?;
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    }
}

/// 进程基本信息（Toolhelp32 + QueryFullProcessImageNameW）。权限不足时 exe 为空。
pub fn info(pid: u32) -> Option<ProcInfo> {
    let (name, ppid) = snapshot_entry(pid)?;
    Some(ProcInfo {
        pid,
        ppid,
        name,
        exe: exe_path(pid).unwrap_or_default(),
        creation_time: creation_time(pid).unwrap_or(0),
    })
}

/// 进程创建时间（FILETIME 计数值），用于防 PID 复用误判。
pub fn creation_time(pid: u32) -> Option<u64> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        let res = GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user);
        let _ = CloseHandle(handle);
        res.ok()?;
        Some(((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64)
    }
}

/// 进程是否存活。
pub fn is_alive(pid: u32) -> bool {
    unsafe {
        let handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(handle) => handle,
            // No handle means no such process, or it is fully protected: treat as not alive.
            Err(_) => return false,
        };
        let mut code: u32 = 0;
        let res = GetExitCodeProcess(handle, &mut code);
        let _ = CloseHandle(handle);
        res.is_ok() && code == STILL_ACTIVE.0 as u32
    }
}

/// pid 是否落在 ancestor 的进程树里（含 pid == ancestor）。
///
/// 用来判断「监听端口的进程是不是我们拉起的那个」：命令经 `cmd /C` 执行，
/// 端口通常由孙进程（node/npm/vite）持有，而我们的台账里只记着 cmd 的 PID。
pub fn is_descendant(pid: u32, ancestor: u32) -> bool {
    if pid == 0 || ancestor == 0 {
        return false;
    }
    if pid == ancestor {
        return true;
    }
    let mut current = pid;
    for _ in 0..32 {
        let Some((_, ppid)) = snapshot_entry(current) else { return false };
        if ppid == 0 || ppid == current {
            return false;
        }
        if ppid == ancestor {
            return true;
        }
        current = ppid;
    }
    false
}

/// Collapse captured taskkill output to a single trimmed line.
fn first_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

/// 停止进程树：`taskkill /PID <pid> /T`，force 时追加 `/F`。
pub fn kill_tree(pid: u32, force: bool) -> Result<(), String> {
    if pid == 0 {
        return Err("refusing to kill pid 0".into());
    }
    let mut cmd = Command::new("taskkill");
    cmd.arg("/PID")
        .arg(pid.to_string())
        .arg("/T")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);
    if force {
        cmd.arg("/F");
    }

    match cmd.output() {
        Ok(out) if out.status.success() => Ok(()),
        Ok(out) => {
            let stderr = first_line(&String::from_utf8_lossy(&out.stderr));
            let stdout = first_line(&String::from_utf8_lossy(&out.stdout));
            let detail = stderr
                .or(stdout)
                .unwrap_or_else(|| format!("exit code {:?}", out.status.code()));
            Err(format!("taskkill /PID {pid} /T failed: {detail}"))
        }
        Err(e) => Err(format!("failed to run taskkill for pid {pid}: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kill_tree_rejects_pid_zero() {
        assert!(kill_tree(0, false).is_err());
        assert!(kill_tree(0, true).is_err());
    }

    #[test]
    fn self_process_is_alive_with_info() {
        let me = std::process::id();
        assert!(is_alive(me));
        let info = info(me).expect("own process must be in the Toolhelp snapshot");
        assert_eq!(info.pid, me);
        assert!(!info.name.is_empty());
        assert!(info.exe.to_lowercase().ends_with(".exe"), "exe = {}", info.exe);
        assert!(info.creation_time > 0);
        assert_eq!(creation_time(me), Some(info.creation_time));
        assert!(info.ppid != 0);
    }

    #[test]
    fn dead_pid_is_not_alive() {
        // PIDs are multiples of 4, so this one can never exist.
        assert!(!is_alive(0xFFFF_FFFE));
        assert!(info(0xFFFF_FFFE).is_none());
        assert!(creation_time(0xFFFF_FFFE).is_none());
    }

    #[test]
    fn kill_tree_stops_a_real_child() {
        let mut child = Command::new("cmd")
            .args(["/C", "ping", "-n", "60", "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("spawn a long-running child");
        let pid = child.id();
        assert!(is_alive(pid), "child {pid} should be alive right after spawn");

        kill_tree(pid, true).expect("kill_tree on an existing process");

        let mut dead = false;
        for _ in 0..50 {
            if !is_alive(pid) {
                dead = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let _ = child.wait();
        assert!(dead, "child {pid} still alive after kill_tree");
    }
}
