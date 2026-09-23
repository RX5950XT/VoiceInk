//! 程序清單：一次 `NtQuerySystemInformation(SystemProcessInformation)` 拿全部欄位。
//!
//! PowerShell 版走 `Win32_PerfRawData_PerfProc_Process`（WMI 那邊 ~158ms，加上
//! PowerShell 自己組字串）；這裡是同一份核心資料、直接從核心拿，幾毫秒。
//! 單位對得上 perf counter 的 raw 值：CPU 時間是 100ns、I/O 是累計位元組。

use std::ffi::c_void;

const SYSTEM_PROCESS_INFORMATION: u32 = 5;
const STATUS_INFO_LENGTH_MISMATCH: i32 = 0xC000_0004_u32 as i32;

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtQuerySystemInformation(class: u32, buf: *mut c_void, len: u32, ret: *mut u32) -> i32;
}

pub struct Proc {
    pub pid: u32,
    pub parent: u32,
    /// 映像檔名（含副檔名；pid 4 是空的）
    pub image: String,
    pub cpu_100ns: i64,
    pub create_time: i64,
    pub working_set: u64,
    pub private_bytes: u64,
    pub threads: u32,
    pub handles: u32,
    pub io_read: u64,
    pub io_write: u64,
}

impl Proc {
    /// perf counter 的執行個體名稱：去掉 `.exe`；pid 4 叫 System
    pub fn perf_name(&self) -> String {
        if self.pid == 4 && self.image.is_empty() {
            return "System".to_string();
        }
        match self.image.len().checked_sub(4) {
            Some(cut) if self.image[cut..].eq_ignore_ascii_case(".exe") => self.image[..cut].to_string(),
            _ => self.image.clone(),
        }
    }
}

fn rd<T: Copy>(buf: &[u8], off: usize) -> T {
    assert!(off + std::mem::size_of::<T>() <= buf.len());
    unsafe { std::ptr::read_unaligned(buf.as_ptr().add(off) as *const T) }
}

/// `buf` 由呼叫端保留重用：每輪都配一塊幾百 KB 的緩衝沒有意義
pub fn snapshot(buf: &mut Vec<u8>) -> Vec<Proc> {
    if buf.is_empty() {
        buf.resize(512 * 1024, 0);
    }
    loop {
        let mut need = 0u32;
        let status = unsafe {
            NtQuerySystemInformation(SYSTEM_PROCESS_INFORMATION, buf.as_mut_ptr() as *mut c_void, buf.len() as u32, &mut need)
        };
        if status == STATUS_INFO_LENGTH_MISMATCH {
            // 查詢到回來之間可能又多了程序，多給一點餘裕
            buf.resize((need as usize).max(buf.len()) + 64 * 1024, 0);
            continue;
        }
        if status < 0 {
            return Vec::new();
        }
        break;
    }
    parse(buf)
}

// x64 的 SYSTEM_PROCESS_INFORMATION 位移（winternl.h＋公開的完整版結構）
fn parse(buf: &[u8]) -> Vec<Proc> {
    let mut out = Vec::with_capacity(512);
    let mut off = 0usize;
    loop {
        if off + 0x100 > buf.len() {
            break;
        }
        let e = &buf[off..];
        let next: u32 = rd(e, 0x00);
        let name_len: u16 = rd(e, 0x38);
        let name_ptr: usize = rd(e, 0x40);
        let image = if name_ptr != 0 && name_len > 0 {
            // Buffer 指向同一塊緩衝裡面
            let slice = unsafe { std::slice::from_raw_parts(name_ptr as *const u16, name_len as usize / 2) };
            String::from_utf16_lossy(slice)
        } else {
            String::new()
        };
        out.push(Proc {
            pid: rd::<usize>(e, 0x50) as u32,
            parent: rd::<usize>(e, 0x58) as u32,
            image,
            cpu_100ns: rd::<i64>(e, 0x28) + rd::<i64>(e, 0x30),
            create_time: rd(e, 0x20),
            working_set: rd::<usize>(e, 0x90) as u64,
            private_bytes: rd::<usize>(e, 0xC8) as u64,
            threads: rd(e, 0x04),
            handles: rd(e, 0x60),
            io_read: rd::<i64>(e, 0xE8) as u64,
            io_write: rd::<i64>(e, 0xF0) as u64,
        });
        if next == 0 {
            break;
        }
        off += next as usize;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_self() {
        let mut buf = Vec::new();
        let list = snapshot(&mut buf);
        assert!(list.len() > 10);
        let me = list.iter().find(|p| p.pid == std::process::id()).expect("自己要在清單裡");
        assert!(me.perf_name().starts_with("voiceink_probe"), "{}", me.image);
        assert!(me.threads >= 1 && me.working_set > 0);
        assert_eq!(list.iter().find(|p| p.pid == 4).map(|p| p.perf_name()).as_deref(), Some("System"));
    }
}
