# VoiceInk — 系統監控常駐取樣器
#
# 由 src/main/sysmon/sampler.js 以 -File 拉起，之後一直活著：stdin 收固定指令、stdout 吐框住的資料塊。
# **不接受任何來自 renderer 的字串**——指令只有 static / tick / bye 三個，全是 main 的固定表。
#
# 為什麼是這個寫法（都是實測數字，改之前先重測，別憑感覺）：
#   Get-CimInstance Win32_PerfFormattedData_PerfProc_Process ... 500ms   ← WMI 幫你算，慢
#   Get-Process | Select | ConvertTo-Json ....................... 600ms   ← ConvertTo-Json 是瓶頸
#   Get-CimInstance Win32_PerfRawData_PerfProc_Process（選欄位） .. 158ms  ← 採用，差值我們自己算
#   Get-Counter '\GPU Engine(*)\Utilization Percentage' ......... 5335ms  ← 千萬不要
#   Win32_PerfRawData_GPUPerformanceCounters_GPUEngine ............. 67ms  ← 同一份資料，快 80 倍
# PowerShell 冷啟動約 700ms，所以是常駐程序，不是每輪 spawn。

$ErrorActionPreference = 'Stop'
# stdout 被接成管線時 .NET 預設會緩衝——不開 AutoFlush 的話 sampler.js 一輩子等不到第一個框。
$stdout = [IO.StreamWriter]::new([Console]::OpenStandardOutput(), [Text.UTF8Encoding]::new($false))
$stdout.AutoFlush = $true
[Console]::SetOut($stdout)

# 欄位以 | 分隔，所以名稱裡的 | 一律換掉；順便把換行清掉，一列就是一列。
function Esc([string]$s) {
  if ([string]::IsNullOrEmpty($s)) { return '' }
  return $s.Replace('|', '/').Replace("`r", ' ').Replace("`n", ' ').Trim()
}

# ===== S.M.A.R.T.（CrystalDiskInfo 的那半邊）=====
#
# 關鍵實測：開 `\\.\PhysicalDriveN` 時 **dwDesiredAccess 一定要給 0**。
# 給 GENERIC_READ|GENERIC_WRITE 未提權會直接 ERROR_ACCESS_DENIED（實測 open:5），
# 但只做查詢的 IOCTL_STORAGE_QUERY_PROPERTY 不需要任何存取權——所以 NVMe 的
# 健康記錄頁（通電時數／已用壽命／溫度／寫入總量）**不必提權**就讀得到。
# 這是整包唯一一條免 UAC 拿到 SMART 的路，別「順手」把 access 改成 GENERIC_READ。
#
# ATA／SATA 走的是舊的 SMART_RCV_DRIVE_DATA，那條**多半仍需要系統管理員**；
# 本機兩顆都是 NVMe，沒有實機驗過，所以失敗一律安靜跳過（頁面退回原本的清單）。
$script:SmartTypeReady = $false
# static 那一輪抓到的實體碟序號。tick 每輪要讀溫度，但不該每輪重查一次 WMI。
$script:SmartDrives = @()
# 這個字串不可以拆成變數拼接：`\\.\` 前綴少一個反斜線的症狀是 CreateFileW 回
# ERROR_FILE_NOT_FOUND（2），看起來像「這台機器沒有這顆硬碟」。
$script:DrivePrefix = '\\.\PhysicalDrive'

function Ensure-SmartType {
  if ($script:SmartTypeReady) { return $true }
  try {
    # Add-Type 會即時編譯（實測 265ms），所以延後到真的要用時才跑一次
    Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VoiceInkDisk {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool DeviceIoControl(IntPtr h, uint code, byte[] inBuf, uint inLen, byte[] outBuf, uint outLen, out uint returned, IntPtr overlapped);
  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr h);
}
'@
    $script:SmartTypeReady = $true
  } catch {
    $script:SmartTypeReady = $false
  }
  return $script:SmartTypeReady
}

function Open-PhysicalDrive([int]$n) {
  # access=0（純查詢）、share=READ|WRITE、OPEN_EXISTING
  $h = [VoiceInkDisk]::CreateFileW(($script:DrivePrefix + $n), 0, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
  if ($h -eq [IntPtr](-1)) { return [IntPtr]::Zero }
  return $h
}

# STORAGE_PROPERTY_QUERY(8) + STORAGE_PROTOCOL_SPECIFIC_DATA(40) + 資料區。
# propId 49=StorageDeviceProtocolSpecificProperty、50=StorageAdapterProtocolSpecificProperty。
function Get-NvmeBlock([IntPtr]$h, [uint32]$propId, [uint32]$dataType, [uint32]$reqVal, [int]$len) {
  $hdr = 8
  $psd = 40
  $inb = New-Object byte[] ($hdr + $psd + $len)
  [BitConverter]::GetBytes($propId).CopyTo($inb, 0)
  [BitConverter]::GetBytes([uint32]0).CopyTo($inb, 4)     # PropertyStandardQuery
  [BitConverter]::GetBytes([uint32]3).CopyTo($inb, 8)     # ProtocolTypeNvme
  [BitConverter]::GetBytes($dataType).CopyTo($inb, 12)
  [BitConverter]::GetBytes($reqVal).CopyTo($inb, 16)
  [BitConverter]::GetBytes([uint32]0).CopyTo($inb, 20)
  [BitConverter]::GetBytes([uint32]$psd).CopyTo($inb, 24) # ProtocolDataOffset
  [BitConverter]::GetBytes([uint32]$len).CopyTo($inb, 28)
  $outb = New-Object byte[] ($hdr + $psd + $len)
  $got = 0
  $ok = [VoiceInkDisk]::DeviceIoControl($h, 0x2D1400, $inb, $inb.Length, $outb, $outb.Length, [ref]$got, [IntPtr]::Zero)
  if (-not $ok) { return $null }
  return $outb[($hdr + $psd)..($hdr + $psd + $len - 1)]
}

# NVMe 的計數器是 128 位元小端序；PowerShell 的 [long] 裝不下寫入總量這種數字，用 decimal
function Get-LeNum([byte[]]$d, [int]$off, [int]$n) {
  $v = [decimal]0
  for ($i = $n - 1; $i -ge 0; $i--) { $v = $v * 256 + $d[$off + $i] }
  return $v
}
function Get-Le16([byte[]]$d, [int]$off) { return $d[$off] + $d[$off + 1] * 256 }

# 舊的 ATA SMART：SENDCMDINPARAMS(32) + 512 bytes 資料。
# feature 0xD0=讀屬性、0xD1=讀門檻值；回來的 SENDCMDOUTPARAMS 前 16 bytes 是狀態。
function Get-AtaSmartBuffer([IntPtr]$h, [int]$drive, [byte]$feature) {
  $inb = New-Object byte[] 548
  [BitConverter]::GetBytes([uint32]512).CopyTo($inb, 0)
  $inb[4] = $feature   # bFeaturesReg
  $inb[5] = 1          # bSectorCountReg
  $inb[6] = 1          # bSectorNumberReg
  $inb[7] = 0x4F       # bCylLowReg
  $inb[8] = 0xC2       # bCylHighReg
  $inb[9] = 0xA0       # bDriveHeadReg
  $inb[10] = 0xB0      # bCommandReg = SMART
  $inb[12] = [byte]$drive
  $outb = New-Object byte[] 548
  $got = 0
  $ok = [VoiceInkDisk]::DeviceIoControl($h, 0x7C088, $inb, $inb.Length, $outb, $outb.Length, [ref]$got, [IntPtr]::Zero)
  if (-not $ok -or $got -lt 528) { return $null }
  # 16 bytes SENDCMDOUTPARAMS 表頭 + 2 bytes 版本 → 屬性表從這裡開始
  return $outb[18..529]
}

# 一顆硬碟一列 SMART；ATA 另外把每條屬性原樣送出去（名稱在 metrics.js 翻譯）
function Emit-Smart($add, $indexes) {
  if (-not (Ensure-SmartType)) { return }
  foreach ($n in $indexes) {
    $h = [IntPtr]::Zero
    try {
      $h = Open-PhysicalDrive $n
      if ($h -eq [IntPtr]::Zero) { continue }

      $log = Get-NvmeBlock $h 50 2 2 512
      if ($null -ne $log) {
        $idc = Get-NvmeBlock $h 49 1 1 4096
        $ver = ''
        $wctemp = 0
        $cctemp = 0
        $slots = 0
        $features = @()
        if ($null -ne $idc) {
          $ver = "$(Get-Le16 $idc 82).$($idc[81]).$($idc[80])"
          $wctemp = Get-Le16 $idc 266
          $cctemp = Get-Le16 $idc 268
          $slots = ($idc[260] -shr 1) -band 7
          $oncs = Get-Le16 $idc 520
          if ($oncs -band 4) { $features += 'trim' }
          if ($idc[525] -band 1) { $features += 'vwc' }
          if ($idc[265] -band 1) { $features += 'apst' }
          if ((Get-Le16 $idc 256) -band 4) { $features += 'fwupd' }
        }
        # 溫度是位移 1～2（位元組 0 是 critical warning），單位克氏
        $tempK = Get-Le16 $log 1
        $sensors = @()
        for ($i = 0; $i -lt 8; $i++) {
          $k = Get-Le16 $log (200 + $i * 2)
          if ($k -gt 0) { $sensors += [string]([math]::Round($k - 273.15)) }
        }
        # Data Units Read/Written 的單位是 1000 × 512 bytes，不是 bytes
        $readB = (Get-LeNum $log 32 16) * 512000
        $writeB = (Get-LeNum $log 48 16) * 512000
        & $add ("SMART|$n|nvme|$($log[0])|$tempK|$($log[3])|$($log[4])|$($log[5])" +
          "|$(Get-LeNum $log 128 16)|$(Get-LeNum $log 112 16)|$(Get-LeNum $log 144 16)" +
          "|$readB|$writeB|$(Get-LeNum $log 64 16)|$(Get-LeNum $log 80 16)" +
          "|$(Get-LeNum $log 160 16)|$(Get-LeNum $log 176 16)|$(Get-LeNum $log 96 16)" +
          "|$(Get-LeNum $log 192 4)|$(Get-LeNum $log 196 4)|$($sensors -join ' ')" +
          "|$wctemp|$cctemp|$ver|$($features -join ' ')|$slots")
        continue
      }

      # ATA／SATA：拿得到就送屬性，拿不到（多半是未提權）就當作沒有這一段
      $attrs = Get-AtaSmartBuffer $h $n 0xD0
      if ($null -eq $attrs) { continue }
      $thr = Get-AtaSmartBuffer $h $n 0xD1
      $thrMap = @{}
      if ($null -ne $thr) {
        for ($i = 2; $i -le 350; $i += 12) {
          if ($thr[$i] -eq 0) { continue }
          $thrMap[[string]$thr[$i]] = $thr[$i + 1]
        }
      }
      & $add "SMART|$n|ata|0||||||||||||||||||||"
      for ($i = 2; $i -le 350; $i += 12) {
        $id = $attrs[$i]
        if ($id -eq 0) { continue }
        $t = ''
        if ($thrMap.ContainsKey([string]$id)) { $t = $thrMap[[string]$id] }
        & $add "SMATTR|$n|$id|$($attrs[$i + 3])|$($attrs[$i + 4])|$t|$(Get-LeNum $attrs ($i + 5) 6)|$(Get-Le16 $attrs ($i + 1))"
      }
    } catch {
      # 單顆讀不到不該讓整個 static 框掛掉
      continue
    } finally {
      if ($h -ne [IntPtr]::Zero) { [void][VoiceInkDisk]::CloseHandle($h) }
    }
  }
}

# ===== 一次性硬體清單（CPU-Z / AIDA64 / CrystalDiskInfo 的規格那半邊）=====
function Emit-Static([string]$seq) {
  $sb = [Text.StringBuilder]::new()
  $add = { param($line) [void]$sb.Append($line).Append("`n") }

  foreach ($s in @(Get-CimInstance Win32_ComputerSystem -EA SilentlyContinue)) {
    $grp = if ($s.PartOfDomain) { $s.Domain } else { $s.Workgroup }
    & $add "SYS|$(Esc $s.Manufacturer)|$(Esc $s.Model)|$(Esc $s.SystemType)|$($s.TotalPhysicalMemory)|$(Esc $s.Name)|$(Esc $s.SystemFamily)|$(Esc $grp)|$($s.PartOfDomain)|$(Esc $s.UserName)|$($s.HypervisorPresent)|$($s.PCSystemType)|$(Esc $s.BootupState)|$($s.NumberOfProcessors)"
  }
  foreach ($e in @(Get-CimInstance Win32_SystemEnclosure -EA SilentlyContinue)) {
    & $add "CASE|$(Esc $e.Manufacturer)|$(@($e.ChassisTypes)[0])|$(Esc $e.SerialNumber)"
  }
  # 尾端欄位是後來補的：解析端逐格取值，舊機器少給幾格也不會整列壞掉
  foreach ($c in @(Get-CimInstance Win32_Processor -EA SilentlyContinue)) {
    & $add "CPU|$(Esc $c.Name)|$($c.NumberOfCores)|$($c.NumberOfLogicalProcessors)|$($c.MaxClockSpeed)|$($c.L2CacheSize)|$($c.L3CacheSize)|$(Esc $c.SocketDesignation)|$(Esc $c.Manufacturer)|$(Esc $c.ProcessorId)|$($c.AddressWidth)|$($c.VirtualizationFirmwareEnabled)|$($c.CurrentVoltage)|$(Esc $c.Description)|$($c.CurrentClockSpeed)|$($c.ExtClock)|$($c.Family)|$($c.Stepping)|$($c.NumberOfEnabledCore)|$($c.Architecture)|$($c.Revision)"
  }
  # L1 只有這個類別給得到（Win32_Processor 只有 L2／L3）。Level 是 SMBIOS 編碼：3=L1、4=L2、5=L3
  foreach ($cm in @(Get-CimInstance Win32_CacheMemory -EA SilentlyContinue)) {
    & $add "CACHE|$($cm.Level)|$($cm.InstalledSize)|$($cm.NumberOfBlocks)|$(Esc $cm.Purpose)"
  }
  # 插了幾條 / 總共幾槽 / 這塊板子最多吃多少（Win32_PhysicalMemory 只講插著的那幾條）
  foreach ($ma in @(Get-CimInstance Win32_PhysicalMemoryArray -EA SilentlyContinue)) {
    & $add "MEMARR|$($ma.MemoryDevices)|$($ma.MaxCapacityEx)|$($ma.MaxCapacity)"
  }
  foreach ($b in @(Get-CimInstance Win32_BaseBoard -EA SilentlyContinue)) {
    & $add "BOARD|$(Esc $b.Manufacturer)|$(Esc $b.Product)|$(Esc $b.Version)|$(Esc $b.SerialNumber)"
  }
  foreach ($b in @(Get-CimInstance Win32_BIOS -EA SilentlyContinue)) {
    $rd = if ($b.ReleaseDate) { $b.ReleaseDate.ToString('yyyy-MM-dd') } else { '' }
    # BIOSVersion 陣列的第一格是「系統 BIOS 字串」（ALASKA - 1072009），跟 SMBIOSBIOSVersion（F40a）不同格
    $bv = (@($b.BIOSVersion) | Select-Object -First 1) -join ''
    & $add "BIOS|$(Esc $b.Manufacturer)|$(Esc $b.SMBIOSBIOSVersion)|$rd|$(Esc $b.SerialNumber)|$($b.SMBIOSMajorVersion).$($b.SMBIOSMinorVersion)|$(Esc $b.Version)|$(Esc $bv)"
  }
  # `ProductName` 在 Windows 11 上仍寫著 "Windows 10 Pro"（微軟沒改），版本標籤要用 Caption；
  # 但 `DisplayVersion`（25H2）與 `UBR`（組建的第四段）只有登錄檔給得到
  $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -EA SilentlyContinue
  foreach ($o in @(Get-CimInstance Win32_OperatingSystem -EA SilentlyContinue)) {
    $boot = if ($o.LastBootUpTime) { [long]([DateTimeOffset]$o.LastBootUpTime).ToUnixTimeMilliseconds() } else { 0 }
    $inst = if ($o.InstallDate) { $o.InstallDate.ToString('yyyy-MM-dd') } else { '' }
    $mui = ((@($o.MUILanguages)) -join ' ')
    & $add "OS|$(Esc $o.Caption)|$(Esc $o.Version)|$(Esc $o.BuildNumber)|$boot|$(Esc $o.OSArchitecture)|$(Esc $cv.DisplayVersion)|$($cv.UBR)|$(Esc $mui)|$(Esc $o.SystemDrive)|$(Esc $o.WindowsDirectory)|$inst|$(Esc $cv.EditionID)|$(Esc $o.RegisteredUser)|$($o.SizeStoredInPagingFiles)|$($o.TotalVirtualMemorySize)"
  }
  foreach ($tz in @(Get-CimInstance Win32_TimeZone -EA SilentlyContinue)) {
    & $add "TZ|$(Esc $tz.Caption)|$(Esc $tz.StandardName)|$($tz.Bias)"
  }
  foreach ($m in @(Get-CimInstance Win32_PhysicalMemory -EA SilentlyContinue)) {
    & $add "RAM|$(Esc $m.BankLabel)|$($m.Capacity)|$($m.Speed)|$($m.ConfiguredClockSpeed)|$(Esc $m.Manufacturer)|$(Esc $m.PartNumber)|$($m.SMBIOSMemoryType)|$($m.FormFactor)|$(Esc $m.DeviceLocator)|$($m.ConfiguredVoltage)|$(Esc $m.SerialNumber)"
  }
  # `AdapterRAM` 是 uint32，8GB 以上一律爆掉（16GB 的卡回 4293918720）。
  # 驅動自己在登錄檔留了 64 位元的真值，用 MatchingDeviceId 對回 PNPDeviceID。
  $vram = @{}
  foreach ($k in @(Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}' -EA SilentlyContinue)) {
    $p = Get-ItemProperty $k.PSPath -EA SilentlyContinue
    if ($null -ne $p -and $p.'HardwareInformation.qwMemorySize' -and $p.MatchingDeviceId) {
      $vram[([string]$p.MatchingDeviceId).ToLower()] = [long]$p.'HardwareInformation.qwMemorySize'
    }
  }
  foreach ($g in @(Get-CimInstance Win32_VideoController -EA SilentlyContinue)) {
    $dd = if ($g.DriverDate) { $g.DriverDate.ToString('yyyy-MM-dd') } else { '' }
    $pnp = ([string]$g.PNPDeviceID).ToLower()
    $vr = 0
    foreach ($mk in $vram.Keys) { if ($pnp.StartsWith($mk)) { $vr = $vram[$mk]; break } }
    & $add "GPU|$(Esc $g.Name)|$($g.AdapterRAM)|$(Esc $g.DriverVersion)|$(Esc $g.VideoModeDescription)|$dd|$($g.CurrentHorizontalResolution)|$($g.CurrentVerticalResolution)|$($g.CurrentRefreshRate)|$(Esc $g.VideoProcessor)|$(Esc $g.PNPDeviceID)|$vr"
  }
  # 分割區數與匯流排介面只有 Win32_DiskDrive 給（13ms），用 Index 對回 DeviceId
  $ddrv = @{}
  $diskIdx = @()
  foreach ($dd in @(Get-CimInstance Win32_DiskDrive -EA SilentlyContinue)) {
    $ddrv[[string]$dd.Index] = "$($dd.Partitions)|$(Esc $dd.InterfaceType)"
    $diskIdx += [int]$dd.Index
  }
  # 開機碟／分割配置（MBR vs GPT）只有 MSFT_Disk 給（130ms），Number 就是實體碟序號
  $mdisk = @{}
  foreach ($md in @(Get-CimInstance -Namespace 'root\microsoft\windows\storage' -ClassName MSFT_Disk -EA SilentlyContinue)) {
    # PartitionStyle：1=MBR、2=GPT
    $sty = switch ([int]$md.PartitionStyle) { 1 { 'MBR' } 2 { 'GPT' } default { '' } }
    $mdisk[[string]$md.Number] = "$sty|$($md.IsBoot)|$($md.IsSystem)|$($md.IsReadOnly)|$($md.AllocatedSize)|$(Esc $md.Location)"
  }
  # `Get-PhysicalDisk` 的 MediaType／BusType／HealthStatus 是**已翻好的字串**
  # （MSFT_PhysicalDisk 那份是數字代碼），所以這裡刻意不換成 CIM 直查。
  foreach ($d in @(Get-PhysicalDisk -EA SilentlyContinue)) {
    $extra = '|'
    if ($ddrv.ContainsKey([string]$d.DeviceId)) { $extra = $ddrv[[string]$d.DeviceId] }
    $more = '|||||'
    if ($mdisk.ContainsKey([string]$d.DeviceId)) { $more = $mdisk[[string]$d.DeviceId] }
    & $add "PDISK|$(Esc $d.DeviceId)|$(Esc $d.FriendlyName)|$(Esc $d.MediaType)|$(Esc $d.BusType)|$($d.Size)|$(Esc $d.HealthStatus)|$(Esc $d.SerialNumber)|$(Esc $d.FirmwareVersion)|$($d.SpindleSpeed)|$(Esc $d.CanPool)|$extra|$($d.LogicalSectorSize)|$($d.PhysicalSectorSize)|$(Esc $d.AdapterSerialNumber)|$(Esc $d.FruId)|$more"
  }
  # CrystalDiskInfo 的那半邊：健康度、通電時數、寫入總量、溫度。
  # NVMe 不必提權（見 Emit-Smart 的說明），ATA 多半要——拿不到就整段不出現。
  $script:SmartDrives = $diskIdx
  Emit-Smart $add $diskIdx
  foreach ($pf in @(Get-CimInstance Win32_PageFileUsage -EA SilentlyContinue)) {
    & $add "PAGE|$(Esc $pf.Name)|$($pf.AllocatedBaseSize)|$($pf.CurrentUsage)|$($pf.PeakUsage)"
  }
  # 哪個磁碟代號住在哪顆實體碟：`Get-Partition` 要載 Storage 模組（實測 1376ms），
  # 這個關聯類別只要 23ms，而且 Antecedent 就直接寫著「Disk #0, Partition #1」
  $volDisk = @{}
  foreach ($lp in @(Get-CimInstance Win32_LogicalDiskToPartition -EA SilentlyContinue)) {
    $m = [regex]::Match([string]$lp.Antecedent.DeviceID, 'Disk #(\d+)')
    if ($m.Success) { $volDisk[[string]$lp.Dependent.DeviceID] = $m.Groups[1].Value }
  }
  foreach ($v in @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -EA SilentlyContinue)) {
    $dk = ''
    if ($volDisk.ContainsKey([string]$v.DeviceID)) { $dk = $volDisk[[string]$v.DeviceID] }
    & $add "VOL|$(Esc $v.DeviceID)|$(Esc $v.VolumeName)|$($v.Size)|$($v.FreeSpace)|$(Esc $v.FileSystem)|$dk"
  }
  # 顯示器走 EDID（root\wmi）；三個名稱欄位都是 uint16 陣列，0 是字串結尾的填充
  $edid = @{}
  foreach ($bp in @(Get-CimInstance -Namespace 'root\wmi' -ClassName WmiMonitorBasicDisplayParams -EA SilentlyContinue)) {
    $edid[[string]$bp.InstanceName] = "$($bp.MaxHorizontalImageSize)x$($bp.MaxVerticalImageSize)"
  }
  # EDID 列出來的最大模式＝面板原生解析度（桌面現在設多少是另一回事，那份走 Electron 的 screen）
  $native = @{}
  foreach ($sm in @(Get-CimInstance -Namespace 'root\wmi' -ClassName WmiMonitorListedSupportedSourceModes -EA SilentlyContinue)) {
    $best = $null
    foreach ($mode in @($sm.MonitorSourceModes)) {
      if ($null -eq $best -or ($mode.HorizontalActivePixels * $mode.VerticalActivePixels) -gt ($best.HorizontalActivePixels * $best.VerticalActivePixels)) { $best = $mode }
    }
    if ($null -ne $best) {
      $hz = 0
      if ($best.VerticalRefreshRateDenominator -gt 0) { $hz = [math]::Round($best.VerticalRefreshRateNumerator / $best.VerticalRefreshRateDenominator) }
      $native[[string]$sm.InstanceName] = "$($best.HorizontalActivePixels)x$($best.VerticalActivePixels)@$hz"
    }
  }
  $conn = @{}
  foreach ($cp in @(Get-CimInstance -Namespace 'root\wmi' -ClassName WmiMonitorConnectionParams -EA SilentlyContinue)) {
    $conn[[string]$cp.InstanceName] = [string]$cp.VideoOutputTechnology
  }
  foreach ($mon in @(Get-CimInstance -Namespace 'root\wmi' -ClassName WmiMonitorID -EA SilentlyContinue)) {
    $txt = { param($a) if ($null -eq $a) { return '' } ; return (-join ($a | Where-Object { $_ -gt 0 } | ForEach-Object { [char]$_ })) }
    $inst = [string]$mon.InstanceName
    $size = ''
    if ($edid.ContainsKey($inst)) { $size = $edid[$inst] }
    $nat = ''
    if ($native.ContainsKey($inst)) { $nat = $native[$inst] }
    $ct = ''
    if ($conn.ContainsKey($inst)) { $ct = $conn[$inst] }
    & $add "MON|$(Esc (& $txt $mon.ManufacturerName))|$(Esc (& $txt $mon.UserFriendlyName))|$(Esc (& $txt $mon.SerialNumberID))|$($mon.YearOfManufacture)|$size|$nat|$ct|$($mon.WeekOfManufacture)|$(Esc (& $txt $mon.ProductCodeID))"
  }
  # 網路卡刻意走 Win32_*（核心 CIM），不用 Get-NetAdapter：後者要自動載入模組，
  # 而 PSModulePath 被 git-bash 之類的環境污染時會整組載不起來（pawnio.js 踩過同一坑）
  $ipcfg = @{}
  $gwcfg = @{}
  $dnscfg = @{}
  $dhcpcfg = @{}
  $subcfg = @{}
  $dhsrv = @{}
  $ip6cfg = @{}
  foreach ($cfg in @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=TRUE' -EA SilentlyContinue)) {
    $ipcfg[[string]$cfg.Index] = ((@($cfg.IPAddress) | Where-Object { $_ -notlike '*:*' }) -join ' ')
    $gwcfg[[string]$cfg.Index] = ((@($cfg.DefaultIPGateway) | Where-Object { $_ -notlike '*:*' }) -join ' ')
    $dnscfg[[string]$cfg.Index] = ((@($cfg.DNSServerSearchOrder) | Where-Object { $_ -notlike '*:*' }) -join ' ')
    $dhcpcfg[[string]$cfg.Index] = if ($cfg.DHCPEnabled) { 'dhcp' } else { 'static' }
    # IPSubnet 與 IPAddress 同索引：IPv4 那幾格是遮罩、IPv6 那幾格是前綴長度（純數字），只取遮罩
    $subcfg[[string]$cfg.Index] = ((@($cfg.IPSubnet) | Where-Object { $_ -like '*.*' }) -join ' ')
    $dhsrv[[string]$cfg.Index] = [string]$cfg.DHCPServer
    # link-local（fe80::）到處都有，列出來只是雜訊
    $ip6cfg[[string]$cfg.Index] = ((@($cfg.IPAddress) | Where-Object { $_ -like '*:*' -and $_ -notlike 'fe80*' }) -join ' ')
  }
  foreach ($n in @(Get-CimInstance Win32_NetworkAdapter -Filter 'PhysicalAdapter=TRUE' -EA SilentlyContinue)) {
    $key = [string]$n.Index
    $ip = ''
    if ($ipcfg.ContainsKey($key)) { $ip = $ipcfg[$key] }
    $gw = ''
    if ($gwcfg.ContainsKey($key)) { $gw = $gwcfg[$key] }
    $dns = ''
    if ($dnscfg.ContainsKey($key)) { $dns = $dnscfg[$key] }
    $dhcp = ''
    if ($dhcpcfg.ContainsKey($key)) { $dhcp = $dhcpcfg[$key] }
    $sub = ''
    if ($subcfg.ContainsKey($key)) { $sub = $subcfg[$key] }
    $ds = ''
    if ($dhsrv.ContainsKey($key)) { $ds = $dhsrv[$key] }
    $v6 = ''
    if ($ip6cfg.ContainsKey($key)) { $v6 = $ip6cfg[$key] }
    & $add "NIC|$(Esc $n.NetConnectionID)|$(Esc $n.Name)|$(Esc $n.MACAddress)|$($n.Speed)|$($n.NetConnectionStatus)|$(Esc $ip)|$(Esc $gw)|$(Esc $dns)|$dhcp|$(Esc $sub)|$(Esc $ds)|$(Esc $v6)|$(Esc $n.AdapterType)|$(Esc $n.PNPDeviceID)"
  }
  foreach ($sd in @(Get-CimInstance Win32_SoundDevice -EA SilentlyContinue)) {
    & $add "SND|$(Esc $sd.Name)|$(Esc $sd.Manufacturer)|$(Esc $sd.Status)"
  }
  # AudioEndpoint（喇叭／麥克風實體）：`Win32_SoundDevice` 是驅動層、這裡是「聽得到的裝置」，
  # 兩份都要。虛擬的（Broadcast／Virtual／Oculus／NVIDIA）是軟體混音器，列出來只是雜訊
  foreach ($ae in @(Get-CimInstance Win32_PnPEntity -Filter "PNPClass='AudioEndpoint'" -EA SilentlyContinue)) {
    $nm = [string]$ae.Name
    if ($nm -match 'Broadcast|Virtual|Oculus|Voicemod|SteelSeries Sonar') { continue }
    & $add "AEND|$(Esc $nm)"
  }
  # 攝影機：`Win32_PnPEntity` 的 Camera 類別（實測 260ms）。影像類別掃描器同一段
  foreach ($cam in @(Get-CimInstance Win32_PnPEntity -Filter "PNPClass='Camera' OR PNPClass='Image'" -EA SilentlyContinue)) {
    & $add "CAM|$(Esc $cam.Name)|$(Esc $cam.Manufacturer)|$(Esc $cam.Status)"
  }
  # 藍牙電台（實測 265ms；沒裝就是 0 筆）
  foreach ($bt in @(Get-CimInstance Win32_PnPEntity -Filter "PNPClass='Bluetooth'" -EA SilentlyContinue)) {
    & $add "BT|$(Esc $bt.Name)|$(Esc $bt.Status)"
  }
  # 前後面板的 I/O 埠（SMBIOS Type 8/9，實測 11ms）：機殼上有哪些 USB／HDMI／DP／音源孔
  foreach ($pc in @(Get-CimInstance Win32_PortConnector -EA SilentlyContinue)) {
    $ct = (@($pc.ConnectorType) | Select-Object -First 1)
    & $add "PORT|$(Esc $pc.ExternalReferenceDesignator)|$($pc.PortType)|$ct"
  }
  # 最近幾筆 Windows 更新（實測 850ms）。QFE 只留 HotFixID 與日期，別把整份描述送出來
  $qfe = @(Get-CimInstance Win32_QuickFixEngineering -EA SilentlyContinue)
  $qfeCount = $qfe.Count
  $qfe | Sort-Object InstalledOn -Descending | Select-Object -First 5 | ForEach-Object {
    $on = if ($_.InstalledOn) { $_.InstalledOn.ToString('yyyy-MM-dd') } else { '' }
    & $add "QFE|$(Esc $_.HotFixID)|$on"
  }
  & $add "QFEC|$qfeCount"
  # 擴充插槽：SMBIOS 直接寫著哪一條在用、幾條通道（10ms）
  foreach ($sl in @(Get-CimInstance Win32_SystemSlot -EA SilentlyContinue)) {
    & $add "SLOT|$(Esc $sl.SlotDesignation)|$($sl.CurrentUsage)|$($sl.MaxDataWidth)|$(Esc $sl.Tag)"
  }
  foreach ($u in @(Get-CimInstance Win32_USBController -EA SilentlyContinue)) {
    & $add "USBC|$(Esc $u.Name)|$(Esc $u.Manufacturer)|$(Esc $u.Status)"
  }
  # 鍵鼠：同一支裝置會被列成好幾筆（HID stack 的每一層各一筆），照描述去重再報數量
  $hid = @{}
  foreach ($k in @(Get-CimInstance Win32_Keyboard -EA SilentlyContinue)) {
    $kk = "kb`t$(Esc $k.Description)`t$(Esc $k.Name)"
    $hid[$kk] = 1 + $(if ($hid.ContainsKey($kk)) { $hid[$kk] } else { 0 })
  }
  foreach ($p in @(Get-CimInstance Win32_PointingDevice -EA SilentlyContinue)) {
    $pk = "ms`t$(Esc $p.Name)`t$(Esc $p.Manufacturer)"
    $hid[$pk] = 1 + $(if ($hid.ContainsKey($pk)) { $hid[$pk] } else { 0 })
  }
  foreach ($hk in $hid.Keys) {
    $parts2 = $hk.Split("`t")
    & $add "HID|$($parts2[0])|$($parts2[1])|$($parts2[2])|$($hid[$hk])"
  }
  foreach ($bt in @(Get-CimInstance Win32_Battery -EA SilentlyContinue)) {
    & $add "BAT|$(Esc $bt.Name)|$($bt.EstimatedChargeRemaining)|$($bt.BatteryStatus)|$($bt.DesignVoltage)|$($bt.Chemistry)"
  }
  # Secure Boot 走登錄檔（官方的 Confirm-SecureBootUEFI 要提權）。
  # TPM **刻意不查**：Win32_Tpm 那個命名空間未提權是 PermissionDenied，而且失敗前會卡 5.2 秒
  # ——整個 static 框只花 5 秒，光它就要再翻一倍，換到的只有一行「TPM 2.0」。
  $secureBoot = ''
  try {
    $sbv = Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecureBoot\State' -Name UEFISecureBootEnabled -EA SilentlyContinue
    if ($null -ne $sbv) { $secureBoot = if ($sbv.UEFISecureBootEnabled -eq 1) { 'on' } else { 'off' } }
  } catch { $secureBoot = '' }
  # 韌體模式**不可以只看 `$env:firmware_type`**：那個變數是從父程序繼承的，
  # 互動式主控台有、被 Electron spawn 的 PowerShell 沒有（症狀是這一格永遠空著）。
  # `SecureBoot\State` 這個機碼只有 UEFI 開機時才存在，剛好也是上面已經讀過的那支。
  $firmware = ''
  if ($null -ne $sbv) { $firmware = 'UEFI' }
  elseif ($env:firmware_type) { $firmware = [string]$env:firmware_type }
  elseif (Test-Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecureBoot' -EA SilentlyContinue) { $firmware = 'UEFI' }
  else { $firmware = 'Legacy BIOS' }
  # TPM 走 PnP 那一層（實測 470ms）而不是 `Win32_Tpm`（未提權 PermissionDenied，**失敗前卡 5.2 秒**）；
  # 拿得到的是裝置名（「信賴平台模組 2.0」），版本號就寫在名字裡
  $tpm = ''
  try { $tpm = [string](Get-CimInstance Win32_PnPEntity -Filter "Service='TPM'" -EA SilentlyContinue | Select-Object -First 1).Name } catch { $tpm = '' }
  # WMI 與登錄檔的 InstallDate 在這台實測都是空的；Windows 目錄的建立時間才是可靠的安裝日
  $installed = ''
  try { $installed = (Get-Item $env:SystemRoot -EA SilentlyContinue).CreationTime.ToString('yyyy-MM-dd') } catch { $installed = '' }
  & $add "SEC|$secureBoot|$(Esc $firmware)|$(Esc $tpm)|$installed"

  [Console]::Out.Write("#B static $seq`n")
  [Console]::Out.Write($sb.ToString())
  [Console]::Out.Write("#E static $seq`n")
}

# ===== 每輪取樣：全部是 raw 累計值，差值交給 metrics.js 算 =====
function Emit-Tick([string]$seq) {
  # 這一段刻意寫得很笨：`foreach` 當運算式收集字串、字串內插直接組欄位。
  # 別「整理」成 pipeline、ForEach-Object 或呼叫 scriptblock——430 個進程 × 一次呼叫的
  # 額外成本實測讓整輪從 ~250ms 變 ~400ms，而這一輪每 1～2 秒就要跑一次。
  $rows = @()

  $rows += "T|$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"

  $rows += foreach ($m in @(Get-CimInstance Win32_PerfRawData_PerfOS_Memory -EA SilentlyContinue)) {
    "M|$($m.AvailableBytes)|$($m.StandbyCacheNormalPriorityBytes)|$($m.CommittedBytes)|$($m.CommitLimit)|$($m.CacheBytes)"
  }
  $rows += foreach ($d in @(Get-CimInstance Win32_PerfRawData_PerfDisk_PhysicalDisk -EA SilentlyContinue)) {
    "D|$(Esc $d.Name)|$($d.DiskReadBytesPersec)|$($d.DiskWriteBytesPersec)|$($d.PercentIdleTime)|$($d.Timestamp_Sys100NS)"
  }
  # NVMe 複合溫度／已用壽命：免提權、實測每顆 ~3ms。感測器 sidecar 要 UAC，
  # 大多數人不會按下去——對 NVMe 來說這是硬碟溫度唯一拿得到的來源。
  if ($script:SmartTypeReady) {
    $rows += foreach ($n in $script:SmartDrives) {
      $dh = [IntPtr]::Zero
      try {
        $dh = Open-PhysicalDrive $n
        if ($dh -ne [IntPtr]::Zero) {
          $dlog = Get-NvmeBlock $dh 50 2 2 512
          if ($null -ne $dlog) { "DT|$n|$(Get-Le16 $dlog 1)|$($dlog[5])|$($dlog[3])" }
        }
      } catch {
        # 硬碟被拔掉之類的暫時性失敗：這一輪沒有溫度就算了，不能讓整輪掛掉
      } finally {
        if ($dh -ne [IntPtr]::Zero) { [void][VoiceInkDisk]::CloseHandle($dh) }
      }
    }
  }
  # 網路走 .NET（27ms），比對應的 WMI 類別便宜
  $rows += foreach ($n in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ($n.OperationalStatus -ne 'Up') { continue }
    if ($n.NetworkInterfaceType -eq 'Loopback') { continue }
    $s = $null
    try { $s = $n.GetIPv4Statistics() } catch { $s = $null }
    if ($null -eq $s) { continue }
    "N|$(Esc $n.Name)|$($s.BytesReceived)|$($s.BytesSent)|$($n.Speed)"
  }
  # 每進程 GPU：名稱長這樣 pid_1234_luid_..._eng_12_engtype_3D
  $rows += foreach ($g in @(Get-CimInstance Win32_PerfRawData_GPUPerformanceCounters_GPUEngine -EA SilentlyContinue)) {
    if ($g.UtilizationPercentage -eq 0) { continue }
    "G|$($g.Name)|$($g.UtilizationPercentage)|$($g.Timestamp_Sys100NS)"
  }
  $rows += foreach ($v in @(Get-CimInstance Win32_PerfRawData_GPUPerformanceCounters_GPUProcessMemory -EA SilentlyContinue)) {
    if ($v.DedicatedUsage -eq 0) { continue }
    "V|$($v.Name)|$($v.DedicatedUsage)|$($v.SharedUsage)"
  }
  # 一次查詢就有 pid／名稱／CPU／記憶體／執行緒／磁碟 I/O／handle／父程序。
  # 名稱來自執行檔檔名（Windows 路徑不可能含 |），所以這裡不再逐筆呼叫 Esc。
  $procs = Get-CimInstance Win32_PerfRawData_PerfProc_Process -Property IDProcess,Name,PercentProcessorTime,Timestamp_Sys100NS,WorkingSet,PrivateBytes,ThreadCount,IOReadBytesPersec,IOWriteBytesPersec,HandleCount,CreatingProcessID -EA SilentlyContinue
  $rows += foreach ($p in $procs) {
    if ($null -eq $p.IDProcess) { continue }
    "P|$($p.IDProcess)|$($p.Name)|$($p.PercentProcessorTime)|$($p.Timestamp_Sys100NS)|$($p.WorkingSet)|$($p.PrivateBytes)|$($p.ThreadCount)|$($p.IOReadBytesPersec)|$($p.IOWriteBytesPersec)|$($p.HandleCount)|$($p.CreatingProcessID)"
  }

  [Console]::Out.Write("#B tick $seq`n" + ($rows -join "`n") + "`n#E tick $seq`n")
}

# 選取某一列時才查路徑／公司（每輪都查要多 284ms，不值得）
function Emit-Detail([string]$seq, [string]$arg) {
  $pid2 = 0
  [void][int]::TryParse($arg, [ref]$pid2)
  $sb = [Text.StringBuilder]::new()
  if ($pid2 -gt 0) {
    $w = Get-CimInstance Win32_Process -Filter "ProcessId=$pid2" -EA SilentlyContinue | Select-Object -First 1
    if ($w) {
      $owner = ''
      try { $owner = (Invoke-CimMethod -InputObject $w -MethodName GetOwner -EA SilentlyContinue).User } catch { $owner = '' }
      $started = if ($w.CreationDate) { [long]([DateTimeOffset]$w.CreationDate).ToUnixTimeMilliseconds() } else { 0 }
      [void]$sb.Append("X|$pid2|$(Esc $w.Name)|$(Esc $w.ExecutablePath)|$(Esc $owner)|$started|$($w.ParentProcessId)`n")
      if ($w.ExecutablePath) {
        $vi = $null
        try { $vi = [Diagnostics.FileVersionInfo]::GetVersionInfo($w.ExecutablePath) } catch { $vi = $null }
        if ($vi) { [void]$sb.Append("XV|$(Esc $vi.CompanyName)|$(Esc $vi.FileDescription)|$(Esc $vi.FileVersion)`n") }
      }
    }
  }
  [Console]::Out.Write("#B detail $seq`n")
  [Console]::Out.Write($sb.ToString())
  [Console]::Out.Write("#E detail $seq`n")
}

[Console]::Out.Write("#READY`n")

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }
  $parts = $line.Split(' ')
  $cmd = $parts[0]
  $seq = if ($parts.Length -gt 1) { $parts[1] } else { '0' }
  $arg = if ($parts.Length -gt 2) { $parts[2] } else { '' }
  try {
    switch ($cmd) {
      'static' { Emit-Static $seq }
      'tick'   { Emit-Tick $seq }
      'detail' { Emit-Detail $seq $arg }
      'bye'    { break }
      default  { [Console]::Out.Write("#B $cmd $seq`n#E $cmd $seq`n") }
    }
  } catch {
    # 單輪失敗不能讓取樣器死掉：回一個空框，下一輪照跑
    [Console]::Out.Write("#B $cmd $seq`n#ERR|$(Esc $_.Exception.Message)`n#E $cmd $seq`n")
  }
}
