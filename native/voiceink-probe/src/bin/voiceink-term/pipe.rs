//! 具名管道（overlapped）。同步 handle 上的讀和寫會互相排隊——一條執行緒卡在 ReadFile 時
//! 另一條連 WriteFile 都送不出去——所以一律 overlapped，各自帶自己的 event 等結果。
//! handle 在 Drop 才關（避免別的執行緒拿到被重用的 handle 值）；`shutdown` 只取消並斷線。

use std::ffi::c_void;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};

use windows::Win32::Foundation::{
    CloseHandle, ERROR_IO_PENDING, ERROR_PIPE_CONNECTED, GENERIC_READ, GENERIC_WRITE, HANDLE,
    INVALID_HANDLE_VALUE,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, FILE_FLAGS_AND_ATTRIBUTES,
    FILE_SHARE_NONE, OPEN_EXISTING, PIPE_ACCESS_DUPLEX, ReadFile, WriteFile,
};
use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE,
    PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows::Win32::System::Threading::CreateEventW;
use windows::core::PCWSTR;

pub struct Pipe {
    h: isize,
    server: bool,
    closed: AtomicBool,
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 一次 overlapped 操作：發出去，等它完成
fn overlapped(h: HANDLE, op: impl FnOnce(*mut OVERLAPPED) -> windows::core::Result<()>) -> io::Result<u32> {
    unsafe {
        let event = CreateEventW(None, true, false, PCWSTR::null())?;
        let mut ov = OVERLAPPED { hEvent: event, ..Default::default() };
        let started = op(&mut ov);
        let result = match started {
            Ok(()) => Ok(()),
            Err(e) if e.code() == ERROR_IO_PENDING.to_hresult() => Ok(()),
            Err(e) => Err(e),
        };
        let mut n = 0u32;
        let result = result.and_then(|_| GetOverlappedResult(h, &ov, &mut n, true));
        let _ = CloseHandle(event);
        result.map(|_| n).map_err(io::Error::from)
    }
}

unsafe impl Send for Pipe {}
unsafe impl Sync for Pipe {}

impl Pipe {
    fn handle(&self) -> HANDLE {
        HANDLE(self.h as *mut c_void)
    }

    /// `first`：同名管道已經有人在聽就失敗（＝已經有一顆宿主，跟 Node 的 EADDRINUSE 一樣退出）
    pub fn create(name: &str, first: bool) -> io::Result<Pipe> {
        let mut mode = PIPE_ACCESS_DUPLEX.0 | FILE_FLAG_OVERLAPPED.0;
        if first {
            mode |= FILE_FLAG_FIRST_PIPE_INSTANCE.0;
        }
        let name = wide(name);
        let h = unsafe {
            CreateNamedPipeW(
                PCWSTR(name.as_ptr()),
                FILE_FLAGS_AND_ATTRIBUTES(mode),
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES,
                65536,
                65536,
                0,
                None,
            )
        };
        if h == INVALID_HANDLE_VALUE || h.is_invalid() {
            return Err(io::Error::last_os_error());
        }
        Ok(Pipe { h: h.0 as isize, server: true, closed: AtomicBool::new(false) })
    }

    /// 等一個用戶端連上來
    pub fn accept(&self) -> io::Result<()> {
        let h = self.handle();
        match overlapped(h, |ov| unsafe { ConnectNamedPipe(h, Some(ov)) }) {
            Ok(_) => Ok(()),
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_CONNECTED.0 as i32) => Ok(()),
            Err(e) => Err(e),
        }
    }

    pub fn open(name: &str) -> io::Result<Pipe> {
        let name = wide(name);
        let h = unsafe {
            CreateFileW(
                PCWSTR(name.as_ptr()),
                (GENERIC_READ | GENERIC_WRITE).0,
                FILE_SHARE_NONE,
                None,
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED,
                None,
            )?
        };
        Ok(Pipe { h: h.0 as isize, server: false, closed: AtomicBool::new(false) })
    }

    /// 斷線回 0
    pub fn read(&self, buf: &mut [u8]) -> usize {
        if self.closed.load(Ordering::Acquire) {
            return 0;
        }
        let h = self.handle();
        overlapped(h, |ov| unsafe { ReadFile(h, Some(buf), None, Some(ov)) }).unwrap_or(0) as usize
    }

    pub fn write_all(&self, mut data: &[u8]) -> bool {
        let h = self.handle();
        while !data.is_empty() {
            if self.closed.load(Ordering::Acquire) {
                return false;
            }
            match overlapped(h, |ov| unsafe { WriteFile(h, Some(data), None, Some(ov)) }) {
                Ok(n) if n > 0 => data = &data[n as usize..],
                _ => return false,
            }
        }
        true
    }

    pub fn shutdown(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        unsafe {
            let _ = CancelIoEx(self.handle(), None);
            if self.server {
                let _ = DisconnectNamedPipe(self.handle());
            }
        }
    }
}

impl Drop for Pipe {
    fn drop(&mut self) {
        self.shutdown();
        unsafe {
            let _ = CloseHandle(self.handle());
        }
    }
}
