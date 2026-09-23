//! 前景視窗觀測＝ `screentime/observer.ps1`：每秒一列 JSON `{name, path, pid, idleMs}`。
//! stdout 寫不出去（VoiceInk 已經不在了）就結束，不當孤兒。

use std::io::Write;
use std::time::Duration;

use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

use crate::detail::image_path;
use crate::procs;

fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn idle_ms() -> u32 {
    let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    if !unsafe { GetLastInputInfo(&mut info) }.as_bool() {
        return 0;
    }
    unsafe { GetTickCount() }.wrapping_sub(info.dwTime)
}

fn file_stem(path: &str) -> String {
    std::path::Path::new(path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

pub fn line(proc_buf: &mut Vec<u8>) -> String {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(GetForegroundWindow(), Some(&mut pid)) };
    let (mut name, mut path) = (String::new(), String::new());
    if pid > 0 {
        path = image_path(pid);
        name = if path.is_empty() {
            // 開不了的程序（受保護的）退回程序清單裡的映像檔名，同 Get-Process 的 ProcessName
            procs::snapshot(proc_buf)
                .into_iter()
                .find(|p| p.pid == pid)
                .map(|p| file_stem(&p.image))
                .unwrap_or_default()
        } else {
            file_stem(&path)
        };
    }
    format!(
        "{{\"name\":{},\"path\":{},\"pid\":{pid},\"idleMs\":{}}}",
        json_str(&name), json_str(&path), idle_ms()
    )
}

pub fn run() {
    let mut proc_buf = Vec::new();
    let stdout = std::io::stdout();
    loop {
        let row = line(&mut proc_buf);
        let mut out = stdout.lock();
        if writeln!(out, "{row}").and_then(|_| out.flush()).is_err() {
            return;
        }
        drop(out);
        std::thread::sleep(Duration::from_secs(1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_escaping() {
        assert_eq!(json_str(r"C:\a"), r#""C:\\a""#);
        assert_eq!(json_str("a\"b\n"), r#""a\"b\u000a""#);
    }

    #[test]
    fn line_is_json() {
        let row = line(&mut Vec::new());
        assert!(row.starts_with("{\"name\":") && row.ends_with('}'), "{row}");
        assert!(row.contains("\"idleMs\":"));
    }
}
