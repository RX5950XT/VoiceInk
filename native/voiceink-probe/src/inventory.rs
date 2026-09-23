//! 一次性硬體清單（CPU-Z / AIDA64 / CrystalDiskInfo 的規格那半邊）＝ `probe.ps1` 的 Emit-Static。
//!
//! 每一列的欄位順序是契約（`metrics.parseStatic` 逐格取值）：**只能往後加欄位**。
//! 註解裡的毫秒數是 PowerShell 版實測的 WMI 成本，換成 Rust 之後 WMI 那一段不變。

use std::collections::HashMap;

use wmi::{IWbemClassWrapper, Variant, WMIConnection};

use crate::smart;
use crate::util::{cim_epoch_ms, cim_local_date, esc, local_date, query, reg_key_exists, reg_str, reg_subkeys, reg_value, v2s, v2u64, RegVal, Row};

const GPU_CLASS: &str = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";

fn first(list: Vec<Variant>) -> String {
    list.first().map(v2s).unwrap_or_default()
}

/// 嵌入物件（`MonitorSourceModes` 的每一格）
fn embedded(v: &Variant) -> Option<IWbemClassWrapper> {
    match v {
        Variant::Object(o) => Some(o.clone()),
        Variant::Unknown(u) => u.to_wbem_class_obj().ok(),
        _ => None,
    }
}

fn prop(o: &IWbemClassWrapper, name: &str) -> u64 {
    o.get_property(name).ok().as_ref().and_then(v2u64).unwrap_or(0)
}

/// 回傳 static 框的所有列，以及 tick 要每輪讀溫度的實體碟序號
pub fn emit(con: Option<&WMIConnection>) -> (Vec<String>, Vec<u32>) {
    let mut out = Vec::with_capacity(160);
    system(con, &mut out);
    graphics(con, &mut out);
    let disks = storage(con, &mut out);
    out.extend(smart::static_rows(&disks));
    volumes(con, &mut out);
    monitors(&mut out);
    network(con, &mut out);
    devices(con, &mut out);
    security(con, &mut out);
    (out, disks)
}

fn system(con: Option<&WMIConnection>, out: &mut Vec<String>) {
    for s in query(con, "SELECT * FROM Win32_ComputerSystem") {
        let grp = if s.bool("PartOfDomain") { s.s("Domain") } else { s.s("Workgroup") };
        out.push(format!(
            "SYS|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
            s.s("Manufacturer"), s.s("Model"), s.s("SystemType"), s.raw("TotalPhysicalMemory"), s.s("Name"),
            s.s("SystemFamily"), esc(&grp), s.raw("PartOfDomain"), s.s("UserName"), s.raw("HypervisorPresent"),
            s.raw("PCSystemType"), s.s("BootupState"), s.raw("NumberOfProcessors"),
        ));
    }
    for e in query(con, "SELECT Manufacturer, ChassisTypes, SerialNumber FROM Win32_SystemEnclosure") {
        out.push(format!("CASE|{}|{}|{}", e.s("Manufacturer"), first(e.arr("ChassisTypes")), e.s("SerialNumber")));
    }
    for c in query(con, "SELECT * FROM Win32_Processor") {
        let f = |n: &str| c.raw(n);
        out.push(format!(
            "CPU|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
            c.s("Name"), f("NumberOfCores"), f("NumberOfLogicalProcessors"), f("MaxClockSpeed"), f("L2CacheSize"),
            f("L3CacheSize"), c.s("SocketDesignation"), c.s("Manufacturer"), c.s("ProcessorId"), f("AddressWidth"),
            f("VirtualizationFirmwareEnabled"), f("CurrentVoltage"), c.s("Description"), f("CurrentClockSpeed"),
            f("ExtClock"), f("Family"), f("Stepping"), f("NumberOfEnabledCore"), f("Architecture"), f("Revision"),
        ));
    }
    // L1 只有這個類別給得到。Level 是 SMBIOS 編碼：3=L1、4=L2、5=L3
    for cm in query(con, "SELECT Level, InstalledSize, NumberOfBlocks, Purpose FROM Win32_CacheMemory") {
        out.push(format!("CACHE|{}|{}|{}|{}", cm.raw("Level"), cm.raw("InstalledSize"), cm.raw("NumberOfBlocks"), cm.s("Purpose")));
    }
    for ma in query(con, "SELECT MemoryDevices, MaxCapacityEx, MaxCapacity FROM Win32_PhysicalMemoryArray") {
        out.push(format!("MEMARR|{}|{}|{}", ma.raw("MemoryDevices"), ma.raw("MaxCapacityEx"), ma.raw("MaxCapacity")));
    }
    for b in query(con, "SELECT Manufacturer, Product, Version, SerialNumber FROM Win32_BaseBoard") {
        out.push(format!("BOARD|{}|{}|{}|{}", b.s("Manufacturer"), b.s("Product"), b.s("Version"), b.s("SerialNumber")));
    }
    for b in query(con, "SELECT * FROM Win32_BIOS") {
        // BIOSVersion 陣列的第一格是「系統 BIOS 字串」，跟 SMBIOSBIOSVersion 不同格
        out.push(format!(
            "BIOS|{}|{}|{}|{}|{}.{}|{}|{}",
            b.s("Manufacturer"), b.s("SMBIOSBIOSVersion"), cim_local_date(&b.raw("ReleaseDate")), b.s("SerialNumber"),
            b.raw("SMBIOSMajorVersion"), b.raw("SMBIOSMinorVersion"), b.s("Version"), esc(&first(b.arr("BIOSVersion"))),
        ));
    }
    os(con, out);
    for tz in query(con, "SELECT Caption, StandardName, Bias FROM Win32_TimeZone") {
        out.push(format!("TZ|{}|{}|{}", tz.s("Caption"), tz.s("StandardName"), tz.raw("Bias")));
    }
    for m in query(con, "SELECT * FROM Win32_PhysicalMemory") {
        out.push(format!(
            "RAM|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
            m.s("BankLabel"), m.raw("Capacity"), m.raw("Speed"), m.raw("ConfiguredClockSpeed"), m.s("Manufacturer"),
            m.s("PartNumber"), m.raw("SMBIOSMemoryType"), m.raw("FormFactor"), m.s("DeviceLocator"),
            m.raw("ConfiguredVoltage"), m.s("SerialNumber"),
        ));
    }
}

/// `ProductName` 在 Windows 11 上仍寫著 "Windows 10 Pro"，版本標籤用 Caption；
/// `DisplayVersion`（25H2）與 `UBR` 只有登錄檔給得到
fn os(con: Option<&WMIConnection>, out: &mut Vec<String>) {
    const CV: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
    for o in query(con, "SELECT * FROM Win32_OperatingSystem") {
        let boot = cim_epoch_ms(&o.raw("LastBootUpTime")).unwrap_or(0);
        let mui = o.arr("MUILanguages").iter().map(v2s).collect::<Vec<_>>().join(" ");
        out.push(format!(
            "OS|{}|{}|{}|{boot}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
            o.s("Caption"), o.s("Version"), o.s("BuildNumber"), o.s("OSArchitecture"), esc(&reg_str(CV, "DisplayVersion")),
            reg_str(CV, "UBR"), esc(&mui), o.s("SystemDrive"), o.s("WindowsDirectory"), cim_local_date(&o.raw("InstallDate")),
            esc(&reg_str(CV, "EditionID")), o.s("RegisteredUser"), o.raw("SizeStoredInPagingFiles"), o.raw("TotalVirtualMemorySize"),
        ));
    }
}

/// `AdapterRAM` 是 uint32，8GB 以上一律爆掉；驅動在登錄檔留了 64 位元的真值，
/// 用 MatchingDeviceId 對回 PNPDeviceID
fn graphics(con: Option<&WMIConnection>, out: &mut Vec<String>) {
    let mut vram: Vec<(String, u64)> = Vec::new();
    for sub in reg_subkeys(GPU_CLASS) {
        let key = format!(r"{GPU_CLASS}\{sub}");
        let size = match reg_value(&key, "HardwareInformation.qwMemorySize") {
            Some(RegVal::Num(n)) => n,
            Some(RegVal::Bin(b)) if b.len() >= 8 => u64::from_le_bytes(b[..8].try_into().unwrap_or_default()),
            _ => continue,
        };
        let id = reg_str(&key, "MatchingDeviceId").to_lowercase();
        if size > 0 && !id.is_empty() {
            vram.push((id, size));
        }
    }
    for g in query(con, "SELECT * FROM Win32_VideoController") {
        let pnp = g.raw("PNPDeviceID").to_lowercase();
        let vr = vram.iter().find(|(k, _)| pnp.starts_with(k.as_str())).map_or(0, |(_, v)| *v);
        out.push(format!(
            "GPU|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{vr}",
            g.s("Name"), g.raw("AdapterRAM"), g.s("DriverVersion"), g.s("VideoModeDescription"),
            cim_local_date(&g.raw("DriverDate")), g.raw("CurrentHorizontalResolution"), g.raw("CurrentVerticalResolution"),
            g.raw("CurrentRefreshRate"), g.s("VideoProcessor"), g.s("PNPDeviceID"),
        ));
    }
}

/// MSFT_PhysicalDisk 的數字代碼翻成 `Get-PhysicalDisk` 給的字串（MOF 的 ValueMap）
fn media_type(v: Option<u64>) -> &'static str {
    match v { Some(3) => "HDD", Some(4) => "SSD", Some(5) => "SCM", Some(0) => "Unspecified", _ => "" }
}

fn bus_type(v: Option<u64>) -> &'static str {
    const NAMES: [&str; 20] = [
        "Unknown", "SCSI", "ATAPI", "ATA", "1394", "SSA", "Fibre Channel", "USB", "RAID", "iSCSI",
        "SAS", "SATA", "SD", "MMC", "Virtual", "File Backed Virtual", "Storage Spaces", "NVMe", "SCM", "UFS",
    ];
    v.and_then(|n| NAMES.get(n as usize).copied()).unwrap_or("")
}

fn health(v: Option<u64>) -> &'static str {
    match v { Some(0) => "Healthy", Some(1) => "Warning", Some(2) => "Unhealthy", Some(5) => "Unknown", _ => "" }
}

fn storage(con: Option<&WMIConnection>, out: &mut Vec<String>) -> Vec<u32> {
    // 分割區數與匯流排介面只有 Win32_DiskDrive 給，用 Index 對回 DeviceId
    let mut ddrv = HashMap::new();
    let mut disk_idx = Vec::new();
    for dd in query(con, "SELECT Index, Partitions, InterfaceType FROM Win32_DiskDrive") {
        let idx = dd.raw("Index");
        ddrv.insert(idx.clone(), format!("{}|{}", dd.raw("Partitions"), dd.s("InterfaceType")));
        if let Ok(n) = idx.parse() {
            disk_idx.push(n);
        }
    }
    let storage = WMIConnection::with_namespace_path(r"root\microsoft\windows\storage").ok();
    // 開機碟／分割配置（MBR vs GPT）只有 MSFT_Disk 給，Number 就是實體碟序號
    let mut mdisk = HashMap::new();
    for md in query(storage.as_ref(), "SELECT * FROM MSFT_Disk") {
        let sty = match md.u64("PartitionStyle") { Some(1) => "MBR", Some(2) => "GPT", _ => "" };
        mdisk.insert(md.raw("Number"), format!(
            "{sty}|{}|{}|{}|{}|{}",
            md.raw("IsBoot"), md.raw("IsSystem"), md.raw("IsReadOnly"), md.raw("AllocatedSize"), md.s("Location"),
        ));
    }
    for d in query(storage.as_ref(), "SELECT * FROM MSFT_PhysicalDisk") {
        let id = d.raw("DeviceId");
        let extra = ddrv.get(&id).cloned().unwrap_or_else(|| "|".to_string());
        let more = mdisk.get(&id).cloned().unwrap_or_else(|| "|||||".to_string());
        out.push(format!(
            "PDISK|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{extra}|{}|{}|{}|{}|{more}",
            esc(&id), d.s("FriendlyName"), media_type(d.u64("MediaType")), bus_type(d.u64("BusType")), d.raw("Size"),
            health(d.u64("HealthStatus")), d.s("SerialNumber"), d.s("FirmwareVersion"), d.raw("SpindleSpeed"), d.s("CanPool"),
            d.raw("LogicalSectorSize"), d.raw("PhysicalSectorSize"), d.s("AdapterSerialNumber"), d.s("FruId"),
        ));
    }
    disk_idx
}

/// 關聯類別的參照字串：`...Win32_LogicalDisk.DeviceID="C:"` → `C:`
fn ref_device_id(r: &str) -> String {
    r.split("DeviceID=\"").nth(1).and_then(|s| s.split('"').next()).unwrap_or_default().to_string()
}

fn volumes(con: Option<&WMIConnection>, out: &mut Vec<String>) {
    for pf in query(con, "SELECT Name, AllocatedBaseSize, CurrentUsage, PeakUsage FROM Win32_PageFileUsage") {
        out.push(format!("PAGE|{}|{}|{}|{}", pf.s("Name"), pf.raw("AllocatedBaseSize"), pf.raw("CurrentUsage"), pf.raw("PeakUsage")));
    }
    // 哪個磁碟代號住在哪顆實體碟：Antecedent 直接寫著「Disk #0, Partition #1」
    let mut vol_disk = HashMap::new();
    for lp in query(con, "SELECT Antecedent, Dependent FROM Win32_LogicalDiskToPartition") {
        let ante = ref_device_id(&lp.raw("Antecedent"));
        if let Some(n) = ante.strip_prefix("Disk #").and_then(|s| s.split(',').next()) {
            vol_disk.insert(ref_device_id(&lp.raw("Dependent")), n.to_string());
        }
    }
    for v in query(con, "SELECT DeviceID, VolumeName, Size, FreeSpace, FileSystem FROM Win32_LogicalDisk WHERE DriveType=3") {
        let dk = vol_disk.get(&v.raw("DeviceID")).cloned().unwrap_or_default();
        out.push(format!("VOL|{}|{}|{}|{}|{}|{dk}", v.s("DeviceID"), v.s("VolumeName"), v.raw("Size"), v.raw("FreeSpace"), v.s("FileSystem")));
    }
}

/// 顯示器走 EDID（root\wmi）；三個名稱欄位都是 uint16 陣列，0 是字串結尾的填充
fn monitors(out: &mut Vec<String>) {
    let con = WMIConnection::with_namespace_path(r"root\wmi").ok();
    let con = con.as_ref();
    let mut edid = HashMap::new();
    for bp in query(con, "SELECT InstanceName, MaxHorizontalImageSize, MaxVerticalImageSize FROM WmiMonitorBasicDisplayParams") {
        edid.insert(bp.raw("InstanceName"), format!("{}x{}", bp.raw("MaxHorizontalImageSize"), bp.raw("MaxVerticalImageSize")));
    }
    // EDID 列出來的最大模式＝面板原生解析度
    let mut native = HashMap::new();
    for sm in query(con, "SELECT InstanceName, MonitorSourceModes FROM WmiMonitorListedSupportedSourceModes") {
        let best = sm.arr("MonitorSourceModes").iter().filter_map(embedded).max_by_key(|m| {
            prop(m, "HorizontalActivePixels") * prop(m, "VerticalActivePixels")
        });
        if let Some(m) = best {
            let den = prop(&m, "VerticalRefreshRateDenominator");
            let hz = if den > 0 { (prop(&m, "VerticalRefreshRateNumerator") as f64 / den as f64).round() as u64 } else { 0 };
            native.insert(sm.raw("InstanceName"), format!("{}x{}@{hz}", prop(&m, "HorizontalActivePixels"), prop(&m, "VerticalActivePixels")));
        }
    }
    let mut conn = HashMap::new();
    for cp in query(con, "SELECT InstanceName, VideoOutputTechnology FROM WmiMonitorConnectionParams") {
        conn.insert(cp.raw("InstanceName"), cp.raw("VideoOutputTechnology"));
    }
    let txt = |r: &Row, n: &str| -> String {
        let chars: String = r.arr(n).iter().filter_map(v2u64).filter(|&c| c > 0).filter_map(|c| char::from_u32(c as u32)).collect();
        esc(&chars)
    };
    for mon in query(con, "SELECT * FROM WmiMonitorID") {
        let inst = mon.raw("InstanceName");
        let get = |m: &HashMap<String, String>| m.get(&inst).cloned().unwrap_or_default();
        out.push(format!(
            "MON|{}|{}|{}|{}|{}|{}|{}|{}|{}",
            txt(&mon, "ManufacturerName"), txt(&mon, "UserFriendlyName"), txt(&mon, "SerialNumberID"), mon.raw("YearOfManufacture"),
            get(&edid), get(&native), get(&conn), mon.raw("WeekOfManufacture"), txt(&mon, "ProductCodeID"),
        ));
    }
}

/// 網路卡走 Win32_*（核心 CIM），IPv4／IPv6 位址照 PowerShell 版的篩法
fn network(con: Option<&WMIConnection>, out: &mut Vec<String>) {
    let join = |r: &Row, n: &str, keep: &dyn Fn(&str) -> bool| -> String {
        r.arr(n).iter().map(v2s).filter(|s| keep(s)).collect::<Vec<_>>().join(" ")
    };
    let mut cfg: HashMap<String, [String; 7]> = HashMap::new();
    for c in query(con, "SELECT * FROM Win32_NetworkAdapterConfiguration WHERE IPEnabled=TRUE") {
        let v4 = |s: &str| !s.contains(':');
        cfg.insert(c.raw("Index"), [
            join(&c, "IPAddress", &v4),
            join(&c, "DefaultIPGateway", &v4),
            join(&c, "DNSServerSearchOrder", &v4),
            (if c.bool("DHCPEnabled") { "dhcp" } else { "static" }).to_string(),
            // IPSubnet 與 IPAddress 同索引：IPv4 那幾格是遮罩、IPv6 那幾格是前綴長度，只取遮罩
            join(&c, "IPSubnet", &|s: &str| s.contains('.')),
            c.raw("DHCPServer"),
            // link-local（fe80::）到處都有，列出來只是雜訊
            join(&c, "IPAddress", &|s: &str| s.contains(':') && !s.to_lowercase().starts_with("fe80")),
        ]);
    }
    for n in query(con, "SELECT * FROM Win32_NetworkAdapter WHERE PhysicalAdapter=TRUE") {
        let empty: [String; 7] = Default::default();
        let [ip, gw, dns, dhcp, sub, ds, v6] = cfg.get(&n.raw("Index")).unwrap_or(&empty);
        out.push(format!(
            "NIC|{}|{}|{}|{}|{}|{}|{}|{}|{dhcp}|{}|{}|{}|{}|{}",
            n.s("NetConnectionID"), n.s("Name"), n.s("MACAddress"), n.raw("Speed"), n.raw("NetConnectionStatus"),
            esc(ip), esc(gw), esc(dns), esc(sub), esc(ds), esc(v6), n.s("AdapterType"), n.s("PNPDeviceID"),
        ));
    }
}

/// InstalledOn 是 `M/d/yyyy`（不變文化）；舊系統偶爾是十六進位 FILETIME
fn qfe_date(raw: &str) -> String {
    let parts: Vec<&str> = raw.trim().split('/').collect();
    if let [m, d, y] = parts.as_slice()
        && let (Ok(m), Ok(d), Ok(y)) = (m.parse::<u32>(), d.parse::<u32>(), y.parse::<u32>()) {
            return format!("{y:04}-{m:02}-{d:02}");
        }
    match i64::from_str_radix(raw.trim(), 16) {
        Ok(ft) if ft > 0 => local_date(crate::util::filetime_epoch_ms(ft)),
        _ => String::new(),
    }
}

fn devices(con: Option<&WMIConnection>, out: &mut Vec<String>) {
    for sd in query(con, "SELECT Name, Manufacturer, Status FROM Win32_SoundDevice") {
        out.push(format!("SND|{}|{}|{}", sd.s("Name"), sd.s("Manufacturer"), sd.s("Status")));
    }
    // 虛擬的音訊端點是軟體混音器，列出來只是雜訊
    const VIRTUAL_AUDIO: [&str; 5] = ["broadcast", "virtual", "oculus", "voicemod", "steelseries sonar"];
    for ae in query(con, "SELECT Name FROM Win32_PnPEntity WHERE PNPClass='AudioEndpoint'") {
        let name = ae.raw("Name");
        if VIRTUAL_AUDIO.iter().any(|v| name.to_lowercase().contains(v)) {
            continue;
        }
        out.push(format!("AEND|{}", esc(&name)));
    }
    for cam in query(con, "SELECT Name, Manufacturer, Status FROM Win32_PnPEntity WHERE PNPClass='Camera' OR PNPClass='Image'") {
        out.push(format!("CAM|{}|{}|{}", cam.s("Name"), cam.s("Manufacturer"), cam.s("Status")));
    }
    for bt in query(con, "SELECT Name, Status FROM Win32_PnPEntity WHERE PNPClass='Bluetooth'") {
        out.push(format!("BT|{}|{}", bt.s("Name"), bt.s("Status")));
    }
    for pc in query(con, "SELECT ExternalReferenceDesignator, PortType, ConnectorType FROM Win32_PortConnector") {
        out.push(format!("PORT|{}|{}|{}", pc.s("ExternalReferenceDesignator"), pc.raw("PortType"), first(pc.arr("ConnectorType"))));
    }
    // 最近幾筆 Windows 更新：只留 HotFixID 與日期
    let qfe = query(con, "SELECT HotFixID, InstalledOn FROM Win32_QuickFixEngineering");
    let mut updates: Vec<(String, String)> = qfe.iter().map(|u| (u.s("HotFixID"), qfe_date(&u.raw("InstalledOn")))).collect();
    updates.sort_by(|a, b| b.1.cmp(&a.1));
    for (id, on) in updates.iter().take(5) {
        out.push(format!("QFE|{id}|{on}"));
    }
    out.push(format!("QFEC|{}", qfe.len()));
    for sl in query(con, "SELECT SlotDesignation, CurrentUsage, MaxDataWidth, Tag FROM Win32_SystemSlot") {
        out.push(format!("SLOT|{}|{}|{}|{}", sl.s("SlotDesignation"), sl.raw("CurrentUsage"), sl.raw("MaxDataWidth"), sl.s("Tag")));
    }
    for u in query(con, "SELECT Name, Manufacturer, Status FROM Win32_USBController") {
        out.push(format!("USBC|{}|{}|{}", u.s("Name"), u.s("Manufacturer"), u.s("Status")));
    }
    // 鍵鼠：同一支裝置會被列成好幾筆（HID stack 的每一層各一筆），照描述去重再報數量
    let mut hid: Vec<(String, usize)> = Vec::new();
    let mut count = |key: String| match hid.iter_mut().find(|(k, _)| *k == key) {
        Some((_, n)) => *n += 1,
        None => hid.push((key, 1)),
    };
    for k in query(con, "SELECT Description, Name FROM Win32_Keyboard") {
        count(format!("kb|{}|{}", k.s("Description"), k.s("Name")));
    }
    for p in query(con, "SELECT Name, Manufacturer FROM Win32_PointingDevice") {
        count(format!("ms|{}|{}", p.s("Name"), p.s("Manufacturer")));
    }
    for (key, n) in hid {
        out.push(format!("HID|{key}|{n}"));
    }
    for bt in query(con, "SELECT Name, EstimatedChargeRemaining, BatteryStatus, DesignVoltage, Chemistry FROM Win32_Battery") {
        out.push(format!(
            "BAT|{}|{}|{}|{}|{}",
            bt.s("Name"), bt.raw("EstimatedChargeRemaining"), bt.raw("BatteryStatus"), bt.raw("DesignVoltage"), bt.raw("Chemistry"),
        ));
    }
}

/// Secure Boot 走登錄檔（官方的 Confirm-SecureBootUEFI 要提權）。
/// TPM **不查 `Win32_Tpm`**（未提權 PermissionDenied，失敗前卡 5.2 秒），走 PnP 那一層。
fn security(con: Option<&WMIConnection>, out: &mut Vec<String>) {
    const SB: &str = r"SYSTEM\CurrentControlSet\Control\SecureBoot\State";
    let sbv = reg_value(SB, "UEFISecureBootEnabled");
    let secure_boot = match &sbv {
        Some(RegVal::Num(1)) => "on",
        Some(_) => "off",
        None => "",
    };
    // `SecureBoot\State` 只有 UEFI 開機時才存在；`firmware_type` 環境變數被 spawn 的子程序沒有
    let firmware = if sbv.is_some() {
        "UEFI".to_string()
    } else if let Ok(v) = std::env::var("firmware_type") {
        v
    } else if reg_key_exists(r"SYSTEM\CurrentControlSet\Control\SecureBoot") {
        "UEFI".to_string()
    } else {
        "Legacy BIOS".to_string()
    };
    let tpm = query(con, "SELECT Name FROM Win32_PnPEntity WHERE Service='TPM'")
        .first()
        .map(|r| r.raw("Name"))
        .unwrap_or_default();
    // WMI 與登錄檔的 InstallDate 常是空的；Windows 目錄的建立時間才是可靠的安裝日
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    let installed = std::fs::metadata(root)
        .and_then(|m| m.created())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| local_date(d.as_millis() as i64))
        .unwrap_or_default();
    out.push(format!("SEC|{secure_boot}|{}|{}|{installed}", esc(&firmware), esc(&tpm)));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helpers() {
        assert_eq!(ref_device_id(r#"\\PC\root\cimv2:Win32_LogicalDisk.DeviceID="C:""#), "C:");
        assert_eq!(ref_device_id(r#"\\PC\root\cimv2:Win32_DiskPartition.DeviceID="Disk #1, Partition #0""#), "Disk #1, Partition #0");
        assert_eq!(qfe_date("9/18/2026"), "2026-09-18");
        assert_eq!(qfe_date(""), "");
        assert_eq!(bus_type(Some(17)), "NVMe");
        assert_eq!(bus_type(Some(99)), "");
        assert_eq!(media_type(Some(4)), "SSD");
        assert_eq!(health(Some(0)), "Healthy");
    }
}
