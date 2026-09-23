//! 每輪取樣＝ `probe.ps1` 的 Emit-Tick：全部是 raw 累計值，差值交給 metrics.js 算。
//!
//! 記憶體／磁碟／GPU 仍走 WMI 的 `Win32_PerfRawData_*`（便宜、單位跟原本完全一樣；
//! **不要換成 Get-Counter 那類 formatted 介面**，GPU 引擎慢 80 倍）。
//! 程序與網路改走原生 API：那兩段是 PowerShell 版每輪的大宗。

use std::fmt::Write as _;

use windows::Win32::NetworkManagement::IpHelper::{
    GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_MULTICAST, GetAdaptersAddresses, GetIfEntry2,
    IF_TYPE_SOFTWARE_LOOPBACK, IP_ADAPTER_ADDRESSES_LH, MIB_IF_ROW2,
};
use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
use windows::Win32::Networking::WinSock::AF_UNSPEC;
use windows::Win32::System::SystemInformation::GetSystemTimePreciseAsFileTime;
use wmi::WMIConnection;

use crate::procs;
use crate::smart;
use crate::util::{esc, now_epoch_ms, query};

pub struct TickState {
    pub proc_buf: Vec<u8>,
    /// u64 當單位：IP_ADAPTER_ADDRESSES 要 8 byte 對齊
    pub net_buf: Vec<u64>,
    pub smart_drives: Vec<u32>,
}

pub fn emit(con: Option<&WMIConnection>, st: &mut TickState) -> String {
    let mut s = String::with_capacity(64 * 1024);
    let _ = writeln!(s, "T|{}", now_epoch_ms());
    for m in query(con, "SELECT AvailableBytes, StandbyCacheNormalPriorityBytes, CommittedBytes, CommitLimit, CacheBytes FROM Win32_PerfRawData_PerfOS_Memory") {
        let _ = writeln!(
            s, "M|{}|{}|{}|{}|{}",
            m.raw("AvailableBytes"), m.raw("StandbyCacheNormalPriorityBytes"), m.raw("CommittedBytes"), m.raw("CommitLimit"), m.raw("CacheBytes"),
        );
    }
    for d in query(con, "SELECT Name, DiskReadBytesPersec, DiskWriteBytesPersec, PercentIdleTime, Timestamp_Sys100NS FROM Win32_PerfRawData_PerfDisk_PhysicalDisk") {
        let _ = writeln!(
            s, "D|{}|{}|{}|{}|{}",
            d.s("Name"), d.raw("DiskReadBytesPersec"), d.raw("DiskWriteBytesPersec"), d.raw("PercentIdleTime"), d.raw("Timestamp_Sys100NS"),
        );
    }
    // NVMe 複合溫度／已用壽命：免提權、每顆 ~3ms。對 NVMe 來說這是硬碟溫度唯一拿得到的來源
    for row in smart::tick_rows(&st.smart_drives) {
        s.push_str(&row);
        s.push('\n');
    }
    net_rows(&mut st.net_buf, &mut s);
    // 每程序 GPU：名稱長這樣 pid_1234_luid_..._eng_12_engtype_3D
    for g in query(con, "SELECT Name, UtilizationPercentage, Timestamp_Sys100NS FROM Win32_PerfRawData_GPUPerformanceCounters_GPUEngine") {
        if g.u64("UtilizationPercentage") == Some(0) {
            continue;
        }
        let _ = writeln!(s, "G|{}|{}|{}", g.raw("Name"), g.raw("UtilizationPercentage"), g.raw("Timestamp_Sys100NS"));
    }
    for v in query(con, "SELECT Name, DedicatedUsage, SharedUsage FROM Win32_PerfRawData_GPUPerformanceCounters_GPUProcessMemory") {
        if v.u64("DedicatedUsage") == Some(0) {
            continue;
        }
        let _ = writeln!(s, "V|{}|{}|{}", v.raw("Name"), v.raw("DedicatedUsage"), v.raw("SharedUsage"));
    }
    proc_rows(&mut st.proc_buf, &mut s);
    s
}

/// 一次拿完 pid／名稱／CPU／記憶體／執行緒／I/O／handle／父程序。
/// 時間戳用系統時間（100ns），跟 CPU 時間同單位，metrics.js 拿差值相除
fn proc_rows(buf: &mut Vec<u8>, s: &mut String) {
    let ft = unsafe { GetSystemTimePreciseAsFileTime() };
    let ts = ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64;
    for p in procs::snapshot(buf) {
        // Idle（pid 0）不是真的程序，metrics.js 也會丟掉
        if p.pid == 0 {
            continue;
        }
        let _ = writeln!(
            s, "P|{}|{}|{}|{ts}|{}|{}|{}|{}|{}|{}|{}",
            p.pid, esc(&p.perf_name()), p.cpu_100ns, p.working_set, p.private_bytes, p.threads,
            p.io_read, p.io_write, p.handles, p.parent,
        );
    }
}

fn from_pwstr(p: windows::core::PWSTR) -> String {
    if p.is_null() { String::new() } else { unsafe { p.to_string().unwrap_or_default() } }
}

/// 對應 .NET 的 `NetworkInterface.GetAllNetworkInterfaces()`（同樣是 GetAdaptersAddresses），
/// 位元組數走 64 位元的 `GetIfEntry2`
fn net_rows(buf: &mut Vec<u64>, s: &mut String) {
    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    if buf.is_empty() {
        buf.resize(4 * 1024, 0);
    }
    let mut size = (buf.len() * 8) as u32;
    let mut rc = unsafe { GetAdaptersAddresses(AF_UNSPEC.0 as u32, flags, None, Some(buf.as_mut_ptr() as *mut _), &mut size) };
    if rc == 111 {
        // ERROR_BUFFER_OVERFLOW：size 已經是需要的大小
        buf.resize(size as usize / 8 + 512, 0);
        size = (buf.len() * 8) as u32;
        rc = unsafe { GetAdaptersAddresses(AF_UNSPEC.0 as u32, flags, None, Some(buf.as_mut_ptr() as *mut _), &mut size) };
    }
    if rc != 0 {
        return;
    }
    let mut cur = buf.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
    while !cur.is_null() {
        let a = unsafe { &*cur };
        cur = a.Next;
        if a.OperStatus != IfOperStatusUp || a.IfType == IF_TYPE_SOFTWARE_LOOPBACK {
            continue;
        }
        let mut row = MIB_IF_ROW2 { InterfaceLuid: a.Luid, ..Default::default() };
        if unsafe { GetIfEntry2(&mut row) }.is_err() {
            continue;
        }
        let _ = writeln!(
            s, "N|{}|{}|{}|{}",
            esc(&from_pwstr(a.FriendlyName)), row.InOctets, row.OutOctets, a.ReceiveLinkSpeed,
        );
    }
}
