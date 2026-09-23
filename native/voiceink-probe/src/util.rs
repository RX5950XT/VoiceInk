//! 共用小工具：WMI 取值（格式跟 PowerShell 字串內插一模一樣）、時間換算、登錄檔。
//!
//! **輸出格式是跟 `probe.ps1` 對過的契約**（`metrics.js` 逐格解析），改這裡之前
//! 先用 `scripts/probe-native-probe-parity.js` 對一次兩邊的輸出。

use std::ffi::c_void;

use windows::Win32::Foundation::{ERROR_SUCCESS, FILETIME, SYSTEMTIME};
use windows::Win32::System::Registry::{
    HKEY, HKEY_LOCAL_MACHINE, KEY_READ, REG_BINARY, REG_DWORD, REG_EXPAND_SZ, REG_QWORD, REG_SZ,
    REG_VALUE_TYPE, RRF_RT_ANY, RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW,
};
use windows::Win32::System::Time::{FileTimeToSystemTime, SystemTimeToTzSpecificLocalTime};
use windows::core::{PCWSTR, PWSTR};
use wmi::{IWbemClassWrapper, Variant, WMIConnection};

/// 欄位以 | 分隔：名稱裡的 | 換成 /，換行換成空白（一列就是一列）
pub fn esc(s: &str) -> String {
    s.replace('|', "/").replace(['\r', '\n'], " ").trim().to_string()
}

/// PowerShell 的 `"$($x)"`：null 是空字串、bool 是 True/False、陣列用空白接起來
pub fn v2s(v: &Variant) -> String {
    match v {
        Variant::Empty | Variant::Null | Variant::Unknown(_) | Variant::Object(_) => String::new(),
        Variant::String(s) => s.clone(),
        Variant::Bool(b) => (if *b { "True" } else { "False" }).to_string(),
        Variant::I1(n) => n.to_string(),
        Variant::I2(n) => n.to_string(),
        Variant::I4(n) => n.to_string(),
        Variant::I8(n) => n.to_string(),
        Variant::UI1(n) => n.to_string(),
        Variant::UI2(n) => n.to_string(),
        Variant::UI4(n) => n.to_string(),
        Variant::UI8(n) => n.to_string(),
        Variant::R4(n) => n.to_string(),
        Variant::R8(n) => n.to_string(),
        Variant::Array(a) => a.iter().map(v2s).collect::<Vec<_>>().join(" "),
    }
}

pub fn v2u64(v: &Variant) -> Option<u64> {
    match v {
        Variant::UI1(n) => Some(*n as u64),
        Variant::UI2(n) => Some(*n as u64),
        Variant::UI4(n) => Some(*n as u64),
        Variant::UI8(n) => Some(*n),
        Variant::I1(n) => u64::try_from(*n).ok(),
        Variant::I2(n) => u64::try_from(*n).ok(),
        Variant::I4(n) => u64::try_from(*n).ok(),
        Variant::I8(n) => u64::try_from(*n).ok(),
        Variant::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// 一筆 WMI 物件。取不到的欄位一律當 null（等同 `-EA SilentlyContinue`）
pub struct Row(pub IWbemClassWrapper);

impl Row {
    pub fn v(&self, name: &str) -> Variant {
        self.0.get_property(name).unwrap_or(Variant::Null)
    }
    /// 原樣（不跳脫）
    pub fn raw(&self, name: &str) -> String {
        v2s(&self.v(name))
    }
    /// 跳脫過的（對應 `Esc $x.Name`）
    pub fn s(&self, name: &str) -> String {
        esc(&self.raw(name))
    }
    pub fn arr(&self, name: &str) -> Vec<Variant> {
        match self.v(name) {
            Variant::Array(a) => a,
            Variant::Null | Variant::Empty => Vec::new(),
            other => vec![other],
        }
    }
    pub fn u64(&self, name: &str) -> Option<u64> {
        v2u64(&self.v(name))
    }
    pub fn bool(&self, name: &str) -> bool {
        matches!(self.v(name), Variant::Bool(true))
    }
}

/// 查詢失敗回空清單：單一類別壞掉不能讓整個框掛掉
pub fn query(con: Option<&WMIConnection>, wql: &str) -> Vec<Row> {
    let Some(con) = con else { return Vec::new() };
    match con.exec_query(wql) {
        Ok(it) => it.filter_map(Result::ok).map(Row).collect(),
        Err(_) => Vec::new(),
    }
}

// ===== 時間 =====

const EPOCH_AS_FILETIME: i64 = 116_444_736_000_000_000;

/// 公曆日期 → 1970 起的天數（Howard Hinnant 的 days_from_civil）
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// CIM_DATETIME（`20260414000000.000000+480`）→ Unix 毫秒。`*` 萬用字元當 0
pub fn cim_epoch_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 25 {
        return None;
    }
    let num = |from: usize, to: usize| -> i64 {
        std::str::from_utf8(&b[from..to]).ok().and_then(|t| t.parse().ok()).unwrap_or(0)
    };
    let (y, mo, d) = (num(0, 4), num(4, 6), num(6, 8));
    if y == 0 || mo == 0 || d == 0 {
        return None;
    }
    let (h, mi, sec, micro) = (num(8, 10), num(10, 12), num(12, 14), num(15, 21));
    let sign = if b[21] == b'-' { -1 } else { 1 };
    let offset_min = sign * num(22, 25);
    let secs = days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + sec - offset_min * 60;
    Some(secs * 1000 + micro / 1000)
}

/// Unix 毫秒 → 本地時區的 `yyyy-MM-dd`（PowerShell 把 CIM 日期轉成本地 DateTime 再 ToString）
pub fn local_date(epoch_ms: i64) -> String {
    let ticks = (epoch_ms * 10_000 + EPOCH_AS_FILETIME) as u64;
    let ft = FILETIME { dwLowDateTime: ticks as u32, dwHighDateTime: (ticks >> 32) as u32 };
    let mut utc = SYSTEMTIME::default();
    let mut local = SYSTEMTIME::default();
    unsafe {
        if FileTimeToSystemTime(&ft, &mut utc).is_err()
            || SystemTimeToTzSpecificLocalTime(None, &utc, &mut local).is_err()
        {
            return String::new();
        }
    }
    format!("{:04}-{:02}-{:02}", local.wYear, local.wMonth, local.wDay)
}

pub fn cim_local_date(s: &str) -> String {
    cim_epoch_ms(s).map(local_date).unwrap_or_default()
}

pub fn now_epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// FILETIME（100ns，1601 起）→ Unix 毫秒
pub fn filetime_epoch_ms(ft: i64) -> i64 {
    (ft - EPOCH_AS_FILETIME) / 10_000
}

// ===== 字串 =====

pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn from_wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

// ===== 登錄檔（只讀 HKLM）=====

pub enum RegVal {
    Str(String),
    Num(u64),
    Bin(Vec<u8>),
}

pub fn reg_value(path: &str, name: &str) -> Option<RegVal> {
    let (wp, wn) = (wide(path), wide(name));
    let mut kind = REG_VALUE_TYPE::default();
    let mut size = 0u32;
    unsafe {
        let first = RegGetValueW(
            HKEY_LOCAL_MACHINE, PCWSTR(wp.as_ptr()), PCWSTR(wn.as_ptr()),
            RRF_RT_ANY, Some(&mut kind), None, Some(&mut size),
        );
        if first != ERROR_SUCCESS || size == 0 {
            return None;
        }
        let mut buf = vec![0u8; size as usize + 2];
        let got = RegGetValueW(
            HKEY_LOCAL_MACHINE, PCWSTR(wp.as_ptr()), PCWSTR(wn.as_ptr()),
            RRF_RT_ANY, Some(&mut kind), Some(buf.as_mut_ptr() as *mut c_void), Some(&mut size),
        );
        if got != ERROR_SUCCESS {
            return None;
        }
        buf.truncate(size as usize);
        Some(match kind {
            REG_SZ | REG_EXPAND_SZ => {
                let w: Vec<u16> = buf.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
                RegVal::Str(from_wide(&w))
            }
            REG_DWORD if buf.len() >= 4 => RegVal::Num(u32::from_le_bytes(buf[..4].try_into().ok()?) as u64),
            REG_QWORD if buf.len() >= 8 => RegVal::Num(u64::from_le_bytes(buf[..8].try_into().ok()?)),
            REG_BINARY => RegVal::Bin(buf),
            _ => return None,
        })
    }
}

pub fn reg_str(path: &str, name: &str) -> String {
    match reg_value(path, name) {
        Some(RegVal::Str(s)) => s,
        Some(RegVal::Num(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn open_key(path: &str) -> Option<HKEY> {
    let wp = wide(path);
    let mut key = HKEY::default();
    let rc = unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, PCWSTR(wp.as_ptr()), Some(0), KEY_READ, &mut key) };
    (rc == ERROR_SUCCESS).then_some(key)
}

pub fn reg_key_exists(path: &str) -> bool {
    match open_key(path) {
        Some(key) => {
            unsafe { let _ = RegCloseKey(key); }
            true
        }
        None => false,
    }
}

pub fn reg_subkeys(path: &str) -> Vec<String> {
    let Some(key) = open_key(path) else { return Vec::new() };
    let mut out = Vec::new();
    let mut name = [0u16; 256];
    for index in 0.. {
        let mut len = name.len() as u32;
        let rc = unsafe {
            RegEnumKeyExW(key, index, Some(PWSTR(name.as_mut_ptr())), &mut len, None, None, None, None)
        };
        if rc != ERROR_SUCCESS {
            break;
        }
        out.push(String::from_utf16_lossy(&name[..len as usize]));
    }
    unsafe { let _ = RegCloseKey(key); }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cim_dates() {
        assert_eq!(cim_epoch_ms("19700101000000.000000+000"), Some(0));
        // 台北 +480：當地 08:00 ＝ UTC 00:00
        assert_eq!(cim_epoch_ms("19700101080000.000000+480"), Some(0));
        assert_eq!(cim_epoch_ms("20260414******.******+***").map(|ms| ms / 86_400_000), Some(20557));
        assert_eq!(cim_epoch_ms("bad"), None);
    }

    #[test]
    fn escaping() {
        assert_eq!(esc(" a|b\r\nc "), "a/b  c");
        assert_eq!(v2s(&Variant::Bool(true)), "True");
        assert_eq!(v2s(&Variant::Array(vec![Variant::String("a".into()), Variant::UI2(3)])), "a 3");
        assert_eq!(v2s(&Variant::Null), "");
    }
}
