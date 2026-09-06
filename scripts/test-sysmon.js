#!/usr/bin/env node
/**
 * VoiceInk — 系統監控純邏輯回歸（node 直跑，不開 PowerShell、不需 electron）
 *
 * 重點在「計數器語意」：PerfRawData 的 PercentProcessorTime / UtilizationPercentage 是**累計
 * 100 奈秒**，不是百分比；DiskReadBytesPersec 是**累計 bytes**，不是速率。把它們當成已經算好的
 * 值直接顯示，畫面上會出現非常像真的、但完全錯的數字，而且不會有任何錯誤訊息。
 */

'use strict'

const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.join(__dirname, '..')
const m = require(path.join(ROOT, 'src/main/sysmon/metrics.js'))

let passed = 0
let failed = 0
function ok(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps

// ===== probe.ps1 的編碼 =====
console.log('\n[probe.ps1]')
{
  const buf = fs.readFileSync(path.join(ROOT, 'src/main/sysmon/probe.ps1'))
  // Windows PowerShell 5.1 沒有 BOM 就把 UTF-8 當 ANSI 讀，中文註解會讓整個腳本語法錯誤。
  ok('有 UTF-8 BOM', buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
  const text = buf.toString('utf8')
  ok('stdout 有開 AutoFlush', text.includes('AutoFlush = $true'),
    '接成管線時 .NET 預設緩衝，不開的話永遠收不到第一個框')
  // 註解裡刻意寫著「不要用這兩個」，所以比對前先把註解拿掉
  const code = text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
  ok('沒有用 Get-Counter', !code.includes('Get-Counter'), '實測 5.3 秒／輪')
  ok('沒有用 PerfFormattedData', !code.includes('PerfFormattedData'), '實測 500ms／輪')
}

// ===== 框解析 =====
console.log('\n[框解析]')
{
  const p = m.createFrameParser()
  ok('一開始不是 ready', !p.ready())
  ok('#READY 不產生框', p.push('#READY') === null && p.ready())
  ok('框頭不產生框', p.push('#B tick 7') === null)
  ok('資料列不產生框', p.push('T|123') === null)
  const frame = p.push('#E tick 7')
  ok('框尾回傳整框', frame && frame.kind === 'tick' && frame.seq === 7 && frame.rows.length === 1)
  ok('框外雜訊丟掉', p.push('Windows PowerShell') === null)

  // stdout 被截斷 → 框頭框尾對不上，整框丟掉比送半份資料好
  const p2 = m.createFrameParser()
  p2.push('#B tick 1')
  p2.push('T|1')
  ok('框頭框尾 kind 不合就丟掉', p2.push('#E static 1') === null)

  // 新的框頭沒收到框尾就又來一個 → 舊的作廢
  const p3 = m.createFrameParser()
  p3.push('#B tick 1')
  p3.push('T|1')
  p3.push('#B tick 2')
  p3.push('T|2')
  const f3 = p3.push('#E tick 2')
  ok('中斷後重開的框只留新的', f3 && f3.rows.length === 1 && f3.rows[0] === 'T|2')

  // \r\n 的 \r 要吃掉，否則 '#READY\r' !== '#READY'
  const p4 = m.createFrameParser()
  p4.push('#READY\r')
  ok('CRLF 的 \\r 有處理', p4.ready())
}

// ===== 靜態清單 =====
console.log('\n[靜態清單]')
{
  const s = m.parseStatic([
    'SYS|Gigabyte|X570 AORUS PRO|x64-based PC|102995783680|PC-DEMO|X570 MB',
    'CASE|Default string|3|Default string',
    'CPU|AMD Ryzen 7 5700X 8-Core Processor|8|16|3401|4096|32768|AM4|AuthenticAMD|178BFBFF00A20F12|64|True|11|AMD64 Family 25|3401',
    'BOARD|Gigabyte|X570 AORUS PRO|Default string',
    'BIOS|AMI|F40a|2026-04-14',
    'OS|Windows 11 專業版|10.0.26200|26200|1788060251500',
    'RAM|P0 CHANNEL A|17179869184|2133|2133|Samsung|32G3200CL22|26|8|DIMM 0|1200',
    'GPU|NVIDIA GeForce RTX 5060 Ti|4293918720|32.0.16.1074|2560 x 1440|2026-07-02|2560|1440|144|RTX 5060 Ti|PCI\\VEN_10DE',
    'PDISK|1|ADATA SX8200PNP|SSD|NVMe|2048408248320|Healthy|SN123|FW1234|0|False',
    'VOL|C:|OS|1023135444992|425396494336|NTFS',
    'MON|PHL|PHL 272E1GJ|UK02203064377|2022|60x34',
    'NIC|乙太網路 2|Intel(R) I211|00:11:22:33:44:55|1000000000|2|192.168.1.100',
    'SND|Realtek High Definition Audio|Realtek|OK',
    'BAT|內建電池|87|2|11400|6',
    'SEC|on',
    '這是一列壞資料',
    'UNKNOWN|x|y'
  ])
  ok('CPU 欄位對位', s.cpus[0].cores === 8 && s.cpus[0].threads === 16 && s.cpus[0].l3CacheKb === 32768)
  ok('主機板', s.board.product === 'X570 AORUS PRO')
  ok('BIOS', s.bios.version === 'F40a')
  ok('OS 開機時間是數字', s.os.bootedAt === 1788060251500)
  ok('記憶體模組', s.memoryModules[0].capacity === 17179869184)
  ok('GPU', s.gpus[0].name.includes('5060 Ti'))
  ok('實體碟', s.physicalDisks[0].busType === 'NVMe' && s.physicalDisks[0].health === 'Healthy')
  ok('磁碟區', s.volumes[0].free === 425396494336)
  ok('壞行與未知型別不會炸', s.cpus.length === 1 && s.volumes.length === 1)

  // 後來補的欄位：SMBIOS 代碼要翻成看得懂的字，缺欄位不能讓整列壞掉
  ok('CPU 補的尾端欄位', s.cpus[0].addressWidth === 64 && s.cpus[0].virtualization === true)
  ok('CPU 電壓是 WMI 的十分之一伏特', Math.abs(s.cpus[0].voltage - 1.1) < 1e-9)
  ok('記憶體型別 26 → DDR4', s.memoryModules[0].type === 'DDR4')
  ok('記憶體外型 8 → DIMM 且有插槽名', s.memoryModules[0].formFactor === 'DIMM' && s.memoryModules[0].slot === 'DIMM 0')
  ok('GPU 顯示模式與驅動日期', s.gpus[0].width === 2560 && s.gpus[0].refreshHz === 144 && s.gpus[0].driverDate === '2026-07-02')
  ok('實體碟韌體版本', s.physicalDisks[0].firmware === 'FW1234')
  ok('系統與機殼', s.system.model === 'X570 AORUS PRO' && s.chassis.type === '桌上型')
  ok('顯示器 EDID', s.monitors[0].name === 'PHL 272E1GJ' && s.monitors[0].year === 2022)
  ok('網路卡狀態 2 → 已連線', s.nics[0].status === '已連線' && s.nics[0].ips === '192.168.1.100')
  ok('音效裝置', s.sound[0].vendor === 'Realtek')
  ok('電池化學 6 → 鋰離子', s.batteries[0].chemistry === '鋰離子' && s.batteries[0].charge === 87)
  ok('Secure Boot 狀態', s.security.secureBoot === 'on')

  // 後補的硬體欄位（L1 快取／插槽總數／64 位元 VRAM／磁碟區住哪顆／閘道與 DNS）
  const extra = m.parseStatic([
    'CACHE|3|512|512|L1 - Cache',
    'CACHE|5|32768|512|L3 - Cache',
    'MEMARR|4|134217728|134217728',
    'GPU|RTX 5060 Ti|4293918720|32.0|2560 x 1440|2026-07-02|2560|1440|144|GB206|PCI\\VEN_10DE|17103323136',
    'VOL|D:|資料|2048390066176|1464655380480|NTFS|1',
    'NIC|乙太網路|I211|00:11:22:33:44:55|1000000000|2|192.168.1.100|192.168.1.1|8.8.8.8|dhcp'
  ])
  ok('L1 快取（SMBIOS Level 3 → L1）', extra.caches[0].level === 1 && extra.caches[0].sizeKb === 512)
  ok('記憶體插槽總數與上限', extra.memoryArray.slots === 4 && extra.memoryArray.maxCapacity === 137438953472)
  ok('VRAM 用 64 位元真值不用爆掉的 AdapterRAM', extra.gpus[0].vram === 17103323136)
  ok('磁碟區標得出住在哪顆實體碟', extra.volumes[0].diskId === '1')
  ok('網路卡帶閘道／DNS／取得方式', extra.nics[0].gateway === '192.168.1.1' && extra.nics[0].dns === '8.8.8.8' && extra.nics[0].dhcp === 'dhcp')
  // 舊 probe 沒有第 11 格時要退回 AdapterRAM，不能變成 0
  const oldGpu = m.parseStatic(['GPU|GTX 1060|6442450944|31.0|1920 x 1080|2024-01-01|1920|1080|60|GP106|PCI\\VEN_10DE'])
  ok('舊格式 VRAM 退回 AdapterRAM', oldGpu.gpus[0].vram === 6442450944)

  // 舊版 probe（欄位比較少）餵進來也不能炸，只是新欄位空著
  const old = m.parseStatic([
    'CPU|Intel Core i7|8|16|3600|2048|16384|LGA1700|GenuineIntel',
    'RAM|BANK 0|17179869184|3200|3200|Corsair|CMK32',
    'PDISK|0|Samsung 990|SSD|NVMe|1000204886016|Healthy|SN'
  ])
  ok('舊格式少欄位不會炸', old.cpus[0].addressWidth === 0 && old.memoryModules[0].type === '' && old.physicalDisks[0].firmware === '')
  ok('舊格式沒有的區塊是空陣列', old.monitors.length === 0 && old.nics.length === 0 && old.security === null)
  ok('舊格式的新區塊也是空陣列', old.slots.length === 0 && old.usbControllers.length === 0 && old.inputDevices.length === 0 && old.pageFiles.length === 0)

  // 第二批補上的欄位（總覽原本整片空著的那些）
  const more = m.parseStatic([
    'SYS|Gigabyte|X570|x64-based PC|102995783680|PC-DEMO|X570 MB|WORKGROUP|False|PC-DEMO\\user|True|1|Normal boot|1',
    'CPU|Ryzen 7 5700X|8|16|3401|4096|32768|AM4|AuthenticAMD|178B|64|True|11|AMD64|3401|100|107|2|8|9|8450',
    'BOARD|Gigabyte|X570 AORUS PRO|Default string|Default string',
    'BIOS|AMI|F40a|2026-04-14|Default string|3.3|ALASKA - 1072009',
    'OS|Windows 11 專業版|10.0.26200|26200|1788267653500|64 位元|25H2|9168|zh-TW en-US|C:|C:\\WINDOWS||Professional||1024000|101605820',
    'TZ|(UTC+08:00) 台北|台北標準時間|480',
    'PDISK|1|ADATA SX8200PNP|SSD|NVMe|2048408248320|Healthy|SN|FW1234|0|False|3|SCSI',
    'PAGE|C:\\pagefile.sys|1000|120|340',
    'MON|AUS|VG27AQL1A|MON-SN-0001|2020|60x34|2560x1440@60|10|53|2705',
    'NIC|乙太網路|I211|00:11:22:33:44:55|1000000000|2|192.168.1.100|192.168.1.1|8.8.8.8|dhcp|255.255.255.0|192.168.1.1|fdfd::1|乙太網路 802.3|PCI\\VEN_8086',
    'SLOT|J10|4|10|System Slot 0',
    'SLOT|J3600|3|8|System Slot 1',
    'USBC|AMD USB 3.10|泛型 USB xHCI|OK',
    'HID|kb|HID Keyboard Device|增強 (101 或 102 鍵)|5'
  ])
  ok('系統帶工作群組／使用者／Hypervisor', more.system.workgroup === 'WORKGROUP' && more.system.inDomain === false && more.system.hypervisor === true && more.system.user === 'PC-DEMO\\user')
  ok('CPU 帶外頻／步進／架構', more.cpus[0].extClockMhz === 100 && more.cpus[0].stepping === '2' && more.cpus[0].arch === 'x64' && more.cpus[0].enabledCores === 8)
  ok('OS 帶功能更新版本與 UBR', more.os.displayVersion === '25H2' && more.os.ubr === 9168 && more.os.arch === '64 位元' && more.os.edition === 'Professional')
  ok('時區', more.timeZone.caption.includes('台北') && more.timeZone.biasMin === 480)
  ok('磁碟帶分割區數與介面', more.physicalDisks[0].partitions === 3 && more.physicalDisks[0].interfaceType === 'SCSI')
  ok('分頁檔（單位 MB）', more.pageFiles[0].sizeMb === 1000 && more.pageFiles[0].usedMb === 120 && more.pageFiles[0].peakMb === 340)
  ok('顯示器帶原生解析度與接頭', more.monitors[0].native === '2560x1440@60' && more.monitors[0].connector === 'DisplayPort' && more.monitors[0].week === 53)
  ok('網路卡帶遮罩／DHCP 伺服器／IPv6', more.nics[0].subnet === '255.255.255.0' && more.nics[0].dhcpServer === '192.168.1.1' && more.nics[0].ipv6 === 'fdfd::1')
  ok('擴充插槽的使用狀態與通道數', more.slots[0].usage === '使用中' && more.slots[0].width === '×16' && more.slots[1].usage === '空置' && more.slots[1].width === '×8')
  ok('USB 控制器與輸入裝置', more.usbControllers[0].name === 'AMD USB 3.10' && more.inputDevices[0].kind === '鍵盤' && more.inputDevices[0].count === 5)
  // SMBIOS 的佔位字串原樣顯示會變成規格表上寫著「Default string」，比留白更糟
  ok('SMBIOS 佔位值清成空字串', more.board.version === '' && more.board.serial === '' && more.bios.serial === '' && more.os.registeredUser === '')
  ok('佔位值清理不會誤傷真實值', more.board.product === 'X570 AORUS PRO' && more.bios.internalVersion === 'ALASKA - 1072009' && more.bios.smbios === '3.3')

  // SEC 列後來補了韌體模式／TPM／安裝日期；舊 probe 只給第一格也不能讓整個 security 變 null
  const sec = m.parseStatic(['SEC|on|UEFI|信賴平台模組 2.0|2024-04-01'])
  ok('SEC 帶韌體模式／TPM／安裝日期', sec.security.firmware === 'UEFI' && sec.security.tpm === '信賴平台模組 2.0' && sec.security.installedAt === '2024-04-01')
  const secOld = m.parseStatic(['SEC|off'])
  ok('舊格式的 SEC 只有安全開機', secOld.security.secureBoot === 'off' && secOld.security.firmware === '' && secOld.security.tpm === '')

  // ── S.M.A.R.T.（CrystalDiskInfo 那一塊）─────────────────────────
  // 這一列是本機 ADATA LEGEND 710 的實際輸出，不是編的
  const sm = m.parseStatic([
    'PDISK|0|ADATA LEGEND 710|SSD|NVMe|1024209543168|Healthy|0000_0000_0000_0000_707C_1800_0000_0000.|VC400616|0|False|3|SCSI|512|4096|4O4421224569        _0001|4O4421224569|GPT|True|True|False|1024208494592|Integrated : Bus 1 : Device 0',
    'SMART|0|nvme|0|325|100|32|21|5997|271|110|21673014784000|62329966592000|1134368675|1836291991|0|0|0|0|0||373|383|1.4.0|trim vwc apst fwupd|2'
  ])
  const d0 = sm.physicalDisks[0]
  ok('磁碟帶磁區大小／分割配置／開機碟', d0.logicalSector === 512 && d0.physicalSector === 4096 && d0.partitionStyle === 'GPT' && d0.isBoot === true)
  // 韌體回的序號是一長串補零，標籤上刻的是 FruId
  ok('磁碟序號取到標籤上那組', d0.fruId === '4O4421224569' && d0.adapterSerial === '4O4421224569')
  const s0 = sm.smart[0]
  // 325 K = 51.85 °C；直接顯示克氏或忘了減 273 會得到「17134 度」
  ok('SMART 溫度換算成攝氏', s0.tempC === 52 && s0.warnTempC === 100 && s0.critTempC === 110)
  ok('SMART 通電時數／次數／非正常關機', s0.powerOnHours === 5997 && s0.powerCycles === 271 && s0.unsafeShutdowns === 110)
  // Data Units Written 的單位是 1000 × 512 bytes，當成 bytes 會少算 51 萬倍
  ok('SMART 寫入總量是 bytes', s0.bytesWritten === 62329966592000 && s0.bytesRead === 21673014784000)
  ok('SMART 壽命與備援空間', s0.usedPct === 21 && s0.spare === 100 && s0.spareThreshold === 32)
  ok('SMART 規格版本與支援功能', s0.specVersion === '1.4.0' && s0.features.includes('TRIM（Dataset Management）') && s0.firmwareSlots === 2)
  ok('沒實作的溫度感測器不會變成 0 度', s0.sensorsC.length === 0)
  ok('健康度：一切正常是良好', m.smartHealth(s0).level === 'good')
  ok('健康度：critical warning 一定是不良', m.smartHealth({ ...s0, criticalWarning: 4 }).level === 'bad')
  ok('健康度：備援低於廠商門檻是不良', m.smartHealth({ ...s0, spare: 20 }).level === 'bad')
  // 用掉九成壽命只是「該留意」，講成不良會讓人去換一顆還能用很久的碟
  ok('健康度：壽命用掉九成是警告不是不良', m.smartHealth({ ...s0, usedPct: 93 }).level === 'caution')
  ok('健康度：媒體錯誤是警告', m.smartHealth({ ...s0, mediaErrors: 3 }).level === 'caution')

  // ATA 走另一條：SMART 表頭 + 每條屬性一列
  const ata = m.parseStatic([
    'SMART|1|ata|0||||||||||||||||||||',
    'SMATTR|1|5|100|100|10|0|50',
    'SMATTR|1|9|95|95|0|12345|18',
    'SMATTR|1|194|70|60|0|30|34',
    'SMATTR|1|253|100|100|0|7|1'
  ])
  const a1 = ata.smart[0]
  ok('ATA 屬性掛在自己那顆碟上', a1.proto === 'ata' && a1.attributes.length === 4)
  ok('ATA 屬性名稱表', a1.attributes[0].name === '重新配置的磁區數' && a1.attributes[1].name === '通電時數')
  // 查無此號時**不猜名字**：猜錯比留白危險
  ok('未知屬性編號顯示成十六進位而不是亂猜', a1.attributes[3].name === '屬性 0xFD')
  ok('ATA 屬性的門檻值', a1.attributes[0].threshold === 10 && a1.attributes[1].threshold === 0)
  // threshold 0 代表這條沒有門檻，不能當成「已經掉到門檻」
  ok('健康度：沒有門檻的屬性不會被判成不良', m.smartHealth(a1).level === 'good')
  ok('健康度：屬性掉到門檻是不良', m.smartHealth({
    ...a1, attributes: [{ id: 5, name: '重新配置的磁區數', current: 9, worst: 9, threshold: 10, raw: 800 }]
  }).level === 'bad')
  ok('健康度：有重新配置磁區是警告', m.smartHealth({
    ...a1, attributes: [{ id: 5, name: '重新配置的磁區數', current: 100, worst: 100, threshold: 10, raw: 8 }]
  }).level === 'caution')
  ok('對不到表頭的屬性列直接丟掉', m.parseStatic(['SMATTR|9|5|100|100|10|0|50']).smart.length === 0)

  // 舊版 probe 完全沒有這些列
  ok('舊格式沒有 SMART 也不會炸', old.smart.length === 0 && old.physicalDisks[0].logicalSector === 0 && old.physicalDisks[0].partitionStyle === '')

  // 即時溫度走 tick 的 DT 列
  const dt = m.parseTick(['T|1000', 'DT|0|325|21|100', 'DT|1|0|0|0'])
  ok('tick 帶 NVMe 即時溫度', dt.driveTemps.length === 1 && dt.driveTemps[0].id === '0' && dt.driveTemps[0].tempC === 52)
  ok('0 K 是「沒有這顆感測器」不是 0 度', dt.driveTemps.every((x) => x.tempC > 0))
  ok('溫度原樣往上送，不做差值', m.diffSamples(null, dt, 8).driveTemps === dt.driveTemps)

  // ── 第三批：盤點後補的類別（攝影機／藍牙／I/O 埠／音訊端點／QFE）──
  const more2 = m.parseStatic([
    'AEND|耳機 (4- FIIO KA13)',
    'AEND|Speakers (NVIDIA Broadcast)',
    'CAM|Full HD 1080P PC Camera|Microsoft|OK',
    'CAM|虛擬掃描器||Error',
    'BT|Realtek Bluetooth|OK',
    'PORT|USB 3.0|16|64',
    'PORT|HDMI|28|0',
    'PORT|Front Audio|29|88',
    'QFE|KB5121003|2026-08-15',
    'QFE|KB5054156|2025-10-17',
    'QFEC|4'
  ])
  ok('音訊端點逐列', more2.audioEndpoints.length === 2 && more2.audioEndpoints[0].name === '耳機 (4- FIIO KA13)')
  ok('攝影機帶廠商與狀態', more2.cameras.length === 2 && more2.cameras[0].vendor === 'Microsoft' && more2.cameras[1].status === 'Error')
  ok('藍牙電台', more2.bluetooth.length === 1 && more2.bluetooth[0].name === 'Realtek Bluetooth')
  // PortType 是 SMBIOS 編碼：16=USB、28=顯示、29=音源 jack
  ok('I/O 埠翻譯成看得懂的型別', more2.ports[0].portType === 'USB' && more2.ports[1].portType === '顯示埠' && more2.ports[2].portType === '音源 jack')
  ok('查無此號的 PortType 顯示代號', m.parseStatic(['PORT|X|99|0']).ports[0].portType === '')
  ok('Windows 更新只留 id 與日期', more2.hotfixes.length === 2 && more2.hotfixes[0].id === 'KB5121003' && more2.hotfixes[1].installedOn === '2025-10-17')
  ok('更新總數單獨一列', more2.hotfixTotal === 4)

  // RAM 序號與 BIOS 系統字串是往後加的欄位，舊格式照樣解析
  ok('RAM 序號往後加欄位', m.parseStatic(['RAM|P0 CHANNEL A|17179869184|2133|2133|Unknown|X|26|8|DIMM 0|1200|16162600']).memoryModules[0].serial === '16162600')
  ok('BIOS 系統字串往後加欄位', m.parseStatic(['BIOS|AMI|F40a|2026-04-14|Default string|3.3|ALASKA|ALASKA - 1072009']).bios.systemBios === 'ALASKA - 1072009')
  // 舊版 fixture 根本沒有 BIOS 列 → bios 是 null，新欄位要能安全問
  ok('舊格式沒有 BIOS 列也不會炸', old.bios === null && old.memoryModules[0].serial === '')
}

// ===== 壓力測試（CPU／記憶體）=====
// 記憶體那半是 async（要等子程序回報實際配到多少），所以整段包成函式，
// 檔案最後跟 PawnIO 那段串起來一起跑
async function testStress() {
  console.log('\n[壓力測試]')
  const { createStressRunner, MEMORY_HEADROOM } = require(path.join(ROOT, 'src/main/sysmon/stress.js'))
  const runner = createStressRunner()
  const idle = runner.status()
  ok('沒開時 CPU 與記憶體都不在跑', !idle.cpu.running && !idle.memory.running)
  ok('回報這台機器的執行緒上限', idle.cpu.maxThreads === os.cpus().length)
  ok('五分鐘安全上限', idle.maxMs === 5 * 60 * 1000)
  ok('記憶體只吃可用量的七成', MEMORY_HEADROOM === 0.7)

  // run 一律要求 === true：任何真值都能開的話，renderer 傳個 1 就把 CPU 燒滿了
  ok('run 不是 true 就當成關',
    !runner.cpu('yes', 8).cpu.running && !(await runner.memory(1, 4)).memory.running)

  const two = runner.cpu(true, 2)
  ok('開兩條就是兩條', two.cpu.running && two.cpu.threads === 2)
  const over = runner.cpu(true, 9999)
  ok('執行緒數夾在邏輯核心數以內', over.cpu.threads === os.cpus().length)
  ok('關掉之後真的停', !runner.cpu(false, 2).cpu.running)

  // 記憶體改由 `ELECTRON_RUN_AS_NODE` 子程序去配（Electron 的 V8 sandbox 對整個 process
  // 的 ArrayBuffer 只給到約 8GB，而且停止要能立刻還給作業系統）。node 直跑時
  // `process.execPath` 是 node 本身，一樣開得起來
  const mem = await runner.memory(true, 1)
  ok('記憶體有配到東西', mem.memory.running && mem.memory.allocatedBytes > 0,
    `${(mem.memory.allocatedBytes / 1024 ** 3).toFixed(2)} GB`)
  ok('回報得出這台機器現在吃得下多少', mem.memory.maxGb >= 1 && mem.memory.totalGb >= 1,
    `${mem.memory.maxGb}/${mem.memory.totalGb} GB`)
  ok('停掉之後歸零', !(await runner.memory(false, 1)).memory.running)
  runner.shutdown()
  ok('shutdown 兩邊都收', !runner.status().cpu.running && !runner.status().memory.running)
}

// ===== GPU instance 名稱 =====
console.log('\n[GPU instance 名稱]')
{
  const g = m.parseGpuInstance('pid_41708_luid_0x00000000_0x0001210C_phys_0_eng_12_engtype_Copy')
  ok('取得 pid／卡號／引擎', g.pid === 41708 && g.adapter === '0x00000000_0x0001210C' && g.engine === 'Copy')
  ok('引擎索引也解析出來（配對 key 的一部分）', g.engineId === '12')
  const g2 = m.parseGpuInstance('pid_1234_luid_0x0_0x1_phys_1_eng_0_engtype_3D')
  ok('第二張卡', g2.adapter === '0x0_0x1' && g2.engine === '3D')
  ok('沒有 pid 就回 null', m.parseGpuInstance('_Total') === null)
  ok('VRAM 的 instance 沒有 engtype 也能解析', m.parseGpuInstance('pid_9_luid_0x0_0x1_phys_0').pid === 9)
}

// ===== 差值計算（核心）=====
console.log('\n[差值計算]')
{
  const T0 = 1_000_000_000_000_0000 // 100ns 時間戳
  const SEC = 1e7                    // 一秒 = 1e7 個 100ns

  const prev = m.parseTick([
    'T|1000000',
    'M|8000|100|200|300|400',
    'D|0 C:|1000|2000|0|' + T0,
    'N|Ethernet|10000|20000|1000000000',
    `G|pid_100_luid_0x0_0x1_phys_0_eng_0_engtype_3D|0|${T0}`,
    `P|100|chrome|0|${T0}|500|400|10|0|0|50|1`
  ])
  const curr = m.parseTick([
    'T|1001000',
    'M|7000|100|200|300|400',
    'D|0 C:|1000 |2000|0|' + (T0 + SEC),
    'N|Ethernet|10000|20000|1000000000',
    `G|pid_100_luid_0x0_0x1_phys_0_eng_0_engtype_3D|0|${T0 + SEC}`,
    `P|100|chrome|0|${T0 + SEC}|500|400|10|0|0|50|1`
  ])

  // 一秒內用掉 0.5 秒 CPU，8 核 → 每核心 6.25%
  curr.procs[0].cpuTime = 0.5 * SEC
  const d = m.diffSamples(prev, curr, 8)
  ok('每進程 CPU% 有除以邏輯核心數', near(d.processes[0].cpu, 6.25),
    `得到 ${d.processes[0].cpu}`)

  // 同樣的量在單核機器上就是 50%
  const d1 = m.diffSamples(prev, curr, 1)
  ok('單核時同樣的量是 50%', near(d1.processes[0].cpu, 50))

  // 累計 bytes → 速率
  curr.procs[0].ioRead = 2 * 1024 * 1024
  curr.procs[0].ioWrite = 1024 * 1024
  const d2 = m.diffSamples(prev, curr, 8)
  ok('進程磁碟讀取是 2MB/s', near(d2.processes[0].diskRead, 2 * 1024 * 1024, 1))
  ok('進程磁碟寫入是 1MB/s', near(d2.processes[0].diskWrite, 1024 * 1024, 1))

  // GPU：0.25 秒的引擎時間 / 1 秒 = 25%
  curr.gpuEngines[0].util = 0.25 * SEC
  const d3 = m.diffSamples(prev, curr, 8)
  ok('每進程 GPU% 由 100ns 差值算出', near(d3.processes[0].gpu, 25),
    `得到 ${d3.processes[0].gpu}`)
  ok('整張卡的使用率跟著出來', near(d3.gpuAdapterUtil['0x0_0x1'], 25))

  // 雙卡機 key 碰撞：同 pid 同 phys 同 engtype、只差 LUID 的兩個實例。
  // 跨卡配對會把新卡實例的小累計配上舊卡的大累計，爆出 >100% 的假使用率
  const dualPrev = m.parseTick([
    'T|1000000',
    `G|pid_100_luid_0x0_0xBBBB_phys_0_eng_7_engtype_3D|${0.001 * SEC}|${T0}`,
    `P|100|chrome|0|${T0}|500|400|10|0|0|50|1`
  ])
  const dualCurr = m.parseTick([
    'T|1001000',
    `G|pid_100_luid_0x0_0xAAAA_phys_0_eng_0_engtype_3D|${2 * SEC}|${T0 + SEC}`,
    `P|100|chrome|0|${T0 + SEC}|500|400|10|0|0|50|1`
  ])
  const dDual = m.diffSamples(dualPrev, dualCurr, 8)
  ok('LUID 不同的兩張卡不會跨卡配對（GPU% 不超過 100）', dDual.processes[0].gpu <= 100,
    `得到 ${dDual.processes[0].gpu}`)

  // 同一張卡、同一個 pid、同 engtype 但引擎索引不同的多個實例（實測 System 有兩個
  // Copy：eng_9 累計 41 億、eng_2 只有 2 萬）。少了引擎索引的 key 會讓它們互配，
  // 小實例配到大實例的上一輪 → 差值爆成假 100%，System 常駐 GPU 100% 就是這個
  const multiPrev = m.parseTick([
    'T|1000000',
    `G|pid_4_luid_0x0_0x1_phys_0_eng_3_engtype_Copy|${1e9}|${T0}`,
    `G|pid_4_luid_0x0_0x1_phys_0_eng_2_engtype_Copy|23256|${T0}`,
    `P|4|System|0|${T0}|500|400|10|0|0|50|1`
  ])
  const multiCurr = m.parseTick([
    'T|1001000',
    `G|pid_4_luid_0x0_0x1_phys_0_eng_3_engtype_Copy|${1e9 + 0.1 * SEC}|${T0 + SEC}`,
    `G|pid_4_luid_0x0_0x1_phys_0_eng_2_engtype_Copy|23256|${T0 + SEC}`,
    `P|4|System|0|${T0 + SEC}|500|400|10|0|0|50|1`
  ])
  const dMulti = m.diffSamples(multiPrev, multiCurr, 8)
  ok('同卡同 engtype 的多個引擎實例不互配', near(dMulti.processes[0].gpu, 10),
    `得到 ${dMulti.processes[0].gpu}`)

  // 繞回垃圾值：驅動把負的累計時間寫成 uint64 補數（實測 dwm 的某個 3D engine
  // 回報 ~2^64），差值會爆成天文數字再被夾成恆 100%
  const wrapCurr = m.parseTick([
    'T|1001000',
    `G|pid_100_luid_0x0_0x1_phys_0_eng_0_engtype_3D|${2 ** 64 - 59004125317}|${T0 + SEC}`,
    `P|100|chrome|0|${T0 + SEC}|500|400|10|0|0|50|1`
  ])
  const dWrap = m.diffSamples(prev, wrapCurr, 8)
  ok('補數繞回的引擎值不做差值（不爆成 100%）', dWrap.processes[0].gpu === 0,
    `得到 ${dWrap.processes[0].gpu}`)

  // 整機磁碟／網路
  curr.disks[0].read = 1000 + 5 * 1024 * 1024
  curr.nets[0].rx = 10000 + 1024 * 1024
  const d4 = m.diffSamples(prev, curr, 8)
  ok('整機磁碟讀取速率', near(d4.disks[0].read, 5 * 1024 * 1024, 1))
  ok('網路速率用牆上時鐘算（T 差 1000ms）', near(d4.nets[0].rx, 1024 * 1024, 1))

  // 第一輪沒有前一筆
  const first = m.diffSamples(null, curr, 8)
  ok('第一輪不會 NaN', first.processes.every((p) => Number.isFinite(p.cpu) && p.cpu === 0))

  // 計數器回捲（進程重啟、counter reset）不可以變成負速率
  const back = m.parseTick([`P|100|chrome|0|${T0 + SEC}|500|400|10|0|0|50|1`])
  back.procs[0].ioRead = -5
  const d5 = m.diffSamples(prev, back, 8)
  ok('計數器回捲夾成 0，不出現負速率', d5.processes[0].diskRead === 0)

  // 時間戳沒動（同一輪重送）→ 除以 0
  const same = m.parseTick([`P|100|chrome|999|${T0}|500|400|10|0|0|50|1`])
  const d6 = m.diffSamples(prev, same, 8)
  ok('時間戳沒前進時 CPU% 是 0 不是 Infinity', d6.processes[0].cpu === 0)

  // pid 重用：同一個 pid 換成別的程式，不能沿用上一輪的累計值
  const reused = m.parseTick([`P|100|notepad|${5 * SEC}|${T0 + SEC}|500|400|10|0|0|50|1`])
  const d7 = m.diffSamples(prev, reused, 8)
  ok('pid 被重用時不沿用舊累計值', d7.processes[0].cpu === 0)

  ok('_Total 彙總列不當成進程', m.parseTick([`P|0|_Total|0|${T0}|0|0|0|0|0|0|0`]).procs.length === 0)
  ok('Idle（pid 0）不當成進程：它的 CPU% 是 100 減整機負載，排在清單頂端會誤導',
    m.parseTick([`P|0|Idle|0|${T0}|0|0|0|0|0|0|0`]).procs.length === 0)
  ok('進程名的 #1 後綴剝掉', m.cleanProcName('chrome#12') === 'chrome')
}

// ===== 整機 CPU =====
console.log('\n[整機 CPU]')
{
  const mk = (user, sys, idle) => ({ times: { user, nice: 0, sys, idle, irq: 0 } })
  const prev = [mk(100, 100, 800), mk(0, 0, 1000)]
  const curr = [mk(200, 100, 800), mk(0, 0, 2000)]
  const r = m.cpuUsage(prev, curr)
  ok('第 0 核 100% 忙', near(r.perCore[0], 100))
  ok('第 1 核 0%', near(r.perCore[1], 0))
  ok('總量是每核心平均', near(r.total, 50))
  ok('沒有前一筆時回 0', m.cpuUsage(null, curr).total === 0)
  ok('時間沒前進時回 0 不是 NaN', m.cpuUsage(curr, curr).total === 0)
}

// ===== nvidia-smi =====
console.log('\n[nvidia-smi]')
{
  const g = m.parseNvidiaSmiRow('0, NVIDIA GeForce RTX 5060 Ti, 16311, 2842, 4, 32, 22.81, 787, 30')
  ok('欄位對位', g.name === 'NVIDIA GeForce RTX 5060 Ti' && g.memoryTotal === 16311 && g.temperature === 32)
  ok('功耗是小數', near(g.power, 22.81))
  ok('風扇有拿到', g.fan === 30)
  const na = m.parseNvidiaSmiRow('0, GPU, 8192, 100, 5, [N/A], [N/A], 300')
  ok('[N/A] 變 null 而不是 0', na.temperature === null && na.power === null,
    '0 會被畫成「溫度 0 度」')
  ok('欄位不足回 null', m.parseNvidiaSmiRow('garbage') === null)
  ok('空字串回 null', m.parseNvidiaSmiRow('') === null)

  // 尾端欄位是後來補的：舊版 nvidia-smi 少給幾格不能讓整列壞掉
  const full = m.parseNvidiaSmiRow(
    '0, RTX 5060 Ti, 16311, 2842, 4, 32, 22.81, 787, 30, 14001, 4, 16, 95.06.2E.00.1A')
  ok('記憶體時脈／PCIe／VBIOS 都解析得到',
    full.clockMem === 14001 && full.pcieGen === 4 && full.pcieWidth === 16 &&
    full.vbios === '95.06.2E.00.1A', JSON.stringify(full))
  ok('舊格式少給尾端欄位不會炸',
    g.clockMem === null && g.pcieGen === null && g.vbios === '')
}

// ===== 排序 =====
console.log('\n[排序]')
{
  const list = [
    { pid: 3, name: 'Bravo', cpu: 5, memory: 100, threads: 1, handles: 1, diskRead: 0, diskWrite: 0, gpu: 0, gpuMemory: 0, privateMemory: 1 },
    { pid: 1, name: 'alpha', cpu: 5, memory: 300, threads: 1, handles: 1, diskRead: 0, diskWrite: 0, gpu: 0, gpuMemory: 0, privateMemory: 1 },
    { pid: 2, name: 'Charlie', cpu: 9, memory: 200, threads: 1, handles: 1, diskRead: 0, diskWrite: 0, gpu: 0, gpuMemory: 0, privateMemory: 1 }
  ]
  ok('降冪 CPU', m.sortProcesses(list, 'cpu', 'desc').map((p) => p.pid).join() === '2,1,3')
  ok('升冪 CPU', m.sortProcesses(list, 'cpu', 'asc').map((p) => p.pid).join() === '1,3,2')
  ok('同值時以 pid 當第二鍵（順序不會每輪亂跳）',
    m.sortProcesses(list, 'cpu', 'desc').slice(1).map((p) => p.pid).join() === '1,3')
  ok('降冪記憶體', m.sortProcesses(list, 'memory', 'desc')[0].pid === 1)
  ok('名稱排序不分大小寫', m.sortProcesses(list, 'name', 'asc').map((p) => p.pid).join() === '1,3,2')
  ok('未知排序鍵退回 CPU', m.sortProcesses(list, 'not_a_key', 'desc')[0].pid === 2)
  ok('不改動原陣列', list[0].pid === 3)
  ok('磁碟合計是讀＋寫', m.SORT_KEYS.diskTotal({ diskRead: 2, diskWrite: 3 }) === 5)
}

// ===== 結束工作的 pid 驗證 =====
console.log('\n[結束工作 pid 驗證]')
{
  ok('正常 pid 過關', m.validateKillPid(1234).ok === true)
  ok('pid 0（系統閒置）擋掉', m.validateKillPid(0).ok === false)
  ok('pid 4（System）擋掉', m.validateKillPid(4).ok === false)
  ok('負數擋掉', m.validateKillPid(-1).ok === false)
  ok('小數擋掉', m.validateKillPid(12.5).ok === false)
  ok('字串擋掉', m.validateKillPid('1234; shutdown').ok === false)
  ok('null 擋掉', m.validateKillPid(null).ok === false)
  ok('物件擋掉', m.validateKillPid({ toString: () => '99' }).ok === false)
  ok('擋掉時有給理由', typeof m.validateKillPid(4).reason === 'string')
}

// ===== PawnIO 代裝 =====
// 這支會下載並提權執行外部安裝檔，所以「來源是固定常數」與「驗簽不過就不執行」是硬要求。
async function testPawnIo() {
  console.log('\n[PawnIO 代裝]')
  const pawnio = require(path.join(ROOT, 'src/main/sysmon/pawnio.js'))
  ok('下載網址是官方 release 的固定常數',
    pawnio.SETUP_URL === 'https://github.com/namazso/PawnIO.Setup/releases/latest/download/PawnIO_setup.exe')
  ok('下載走 https', pawnio.SETUP_URL.startsWith('https://'))
  ok('簽署者釘的是 PawnIO 作者', pawnio.EXPECTED_SIGNER === 'CN=namazso.eu')
  ok('安裝檔有大小上限', pawnio.MAX_SETUP_BYTES > 0 && pawnio.MAX_SETUP_BYTES <= 64 * 1024 * 1024)
  ok('isInstalled 回布林', typeof pawnio.isInstalled() === 'boolean')

  const src = fs.readFileSync(path.join(ROOT, 'src/main/sysmon/pawnio.js'), 'utf8')
  const code = src.split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*'))
    .join('\n')
  ok('靜默安裝參數是 -install -silent（/S 那些實測無效且不報錯）', code.includes("'-install','-silent'"))
  ok('驗簽同時要 Valid 與簽署者相符',
    code.includes("status === 'Valid'") && code.includes('subject.includes(EXPECTED_SIGNER)'))
  ok('驗簽失敗會丟錯而不是照樣安裝', code.includes('PAWNIO_BAD_SIGNATURE'))
  ok('安裝檔一律刪掉（finally）', /finally\s*\{[\s\S]*?unlinkSync/.test(code))
  ok('錯誤訊息不夾帶上游回應內容（只留狀態碼）', !code.includes('response.text()'))

  // 驗簽不過就不能執行：假的 PowerShell 回 Invalid，install 必須在 Start-Process 之前中止
  const calls = []
  const fakeSpawn = (_file, args) => {
    calls.push(args.join(' '))
    const child = {
      stdout: { setEncoding() {}, on(_e, fn) { fn('STATUS=Invalid\nSUBJECT=CN=evil\n') } },
      on(event, fn) { if (event === 'close') setTimeout(() => fn(0), 0); return child }
    }
    return child
  }
  const fakeFetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(64).buffer })
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'voiceink-pawnio-test-'))
  try {
    // isInstalledFn 固定回 false，測試機本來就裝了 PawnIO 也走得到驗簽那一段
    await pawnio.install({ fetchFn: fakeFetch, spawnFn: fakeSpawn, tmpDir: tmp, isInstalledFn: () => false })
    ok('簽章不符時中止安裝', false, '竟然安裝成功了')
    ok('簽章不符時沒有跑過 Start-Process', false)
    ok('中止後不留下安裝檔', false)
  } catch (error) {
    ok('簽章不符時中止安裝', error.code === 'PAWNIO_BAD_SIGNATURE', error.code)
    ok('簽章不符時沒有跑過 Start-Process', !calls.some((c) => c.includes('Start-Process')))
    ok('中止後不留下安裝檔', fs.readdirSync(tmp).length === 0)
  }
  fs.rmSync(tmp, { recursive: true, force: true })

  // 真的走一次 WinVerifyTrust：微軟簽的檔案「簽章有效」但簽署者不是 PawnIO 作者，必須回 false。
  // （正向案例需要真的下載安裝檔，留給 e2e-sysmon-sensors.js）
  const { spawn } = require('child_process')
  const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32',
    'WindowsPowerShell', 'v1.0', 'powershell.exe')
  ok('簽章有效但簽署者不對 → false', await pawnio.verifySignature(psExe, spawn) === false)
  ok('沒有簽章的檔案 → false',
    await pawnio.verifySignature(path.join(ROOT, 'package.json'), spawn) === false)
}

// ===== 感測器 sidecar 斷線自己重拉 =====
// sidecar 被防毒收掉／自己崩掉時，畫面上的溫度就再也不會回來（狀態停在 off，沒人重試）。
// 重拉走排程工作那條，所以不會彈 UAC。
async function testSensorReconnect() {
  console.log('\n[感測器斷線重拉]')
  const net = require('net')
  const { createSensorBridge } = require(path.join(ROOT, 'src/main/sysmon/sensors.js'))
  /** @type {net.Socket[]} */
  const clients = []
  let lost = 0
  const bridge = createSensorBridge({
    resolveExe: () => path.join(ROOT, 'package.json'), // 只要「存在」就好，這條測試不真的開 sidecar
    onLost: () => { lost += 1 },
    // 假的排程工作：直接用一條 socket 冒充連上來的 sidecar
    task: {
      run: (pipeName) => new Promise((resolve) => {
        const c = net.connect(pipeName, () => { clients.push(c); c.write('{"h":[]}\n'); resolve(true) })
        c.on('error', () => resolve(false))
      }),
      status: async () => ({ installed: true, stale: false, canInstall: true, reason: '' }),
      install: async () => ({ installed: true, stale: false }),
      remove: async () => ({ installed: false, stale: false })
    }
  })

  const first = await bridge.enable({ elevate: false })
  ok('排程工作拉起來就是 on', first.state === 'on', first.state)

  clients.pop().destroy()
  await new Promise((r) => setTimeout(r, 3600))
  ok('sidecar 死掉會自己重拉', lost === 1, `lost=${lost}`)
  ok('重拉期間狀態不是 on', bridge.status().state !== 'on', bridge.status().state)

  // stop() 是「使用者要它停」，不可以被當成斷線又拉回來
  await bridge.enable({ elevate: false })
  await bridge.stop()
  await new Promise((r) => setTimeout(r, 3600))
  ok('stop() 之後不重拉', lost === 1, `lost=${lost}`)
  for (const c of clients) { try { c.destroy() } catch { /* 已經斷了 */ } }
}

testStress().then(testPawnIo).then(testSensorReconnect).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
})
