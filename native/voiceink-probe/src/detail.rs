//! 選到某一列才查的程序細節（路徑／擁有者／啟動時間／版本資訊）＝ `probe.ps1` 的 Emit-Detail。
//! 另外給 observer 用的「pid → 完整路徑」。

use std::ffi::c_void;

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Security::{GetTokenInformation, LookupAccountSidW, SID_NAME_USE, TOKEN_QUERY, TOKEN_USER, TokenUser};
use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
use windows::Win32::System::Threading::{
    OpenProcess, OpenProcessToken, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows::core::{PCWSTR, PWSTR};

use crate::procs;
use crate::util::{esc, filetime_epoch_ms, from_wide, wide};

struct Handle(HANDLE);

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { let _ = CloseHandle(self.0); }
    }
}

fn open(pid: u32) -> Option<Handle> {
    unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok().map(Handle)
}

pub fn image_path(pid: u32) -> String {
    let Some(h) = open(pid) else { return String::new() };
    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    match unsafe { QueryFullProcessImageNameW(h.0, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len) } {
        Ok(()) => String::from_utf16_lossy(&buf[..len as usize]),
        Err(_) => String::new(),
    }
}

/// `Win32_Process.GetOwner().User`：只要帳號名，不帶網域
fn owner(pid: u32) -> String {
    let Some(h) = open(pid) else { return String::new() };
    let mut token = HANDLE::default();
    if unsafe { OpenProcessToken(h.0, TOKEN_QUERY, &mut token) }.is_err() {
        return String::new();
    }
    let token = Handle(token);
    let mut buf = vec![0u64; 64];
    let mut len = 0u32;
    if unsafe { GetTokenInformation(token.0, TokenUser, Some(buf.as_mut_ptr() as *mut c_void), (buf.len() * 8) as u32, &mut len) }.is_err() {
        return String::new();
    }
    let user = unsafe { &*(buf.as_ptr() as *const TOKEN_USER) };
    let (mut name, mut domain) = ([0u16; 256], [0u16; 256]);
    let (mut nlen, mut dlen) = (name.len() as u32, domain.len() as u32);
    let mut kind = SID_NAME_USE::default();
    let ok = unsafe {
        LookupAccountSidW(
            PCWSTR::null(), user.User.Sid, Some(PWSTR(name.as_mut_ptr())), &mut nlen,
            Some(PWSTR(domain.as_mut_ptr())), &mut dlen, &mut kind,
        )
    };
    if ok.is_err() { String::new() } else { from_wide(&name) }
}

/// .NET `FileVersionInfo`：取第一組語系／字碼頁的 StringFileInfo
fn version_info(path: &str) -> Option<[String; 3]> {
    let wp = wide(path);
    let size = unsafe { GetFileVersionInfoSizeW(PCWSTR(wp.as_ptr()), None) };
    if size == 0 {
        return None;
    }
    let mut data = vec![0u8; size as usize];
    unsafe { GetFileVersionInfoW(PCWSTR(wp.as_ptr()), None, size, data.as_mut_ptr() as *mut c_void) }.ok()?;
    let query = |key: &str| -> Option<(*const c_void, u32)> {
        let wk = wide(key);
        let mut ptr: *mut c_void = std::ptr::null_mut();
        let mut len = 0u32;
        let ok = unsafe { VerQueryValueW(data.as_ptr() as *const c_void, PCWSTR(wk.as_ptr()), &mut ptr, &mut len) };
        (ok.as_bool() && !ptr.is_null()).then_some((ptr as *const c_void, len))
    };
    let lang = match query(r"\VarFileInfo\Translation") {
        Some((ptr, len)) if len >= 4 => {
            let pair = unsafe { std::slice::from_raw_parts(ptr as *const u16, 2) };
            format!("{:04x}{:04x}", pair[0], pair[1])
        }
        _ => "040904b0".to_string(),
    };
    let text = |field: &str| -> String {
        match query(&format!(r"\StringFileInfo\{lang}\{field}")) {
            Some((ptr, len)) if len > 0 => from_wide(unsafe { std::slice::from_raw_parts(ptr as *const u16, len as usize) }),
            _ => String::new(),
        }
    };
    Some([text("CompanyName"), text("FileDescription"), text("FileVersion")])
}

pub fn emit(pid: u32, proc_buf: &mut Vec<u8>) -> String {
    let mut s = String::new();
    if pid == 0 {
        return s;
    }
    let Some(p) = procs::snapshot(proc_buf).into_iter().find(|p| p.pid == pid) else { return s };
    let path = image_path(pid);
    let started = if p.create_time > 0 { filetime_epoch_ms(p.create_time) } else { 0 };
    let name = if p.pid == 4 && p.image.is_empty() { "System".to_string() } else { p.image.clone() };
    s.push_str(&format!("X|{pid}|{}|{}|{}|{started}|{}\n", esc(&name), esc(&path), esc(&owner(pid)), p.parent));
    if !path.is_empty()
        && let Some([company, desc, version]) = version_info(&path) {
            s.push_str(&format!("XV|{}|{}|{}\n", esc(&company), esc(&desc), esc(&version)));
        }
    s
}
