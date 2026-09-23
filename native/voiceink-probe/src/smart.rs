//! S.M.A.R.T.（CrystalDiskInfo 的那半邊）。
//!
//! 關鍵實測：開 `\\.\PhysicalDriveN` 時 **dwDesiredAccess 一定要給 0**。
//! 給 GENERIC_READ|GENERIC_WRITE 未提權會 ERROR_ACCESS_DENIED，但只做查詢的
//! IOCTL_STORAGE_QUERY_PROPERTY 不需要存取權——NVMe 健康記錄頁因此**不必提權**。
//! ATA／SATA 走舊的 SMART_RCV_DRIVE_DATA，多半仍要系統管理員；失敗一律安靜跳過。

use std::ffi::c_void;

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows::Win32::System::IO::DeviceIoControl;
use windows::core::PCWSTR;

use crate::util::wide;

const IOCTL_STORAGE_QUERY_PROPERTY: u32 = 0x2D1400;
const SMART_RCV_DRIVE_DATA: u32 = 0x7C088;
/// STORAGE_PROPERTY_QUERY 前 8 bytes + STORAGE_PROTOCOL_SPECIFIC_DATA 40 bytes
const NVME_HDR: usize = 48;

struct Drive(HANDLE);

impl Drop for Drive {
    fn drop(&mut self) {
        unsafe { let _ = CloseHandle(self.0); }
    }
}

fn open(n: u32) -> Option<Drive> {
    let path = wide(&format!(r"\\.\PhysicalDrive{n}"));
    unsafe {
        CreateFileW(
            PCWSTR(path.as_ptr()), 0, FILE_SHARE_READ | FILE_SHARE_WRITE, None,
            OPEN_EXISTING, FILE_FLAGS_AND_ATTRIBUTES(0), None,
        )
    }
    .ok()
    .map(Drive)
}

fn ioctl(d: &Drive, code: u32, inb: &[u8], outb: &mut [u8]) -> Option<u32> {
    let mut got = 0u32;
    unsafe {
        DeviceIoControl(
            d.0, code, Some(inb.as_ptr() as *const c_void), inb.len() as u32,
            Some(outb.as_mut_ptr() as *mut c_void), outb.len() as u32, Some(&mut got), None,
        )
    }
    .ok()
    .map(|_| got)
}

/// Windows SDK：49=StorageAdapterProtocolSpecificProperty、50=StorageDeviceProtocolSpecificProperty
fn nvme_block(d: &Drive, prop_id: u32, data_type: u32, req: u32, len: usize) -> Option<Vec<u8>> {
    let mut inb = vec![0u8; NVME_HDR + len];
    let put = |b: &mut [u8], off: usize, v: u32| b[off..off + 4].copy_from_slice(&v.to_le_bytes());
    put(&mut inb, 0, prop_id);
    put(&mut inb, 4, 0); // PropertyStandardQuery
    put(&mut inb, 8, 3); // ProtocolTypeNvme
    put(&mut inb, 12, data_type);
    put(&mut inb, 16, req);
    put(&mut inb, 24, 40); // ProtocolDataOffset
    put(&mut inb, 28, len as u32);
    let mut outb = vec![0u8; NVME_HDR + len];
    ioctl(d, IOCTL_STORAGE_QUERY_PROPERTY, &inb, &mut outb)?;
    Some(outb[NVME_HDR..].to_vec())
}

/// NVMe 的計數器是 128 位元小端序
fn le_num(d: &[u8], off: usize, n: usize) -> u128 {
    d.get(off..off + n).map_or(0, |s| s.iter().rev().fold(0u128, |v, &b| v * 256 + b as u128))
}

fn le16(d: &[u8], off: usize) -> u32 {
    le_num(d, off, 2) as u32
}

/// 舊的 ATA SMART：SENDCMDINPARAMS(32) + 512 bytes。0xD0=讀屬性、0xD1=讀門檻值
fn ata_buffer(d: &Drive, drive: u32, feature: u8) -> Option<Vec<u8>> {
    let mut inb = vec![0u8; 548];
    inb[0..4].copy_from_slice(&512u32.to_le_bytes());
    inb[4] = feature; // bFeaturesReg
    inb[5] = 1; // bSectorCountReg
    inb[6] = 1; // bSectorNumberReg
    inb[7] = 0x4F; // bCylLowReg
    inb[8] = 0xC2; // bCylHighReg
    inb[9] = 0xA0; // bDriveHeadReg
    inb[10] = 0xB0; // bCommandReg = SMART
    inb[12] = drive as u8;
    let mut outb = vec![0u8; 548];
    let got = ioctl(d, SMART_RCV_DRIVE_DATA, &inb, &mut outb)?;
    if got < 528 {
        return None;
    }
    // 16 bytes SENDCMDOUTPARAMS 表頭 + 2 bytes 版本 → 屬性表從這裡開始
    Some(outb[18..530].to_vec())
}

fn nvme_row(n: u32, d: &Drive, log: &[u8]) -> String {
    let mut ver = String::new();
    let (mut wctemp, mut cctemp, mut slots) = (0, 0, 0);
    let mut features: Vec<&str> = Vec::new();
    if let Some(idc) = nvme_block(d, 49, 1, 1, 4096) {
        ver = format!("{}.{}.{}", le16(&idc, 82), idc[81], idc[80]);
        wctemp = le16(&idc, 266);
        cctemp = le16(&idc, 268);
        slots = (idc[260] >> 1) & 7;
        if le16(&idc, 520) & 4 != 0 { features.push("trim"); }
        if idc[525] & 1 != 0 { features.push("vwc"); }
        if idc[265] & 1 != 0 { features.push("apst"); }
        if le16(&idc, 256) & 4 != 0 { features.push("fwupd"); }
    }
    // 溫度在位移 1～2（位元組 0 是 critical warning），單位克氏
    let sensors: Vec<String> = (0..8)
        .map(|i| le16(log, 200 + i * 2))
        .filter(|&k| k > 0)
        .map(|k| format!("{}", (k as f64 - 273.15).round() as i64))
        .collect();
    // Data Units Read/Written 的單位是 1000 × 512 bytes，不是 bytes
    let (read_b, write_b) = (le_num(log, 32, 16).saturating_mul(512_000), le_num(log, 48, 16).saturating_mul(512_000));
    format!(
        "SMART|{n}|nvme|{}|{}|{}|{}|{}|{}|{}|{}|{read_b}|{write_b}|{}|{}|{}|{}|{}|{}|{}|{}|{wctemp}|{cctemp}|{ver}|{}|{slots}",
        log[0], le16(log, 1), log[3], log[4], log[5],
        le_num(log, 128, 16), le_num(log, 112, 16), le_num(log, 144, 16),
        le_num(log, 64, 16), le_num(log, 80, 16), le_num(log, 160, 16), le_num(log, 176, 16),
        le_num(log, 96, 16), le_num(log, 192, 4), le_num(log, 196, 4),
        sensors.join(" "), features.join(" "),
    )
}

fn ata_rows(n: u32, d: &Drive, out: &mut Vec<String>) {
    let Some(attrs) = ata_buffer(d, n, 0xD0) else { return };
    let mut thr = std::collections::HashMap::new();
    if let Some(t) = ata_buffer(d, n, 0xD1) {
        for i in (2..=350).step_by(12) {
            if t[i] != 0 {
                thr.insert(t[i], t[i + 1]);
            }
        }
    }
    out.push(format!("SMART|{n}|ata|0||||||||||||||||||||"));
    for i in (2..=350).step_by(12) {
        let id = attrs[i];
        if id == 0 {
            continue;
        }
        let t = thr.get(&id).map(|v| v.to_string()).unwrap_or_default();
        out.push(format!(
            "SMATTR|{n}|{id}|{}|{}|{t}|{}|{}",
            attrs[i + 3], attrs[i + 4], le_num(&attrs, i + 5, 6), le16(&attrs, i + 1)
        ));
    }
}

/// static 框：一顆硬碟一列 SMART；ATA 另外把每條屬性原樣送出去（名稱在 metrics.js 翻譯）
pub fn static_rows(indexes: &[u32]) -> Vec<String> {
    let mut out = Vec::new();
    for &n in indexes {
        let Some(d) = open(n) else { continue };
        // SMART 走裝置屬性 50；Identify Controller 走轉接器屬性 49
        match nvme_block(&d, 50, 2, 2, 512) {
            Some(log) => out.push(nvme_row(n, &d, &log)),
            None => ata_rows(n, &d, &mut out),
        }
    }
    out
}

/// tick 框：NVMe 即時溫度／已用壽命（實測每顆 ~3ms）
pub fn tick_rows(indexes: &[u32]) -> Vec<String> {
    indexes
        .iter()
        .filter_map(|&n| {
            let d = open(n)?;
            let log = nvme_block(&d, 50, 2, 2, 512)?;
            Some(format!("DT|{n}|{}|{}|{}", le16(&log, 1), log[5], log[3]))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn little_endian_numbers() {
        let mut d = vec![0u8; 16];
        d[0] = 0x01;
        d[1] = 0x02;
        assert_eq!(le_num(&d, 0, 16), 0x0201);
        assert_eq!(le16(&d, 0), 0x0201);
        // 超出範圍當 0，不 panic
        assert_eq!(le_num(&d, 10, 16), 0);
        let big = vec![0xFFu8; 16];
        assert_eq!(le_num(&big, 0, 16), u128::MAX);
    }
}
