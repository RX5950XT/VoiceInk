//! 系統 ConPTY（kernel32 的 CreatePseudoConsole，跟 node-pty 預設的 `useConptyDll: false` 同一套）。
//! handle 一律存成 isize：windows crate 的 HANDLE 是裸指標，不能跨執行緒。

use std::ffi::c_void;
use std::io;

use windows::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0};
use windows::Win32::Storage::FileSystem::{ReadFile, WriteFile};
use windows::Win32::System::Console::{
    COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON, ResizePseudoConsole,
};
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::Threading::{
    CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DeleteProcThreadAttributeList,
    EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, INFINITE, InitializeProcThreadAttributeList,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    UpdateProcThreadAttribute, WaitForSingleObject,
};
use windows::core::{PCWSTR, PWSTR};

const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE: usize = 0x0002_0016;

fn h(v: isize) -> HANDLE {
    HANDLE(v as *mut c_void)
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub struct Pty {
    pub pid: u32,
    hpc: isize,
    input: isize,
    pub output: isize,
    pub process: isize,
}

fn coord(cols: u16, rows: u16) -> COORD {
    COORD { X: cols as i16, Y: rows as i16 }
}

/// node-pty 的 `argsToCommandLine`：含空白（或空字串）才加引號，引號前的反斜線加倍
pub fn command_line(file: &str, args: &[String]) -> String {
    let mut out = String::new();
    for (i, arg) in std::iter::once(file).chain(args.iter().map(String::as_str)).enumerate() {
        if i > 0 {
            out.push(' ');
        }
        let quoted = arg.starts_with('"') && arg.ends_with('"') && arg.len() > 1;
        let quote = arg.is_empty() || (arg.contains([' ', '\t']) && !quoted);
        if quote {
            out.push('"');
        }
        let mut backslashes = 0;
        for c in arg.chars() {
            match c {
                '\\' => backslashes += 1,
                '"' => {
                    out.push_str(&"\\".repeat(backslashes * 2 + 1));
                    out.push('"');
                    backslashes = 0;
                }
                _ => {
                    out.push_str(&"\\".repeat(backslashes));
                    backslashes = 0;
                    out.push(c);
                }
            }
        }
        if quote {
            out.push_str(&"\\".repeat(backslashes * 2));
            out.push('"');
        } else {
            out.push_str(&"\\".repeat(backslashes));
        }
    }
    out
}

/// `KEY=VALUE\0…\0\0`，照 CreateProcess 的要求不分大小寫排序
fn env_block(env: &[(String, String)]) -> Vec<u16> {
    let mut pairs: Vec<&(String, String)> = env.iter().collect();
    pairs.sort_by_key(|(k, _)| k.to_uppercase());
    let mut out = Vec::new();
    for (k, v) in pairs {
        out.extend(format!("{k}={v}").encode_utf16());
        out.push(0);
    }
    out.push(0);
    out
}

impl Pty {
    pub fn spawn(file: &str, args: &[String], cwd: &str, env: &[(String, String)], cols: u16, rows: u16) -> io::Result<Pty> {
        unsafe {
            let (mut in_read, mut in_write, mut out_read, mut out_write) =
                (HANDLE::default(), HANDLE::default(), HANDLE::default(), HANDLE::default());
            CreatePipe(&mut in_read, &mut in_write, None, 0)?;
            CreatePipe(&mut out_read, &mut out_write, None, 0)?;
            let hpc = CreatePseudoConsole(coord(cols, rows), in_read, out_write, 0);
            // conhost 已經複製了自己那一端
            let _ = CloseHandle(in_read);
            let _ = CloseHandle(out_write);
            let hpc = match hpc {
                Ok(hpc) => hpc,
                Err(e) => {
                    let _ = CloseHandle(in_write);
                    let _ = CloseHandle(out_read);
                    return Err(e.into());
                }
            };
            let fail = |e: io::Error| {
                ClosePseudoConsole(hpc);
                let _ = CloseHandle(in_write);
                let _ = CloseHandle(out_read);
                e
            };

            let mut size = 0usize;
            let _ = InitializeProcThreadAttributeList(None, 1, None, &mut size);
            let mut attr_buf = vec![0u8; size];
            let attrs = LPPROC_THREAD_ATTRIBUTE_LIST(attr_buf.as_mut_ptr().cast());
            InitializeProcThreadAttributeList(Some(attrs), 1, None, &mut size).map_err(|e| fail(e.into()))?;
            UpdateProcThreadAttribute(
                attrs,
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                Some(hpc.0 as *const c_void),
                std::mem::size_of::<HPCON>(),
                None,
                None,
            )
            .map_err(|e| fail(e.into()))?;

            let mut si = STARTUPINFOEXW::default();
            si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
            // 宿主自己的 stdio 是 NUL；不明講的話子程序可能拿到這組而不是 ConPTY（portable-pty 同樣處理）
            si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            si.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
            si.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
            si.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
            si.lpAttributeList = attrs;

            let mut cmd = wide(&command_line(file, args));
            let env = env_block(env);
            let cwd = wide(cwd);
            let mut pi = PROCESS_INFORMATION::default();
            let created = CreateProcessW(
                PCWSTR::null(),
                Some(PWSTR(cmd.as_mut_ptr())),
                None,
                None,
                false,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                Some(env.as_ptr().cast()),
                PCWSTR(cwd.as_ptr()),
                &si.StartupInfo,
                &mut pi,
            );
            DeleteProcThreadAttributeList(attrs);
            created.map_err(|e| fail(e.into()))?;
            let _ = CloseHandle(pi.hThread);
            Ok(Pty {
                pid: pi.dwProcessId,
                hpc: hpc.0,
                input: in_write.0 as isize,
                output: out_read.0 as isize,
                process: pi.hProcess.0 as isize,
            })
        }
    }

    pub fn resize(hpc: isize, cols: u16, rows: u16) -> bool {
        unsafe { ResizePseudoConsole(HPCON(hpc), coord(cols, rows)).is_ok() }
    }

    /// 關掉 ConPTY：附在上面的程序收到 CTRL_CLOSE，輸出管道讀到 EOF。**可能卡住**，
    /// 要有別的執行緒一直在讀輸出（我們一直有）。
    pub fn close_console(hpc: isize) {
        unsafe { ClosePseudoConsole(HPCON(hpc)) }
    }

    pub fn hpc(&self) -> isize {
        self.hpc
    }

    pub fn input(&self) -> isize {
        self.input
    }
}

pub fn write(input: isize, data: &[u8]) -> bool {
    let mut left = data;
    while !left.is_empty() {
        let mut n = 0u32;
        if unsafe { WriteFile(h(input), Some(left), Some(&mut n), None) }.is_err() || n == 0 {
            return false;
        }
        left = &left[n as usize..];
    }
    true
}

/// 讀到 EOF／錯誤回 0
pub fn read(output: isize, buf: &mut [u8]) -> usize {
    let mut n = 0u32;
    match unsafe { ReadFile(h(output), Some(buf), Some(&mut n), None) } {
        Ok(()) => n as usize,
        Err(_) => 0,
    }
}

/// 等程序結束，回離開碼
pub fn wait_exit(process: isize) -> Option<i64> {
    unsafe {
        if WaitForSingleObject(h(process), INFINITE) != WAIT_OBJECT_0 {
            return None;
        }
        let mut code = 0u32;
        GetExitCodeProcess(h(process), &mut code).ok()?;
        Some(code as i64)
    }
}

pub fn close(handle: isize) {
    if handle != 0 {
        unsafe {
            let _ = CloseHandle(h(handle));
        }
    }
}

/// 串流 UTF-8 解碼：跨 chunk 的多位元組字元留到下一塊，壞位元組換成 U+FFFD（同 StringDecoder）
#[derive(Default)]
pub struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        let mut rest: &[u8] = &self.pending;
        loop {
            match std::str::from_utf8(rest) {
                Ok(s) => {
                    out.push_str(s);
                    rest = &[];
                    break;
                }
                Err(e) => {
                    let (ok, bad) = rest.split_at(e.valid_up_to());
                    out.push_str(unsafe { std::str::from_utf8_unchecked(ok) });
                    match e.error_len() {
                        Some(n) => {
                            out.push('\u{FFFD}');
                            rest = &bad[n..];
                        }
                        None => {
                            rest = bad;
                            break;
                        }
                    }
                }
            }
        }
        self.pending = rest.to_vec();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_matches_node_pty() {
        let args = vec!["-NoLogo".to_string(), "-Command".to_string(), "a b; c".to_string(), String::new(), "x\\\"y".to_string()];
        assert_eq!(command_line("C:\\Program Files\\PowerShell\\7\\pwsh.exe", &args),
            "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -NoLogo -Command \"a b; c\" \"\" x\\\\\\\"y");
    }

    #[test]
    fn utf8_split() {
        let mut d = Utf8Stream::default();
        let s = "中文".as_bytes();
        assert_eq!(d.push(&s[..2]), "");
        assert_eq!(d.push(&s[2..]), "中文");
        assert_eq!(d.push(&[0xff, b'a']), "\u{FFFD}a");
    }
}
