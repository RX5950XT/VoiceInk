'use strict'

/**
 * VoiceInk — 系統監控的純計算層。
 *
 * 這個檔案**不 require electron、不開程序、不碰檔案**，所以 `node scripts/test-sysmon.js`
 * 可以直接載入它跑回歸。probe.ps1 只負責把作業系統的**累計計數器**原封不動吐出來，
 * 「每秒多少」「百分之幾」全部在這裡算——原因是差值需要「上一輪」，而只有 main 這邊留得住。
 *
 * 計數器語意（弄錯就會得到很像真的、但完全錯的數字）：
 *   PercentProcessorTime / UtilizationPercentage 在 *PerfRawData* 類別裡**不是百分比**，
 *   是累計的 100 奈秒 CPU/GPU 時間；要除以同一筆資料附的 Timestamp_Sys100NS 差值。
 *   DiskReadBytesPersec / IOReadBytesPersec 同理**不是速率**，是累計 bytes。
 */

const HUNDRED_NS_PER_SEC = 1e7

/**
 * 累計的 100ns 計數器是 uint64，驅動把它寫成負數時會以補數出現（≥2^63），
 * 實測 dwm 的某個 GPUEngine 就這樣回報 ~2^64 的值（dwm 常駐 GPU 100% 的元兇之一）。
 * 合法的累計 CPU/GPU 時間到不了 2^63（=29000 年），超過就是垃圾值，不准拿去做差值。
 */
const COUNTER_WRAP = 2 ** 63

/** 進程表可排序的欄位 → 取值函式。renderer 只送 key，這裡是唯一的白名單。 */
const SORT_KEYS = Object.freeze({
  pid: (p) => p.pid,
  name: (p) => p.name.toLowerCase(),
  cpu: (p) => p.cpu,
  memory: (p) => p.memory,
  privateMemory: (p) => p.privateMemory,
  threads: (p) => p.threads,
  handles: (p) => p.handles,
  diskRead: (p) => p.diskRead,
  diskWrite: (p) => p.diskWrite,
  diskTotal: (p) => p.diskRead + p.diskWrite,
  gpu: (p) => p.gpu,
  gpuMemory: (p) => p.gpuMemory
})

/**
 * SMBIOS／WMI 的數字代碼 → 看得懂的字。都是規格書上的固定表，不是猜的：
 * `Win32_PhysicalMemory.SMBIOSMemoryType`（DDR5=34、DDR4=26）、`.FormFactor`、
 * `Win32_SystemEnclosure.ChassisTypes`、`Win32_NetworkAdapter.NetConnectionStatus`、
 * `Win32_Battery.Chemistry`。查無此號就留白，**不要退回「未知」以外的猜測值**。
 */
const MEMORY_TYPES = Object.freeze({
  20: 'DDR', 21: 'DDR2', 24: 'DDR3', 26: 'DDR4', 34: 'DDR5', 35: 'LPDDR4', 36: 'LPDDR5'
})
const FORM_FACTORS = Object.freeze({ 8: 'DIMM', 12: 'SODIMM', 13: 'SRIMM' })
const CHASSIS_TYPES = Object.freeze({
  3: '桌上型', 4: '低矮桌上型', 6: '直立式', 7: '塔式', 8: '可攜式',
  9: '筆記型', 10: '筆記型', 13: 'All-in-One', 23: '機架式', 30: '平板', 31: '筆記型', 32: '可拆式'
})
const NIC_STATUS = Object.freeze({
  0: '已中斷', 1: '連線中', 2: '已連線', 4: '硬體不存在', 5: '硬體已停用', 7: '未連接線路'
})
const BATTERY_CHEMISTRY = Object.freeze({ 3: '鉛酸', 4: '鎳鎘', 5: '鎳氫', 6: '鋰離子', 7: '鋅空氣', 8: '鋰聚合物' })
/** `Win32_SystemSlot`：CurrentUsage 3=空著、4=插了東西；MaxDataWidth 是 PCIe 通道數的編碼 */
const SLOT_USAGE = Object.freeze({ 1: '其他', 2: '未知', 3: '空置', 4: '使用中' })
const SLOT_WIDTH = Object.freeze({ 5: '×1', 6: '×2', 7: '×4', 8: '×8', 9: '×12', 10: '×16', 11: '×32' })
/** `Win32_Processor.Architecture` */
const CPU_ARCH = Object.freeze({ 0: 'x86', 1: 'MIPS', 2: 'Alpha', 3: 'PowerPC', 5: 'ARM', 6: 'Itanium', 9: 'x64', 12: 'ARM64' })
/** `WmiMonitorConnectionParams.VideoOutputTechnology`（D3DKMDT_VIDEO_OUTPUT_TECHNOLOGY） */
const VIDEO_OUTPUT = Object.freeze({
  0: '其他', 1: 'VGA', 2: 'S-Video', 3: '複合視訊', 4: '色差視訊', 5: 'DVI', 6: 'HDMI',
  7: 'LVDS', 9: 'SDI', 10: 'DisplayPort', 11: 'DisplayPort（內建）', 12: 'UDI',
  13: 'UDI（內建）', 14: 'SDTV 轉接器', 15: 'Miracast', 16: '間接有線'
})
/** `Win32_PortConnector.PortType`（SMBIOS Type 8／9 的編碼）。常用的先翻，其餘顯示代號 */
const PORT_TYPES = Object.freeze({
  16: 'USB', 17: 'USB（其他）', 26: '乙太網路', 27: 'Token Ring', 28: '顯示埠', 29: '音源 jack',
  30: 'PS/2', 31: '音源（其他）', 32: '音源（迷你）', 34: 'SATA', 35: 'SAS', 36: 'Thunderbolt'
})

/**
 * ATA／SATA 的 S.M.A.R.T. 屬性編號 → 名稱。這是 T13 規格外的**業界慣例表**，
 * 各家廠商對同一個編號的解讀不完全一樣（尤其 SSD 的 160 以上），所以查無此號
 * 一律顯示成「屬性 0xNN」而不是猜一個名字——猜錯比留白危險得多。
 */
const ATA_ATTRS = Object.freeze({
  1: '讀取錯誤率', 2: '輸出效能', 3: '啟動時間', 4: '啟停次數', 5: '重新配置的磁區數',
  7: '搜尋錯誤率', 8: '搜尋時間效能', 9: '通電時數', 10: '重試啟動次數', 11: '磁頭校正重試',
  12: '通電次數', 170: '可用備援區塊', 171: '程式化失敗次數', 172: '抹除失敗次數',
  173: '抹除次數均衡', 174: '非正常斷電次數', 175: '程式化失敗（總計）', 177: '抹除次數均衡度',
  179: '已用備援區塊', 180: '未使用的備援區塊', 181: '程式化失敗總數', 182: '抹除失敗總數',
  183: 'SATA 降速次數', 184: '端對端錯誤', 187: '無法修正的錯誤', 188: '指令逾時',
  190: '氣流溫度', 191: 'G-Sensor 錯誤率', 192: '斷電磁頭收回次數', 193: '磁頭載入次數',
  194: '溫度', 195: '硬體 ECC 修正', 196: '重新配置事件數', 197: '待處理磁區數',
  198: '無法修正的磁區數', 199: 'UDMA CRC 錯誤', 200: '寫入錯誤率', 201: '軟讀取錯誤率',
  202: '資料位址標記錯誤', 231: '剩餘壽命', 232: '剩餘備援空間', 233: 'NAND 寫入量',
  234: '抹除／寫入次數', 241: '主機寫入總量', 242: '主機讀取總量', 249: 'NAND 寫入總量'
})

/** NVMe Identify Controller 推出來的支援功能 → 顯示名 */
const NVME_FEATURES = Object.freeze({
  trim: 'TRIM（Dataset Management）',
  vwc: '揮發性寫入快取',
  apst: '自動省電狀態切換',
  fwupd: '韌體線上更新'
})

/**
 * SMBIOS 沒填時 OEM 會塞這幾個佔位字串。原樣顯示等於在規格表上寫「Default string」，
 * 比留白更糟（看起來像我們讀錯）。一律當成空值，讓 UI 顯示破折號。
 */
const PLACEHOLDERS = new Set([
  'default string', 'to be filled by o.e.m.', 'to be filled by o.e.m',
  'system manufacturer', 'system product name', 'system version', 'system serial number',
  'unknown', 'none', 'n/a', 'not specified', 'not available', 'o.e.m.', 'oem'
])

/** @param {unknown} v @returns {string} */
function clean(v) {
  const s = String(v ?? '').trim()
  return PLACEHOLDERS.has(s.toLowerCase()) ? '' : s
}

/**
 * 克氏 → 攝氏。NVMe 沒實作的溫度感測器會回 0 K，那是「沒有這顆感測器」不是 −273 度。
 * @param {unknown} kelvin @returns {number|null}
 */
function kelvinToC(kelvin) {
  const k = Number(kelvin)
  if (!Number.isFinite(k) || k <= 0) return null
  return Math.round(k - 273.15)
}

/**
 * 硬碟健康度判定（CrystalDiskInfo 的「良好／警告／不良」那一格）。
 *
 * 判準刻意保守：**只有廠商自己說壞了才叫「不良」**（NVMe 的 critical warning 位元、
 * 備援空間低於廠商門檻、ATA 屬性掉到門檻值以下）。把「用掉 90% 壽命」講成不良
 * 會讓一顆還能用好幾年的碟看起來要死了，使用者會去換一顆不用換的硬碟。
 * @param {any} s parseStatic 產出的 smart 項目
 * @returns {{ level: 'good'|'caution'|'bad', reason: string }}
 */
function smartHealth(s) {
  if (!s) return { level: 'good', reason: '' }
  if (s.criticalWarning > 0) return { level: 'bad', reason: '硬碟回報了嚴重警告旗標' }
  if (s.spareThreshold > 0 && s.spare > 0 && s.spare < s.spareThreshold) {
    return { level: 'bad', reason: `備援空間 ${s.spare}% 已低於廠商門檻 ${s.spareThreshold}%` }
  }
  // threshold 為 0 代表這條屬性沒有門檻（廠商只拿來記數），不能當成「已經掉到門檻」
  const failing = (s.attributes || []).filter((a) => a.threshold > 0 && a.current > 0 && a.current <= a.threshold)
  if (failing.length) return { level: 'bad', reason: `${failing[0].name} 已達廠商門檻` }
  if (s.usedPct >= 90) return { level: 'caution', reason: `已用掉 ${s.usedPct}% 的寫入壽命` }
  const bad = (s.attributes || []).find((a) => (a.id === 5 || a.id === 197 || a.id === 198) && a.raw > 0)
  if (bad) return { level: 'caution', reason: `${bad.name}：${bad.raw}` }
  if (s.mediaErrors > 0) return { level: 'caution', reason: `媒體與資料完整性錯誤 ${s.mediaErrors} 次` }
  return { level: 'good', reason: '' }
}

/** 不准結束的 pid：0 = System Idle、4 = System。砍下去是藍畫面，不是「結束工作」。 */
const PROTECTED_PIDS = new Set([0, 4])

/** @param {unknown} v @returns {number} */
function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * probe.ps1 的輸出是 `#B <kind> <seq>` … `#E <kind> <seq>` 框住的列。
 * 逐行餵進來，收滿一框才回傳；框外的雜訊（PowerShell 自己印的東西）一律丟掉。
 * @returns {{ push: (line: string) => ({ kind: string, seq: number, rows: string[] } | null), ready: () => boolean }}
 */
function createFrameParser() {
  /** @type {{ kind: string, seq: number, rows: string[] } | null} */
  let open = null
  let ready = false
  return {
    ready: () => ready,
    push(line) {
      const text = String(line ?? '').replace(/\r$/, '')
      if (text === '#READY') {
        ready = true
        return null
      }
      if (text.startsWith('#B ')) {
        const [, kind, seq] = text.split(' ')
        open = { kind: kind || '', seq: num(seq), rows: [] }
        return null
      }
      if (text.startsWith('#E ')) {
        const done = open
        open = null
        if (!done) return null
        const [, kind] = text.split(' ')
        // 框頭框尾對不上就整框丟掉（stdout 被截斷時會這樣）
        return kind === done.kind ? done : null
      }
      if (!open) return null
      if (text === '') return null
      open.rows.push(text)
      return null
    }
  }
}

/**
 * 一次性硬體清單。壞行直接跳過——WMI 在某些機器上會少欄位，少一列不該讓整頁空白。
 * @param {string[]} rows
 */
function parseStatic(rows) {
  /** @type {any} */
  const out = {
    cpus: [], board: null, bios: null, os: null, system: null, chassis: null,
    memoryModules: [], memoryArray: null, caches: [],
    gpus: [], physicalDisks: [], volumes: [], pageFiles: [], smart: [],
    monitors: [], nics: [], sound: [], audioEndpoints: [], cameras: [], bluetooth: [],
    ports: [], hotfixes: [], batteries: [], security: null,
    slots: [], usbControllers: [], inputDevices: [], timeZone: null
  }
  for (const row of rows) {
    const f = row.split('|')
    switch (f[0]) {
      case 'SYS':
        out.system = {
          vendor: clean(f[1]), model: clean(f[2]), systemType: f[3] || '',
          totalMemory: num(f[4]), hostname: f[5] || '', family: clean(f[6]),
          workgroup: f[7] || '', inDomain: f[8] === 'True', user: f[9] || '',
          hypervisor: f[10] === 'True', pcType: num(f[11]),
          bootState: f[12] || '', socketCount: num(f[13])
        }
        break
      case 'CASE':
        out.chassis = { vendor: clean(f[1]), type: CHASSIS_TYPES[num(f[2])] || '', serial: clean(f[3]) }
        break
      case 'CPU':
        out.cpus.push({
          name: f[1] || '', cores: num(f[2]), threads: num(f[3]),
          maxClockMhz: num(f[4]), l2CacheKb: num(f[5]), l3CacheKb: num(f[6]),
          socket: f[7] || '', vendor: f[8] || '',
          // 以下是後來補的欄位；舊版 probe 不給，f[i] 會是 undefined → '' / 0
          processorId: f[9] || '', addressWidth: num(f[10]),
          virtualization: f[11] === 'True', voltage: num(f[12]) / 10,
          description: f[13] || '', currentClockMhz: num(f[14]),
          extClockMhz: num(f[15]), family: num(f[16]), stepping: f[17] || '',
          enabledCores: num(f[18]), arch: CPU_ARCH[num(f[19])] || '', revision: num(f[20])
        })
        break
      case 'CACHE':
        // SMBIOS 的 Level：3=L1、4=L2、5=L3。InstalledSize 單位是 KB
        out.caches.push({ level: num(f[1]) - 2, sizeKb: num(f[2]), purpose: f[4] || '' })
        break
      case 'MEMARR':
        // MaxCapacityEx 單位是 KB；32 位元的 MaxCapacity 在 >2TB 時會爆，只當退路
        out.memoryArray = { slots: num(f[1]), maxCapacity: (num(f[2]) || num(f[3])) * 1024 }
        break
      case 'BOARD':
        out.board = { vendor: clean(f[1]), product: clean(f[2]), version: clean(f[3]), serial: clean(f[4]) }
        break
      case 'BIOS':
        out.bios = {
          vendor: clean(f[1]), version: clean(f[2]), releaseDate: f[3] || '',
          serial: clean(f[4]), smbios: f[5] && f[5] !== '.' ? f[5] : '', internalVersion: clean(f[6]),
          systemBios: clean(f[7])
        }
        break
      case 'OS':
        out.os = {
          caption: f[1] || '', version: f[2] || '', build: f[3] || '', bootedAt: num(f[4]),
          arch: f[5] || '', displayVersion: f[6] || '', ubr: num(f[7]), languages: f[8] || '',
          systemDrive: f[9] || '', windowsDir: f[10] || '', installedAt: f[11] || '',
          edition: f[12] || '', registeredUser: clean(f[13]),
          // 這兩個 WMI 欄位的單位是 KB
          pagingKb: num(f[14]), virtualKb: num(f[15])
        }
        break
      case 'TZ':
        out.timeZone = { caption: f[1] || '', name: f[2] || '', biasMin: num(f[3]) }
        break
      case 'RAM':
        out.memoryModules.push({
          bank: f[1] || '', capacity: num(f[2]), speedMhz: num(f[3]),
          configuredMhz: num(f[4]), vendor: clean(f[5]), partNumber: clean(f[6]),
          type: MEMORY_TYPES[num(f[7])] || '', formFactor: FORM_FACTORS[num(f[8])] || '',
          slot: f[9] || '', voltageMv: num(f[10]), serial: clean(f[11])
        })
        break
      case 'GPU':
        out.gpus.push({
          name: f[1] || '', adapterRam: num(f[2]), driver: f[3] || '', mode: f[4] || '',
          driverDate: f[5] || '', width: num(f[6]), height: num(f[7]),
          refreshHz: num(f[8]), processor: f[9] || '', pnpId: f[10] || '',
          // AdapterRAM 是 uint32（16GB 的卡回 4293918720），有登錄檔的 64 位元真值就用它
          vram: num(f[11]) || num(f[2])
        })
        break
      case 'PDISK':
        out.physicalDisks.push({
          id: f[1] || '', name: f[2] || '', mediaType: f[3] || '', busType: f[4] || '',
          size: num(f[5]), health: f[6] || '', serial: clean(f[7]),
          firmware: f[8] || '', spindleRpm: num(f[9]),
          partitions: num(f[11]), interfaceType: f[12] || '',
          logicalSector: num(f[13]), physicalSector: num(f[14]),
          // 韌體回的序號常帶一整段補零與尾隨空白（`0000_..._2324.`），
          // 貼在規格表上難讀；`AdapterSerialNumber`／`FruId` 才是雷射刻在標籤上的那組
          adapterSerial: clean(String(f[15] || '').replace(/_0+\d*$/, '').trim()),
          fruId: clean(f[16]), partitionStyle: f[17] || '',
          isBoot: f[18] === 'True', isSystem: f[19] === 'True', isReadOnly: f[20] === 'True',
          allocated: num(f[21]), location: clean(f[22])
        })
        break
      case 'SMART':
        out.smart.push({
          id: f[1] || '', proto: f[2] || '', criticalWarning: num(f[3]),
          tempC: kelvinToC(f[4]), spare: num(f[5]), spareThreshold: num(f[6]), usedPct: num(f[7]),
          powerOnHours: num(f[8]), powerCycles: num(f[9]), unsafeShutdowns: num(f[10]),
          bytesRead: num(f[11]), bytesWritten: num(f[12]),
          hostReadCmds: num(f[13]), hostWriteCmds: num(f[14]),
          mediaErrors: num(f[15]), errorLogEntries: num(f[16]), busyMinutes: num(f[17]),
          warnTempMinutes: num(f[18]), critTempMinutes: num(f[19]),
          // 先濾掉空字串再轉數字：`''.split(' ')` 是 `['']`，`Number('')` 是 0，
          // 直接 map 會讓「一顆感測器都沒有」變成畫面上的「0 °C」
          sensorsC: String(f[20] || '').split(' ').filter(Boolean).map(Number).filter(Number.isFinite),
          warnTempC: kelvinToC(f[21]), critTempC: kelvinToC(f[22]),
          specVersion: f[23] || '',
          features: String(f[24] || '').split(' ').filter(Boolean).map((k) => NVME_FEATURES[k] || k),
          firmwareSlots: num(f[25]),
          /** @type {any[]} ATA 才有；probe 用另外的 SMATTR 列補進來 */
          attributes: []
        })
        break
      case 'SMATTR': {
        // 屬性列一定跟在自己那顆碟的 SMART 列後面；對不到的（probe 只送了屬性沒送表頭）就丟掉
        const owner = out.smart.find((x) => x.id === (f[1] || ''))
        if (!owner) break
        const attrId = num(f[2])
        owner.attributes.push({
          id: attrId,
          name: ATA_ATTRS[attrId] || `屬性 0x${attrId.toString(16).toUpperCase().padStart(2, '0')}`,
          current: num(f[3]), worst: num(f[4]), threshold: num(f[5]), raw: num(f[6])
        })
        break
      }
      case 'PAGE':
        // WMI 這三格的單位是 MB
        out.pageFiles.push({
          name: f[1] || '', sizeMb: num(f[2]), usedMb: num(f[3]), peakMb: num(f[4])
        })
        break
      case 'VOL':
        out.volumes.push({
          drive: f[1] || '', label: f[2] || '', size: num(f[3]),
          free: num(f[4]), fileSystem: f[5] || '', diskId: f[6] || ''
        })
        break
      case 'MON':
        out.monitors.push({
          vendor: f[1] || '', name: f[2] || '', serial: clean(f[3]),
          year: num(f[4]), sizeCm: f[5] || '', native: f[6] || '',
          connector: f[7] ? (VIDEO_OUTPUT[num(f[7])] || '') : '',
          week: num(f[8]), productCode: f[9] || ''
        })
        break
      case 'NIC':
        out.nics.push({
          connection: f[1] || '', name: f[2] || '', mac: f[3] || '',
          speed: num(f[4]), status: NIC_STATUS[num(f[5])] || '', ips: f[6] || '',
          gateway: f[7] || '', dns: f[8] || '', dhcp: f[9] || '',
          subnet: f[10] || '', dhcpServer: f[11] || '', ipv6: f[12] || '',
          adapterType: f[13] || '', pnpId: f[14] || ''
        })
        break
      case 'SND':
        out.sound.push({ name: f[1] || '', vendor: clean(f[2]), status: f[3] || '' })
        break
      case 'AEND':
        out.audioEndpoints.push({ name: f[1] || '' })
        break
      case 'CAM':
        out.cameras.push({ name: f[1] || '', vendor: clean(f[2]), status: f[3] || '' })
        break
      case 'BT':
        out.bluetooth.push({ name: f[1] || '', status: f[2] || '' })
        break
      case 'PORT':
        // PortType 是 SMBIOS Type 8/9 的編碼；16=USB、31/32=音源、28=顯示、26=網路
        out.ports.push({
          name: f[1] || '', portType: PORT_TYPES[num(f[2])] || '',
          connectorType: num(f[3])
        })
        break
      case 'QFE':
        out.hotfixes.push({ id: f[1] || '', installedOn: f[2] || '' })
        break
      case 'QFEC':
        out.hotfixTotal = num(f[1])
        break
      case 'SLOT':
        out.slots.push({
          name: f[1] || '', usage: SLOT_USAGE[num(f[2])] || '',
          width: SLOT_WIDTH[num(f[3])] || '', tag: f[4] || ''
        })
        break
      case 'USBC':
        out.usbControllers.push({ name: f[1] || '', vendor: clean(f[2]), status: f[3] || '' })
        break
      case 'HID':
        // probe 已依描述去重，`count` 是同一支裝置在 HID 堆疊上被列到幾次
        out.inputDevices.push({
          kind: f[1] === 'kb' ? '鍵盤' : '指標裝置',
          name: f[2] || '', detail: clean(f[3]), count: num(f[4])
        })
        break
      case 'BAT':
        out.batteries.push({
          name: f[1] || '', charge: num(f[2]), status: num(f[3]),
          designVoltageMv: num(f[4]), chemistry: BATTERY_CHEMISTRY[num(f[5])] || ''
        })
        break
      case 'SEC':
        out.security = {
          secureBoot: f[1] || '', firmware: f[2] || '', tpm: f[3] || '', installedAt: f[4] || ''
        }
        break
      default:
        break
    }
  }
  return out
}

/** GPU engine 的 instance name：`pid_1234_luid_0x0_0x1210C_phys_0_eng_12_engtype_3D` */
function parseGpuInstance(name) {
  const pid = /pid_(\d+)/.exec(name)
  const luid = /luid_(.+?)_phys/.exec(name)
  const phys = /_phys_(\d+)/.exec(name)
  const engId = /_eng_(\d+)_/.exec(name)
  const eng = /_engtype_(.+)$/.exec(name)
  if (!pid) return null
  return {
    pid: num(pid[1]),
    // 卡的 key 必須含 LUID：雙卡機上同一個 pid 同 engtype 的兩個實例 phys 都是 0，
    // 只拿 phys 當 key 會跨卡配對——程式在兩張卡之間搬 context 時，新卡實例的
    // 累計值從 0 起算、舊卡實例已累積數小時，差值會爆出 >100% 的假使用率
    adapter: luid ? luid[1] : (phys ? phys[1] : '0'),
    // 引擎索引也必須進 key：同一個 pid 在同一張卡上可以有多個同 engtype 的實例
    // （實測 System 兩個 Copy、explorer 在 iGPU 上 16 個 3D），少了它們會互配——
    // 小累計的實例配上大累計的上一輪，差值爆成假 100%（跟 LUID 那條同一型）
    engineId: engId ? engId[1] : '?',
    engine: eng ? eng[1] : 'unknown'
  }
}

/**
 * 一輪原始取樣。全部都是「累計值 + 時間戳」，差值留給 diffSamples。
 * @param {string[]} rows
 */
function parseTick(rows) {
  /** @type {any} */
  const s = {
    tMs: 0,
    memory: null,
    disks: [],
    driveTemps: [],
    nets: [],
    gpuEngines: [],
    gpuMemory: [],
    procs: []
  }
  for (const row of rows) {
    const f = row.split('|')
    switch (f[0]) {
      case 'T':
        s.tMs = num(f[1])
        break
      case 'M':
        s.memory = {
          available: num(f[1]), standby: num(f[2]),
          committed: num(f[3]), commitLimit: num(f[4]), cache: num(f[5])
        }
        break
      case 'D':
        s.disks.push({
          name: f[1] || '', read: num(f[2]), write: num(f[3]),
          idle: num(f[4]), ts: num(f[5])
        })
        break
      case 'DT': {
        // NVMe 的即時溫度／已用壽命。溫度為 null 時整列不收——0 K 不是「0 度」
        const tempC = kelvinToC(f[2])
        if (tempC != null) s.driveTemps.push({ id: f[1] || '', tempC, usedPct: num(f[3]), spare: num(f[4]) })
        break
      }
      case 'N':
        s.nets.push({ name: f[1] || '', rx: num(f[2]), tx: num(f[3]), linkSpeed: num(f[4]) })
        break
      case 'G': {
        const info = parseGpuInstance(f[1] || '')
        if (info) s.gpuEngines.push({ ...info, util: num(f[2]), ts: num(f[3]) })
        break
      }
      case 'V': {
        const info = parseGpuInstance(f[1] || '')
        if (info) s.gpuMemory.push({ pid: info.pid, dedicated: num(f[2]), shared: num(f[3]) })
        break
      }
      case 'P':
        // `_Total` 是彙總列；`Idle`（pid 0）不是真的進程——它的「CPU%」其實是
        // 100 減整機負載，排在依 CPU 遞減的清單頂端時，看起來就像「有個程序
        // 吃掉 60% CPU」。工作管理員的「處理程序」分頁預設也不顯示它。
        if ((f[2] || '') === '_Total' || num(f[1]) === 0) break
        s.procs.push({
          pid: num(f[1]),
          name: f[2] || '',
          cpuTime: num(f[3]),
          ts: num(f[4]),
          memory: num(f[5]),
          privateMemory: num(f[6]),
          threads: num(f[7]),
          ioRead: num(f[8]),
          ioWrite: num(f[9]),
          handles: num(f[10]),
          parentPid: num(f[11])
        })
        break
      default:
        break
    }
  }
  return s
}

/** 進程名在 perf counter 裡重名會加 `#1`／`#2` 後綴，顯示時剝掉 */
function cleanProcName(name) {
  return name.replace(/#\d+$/, '')
}

/**
 * 兩輪之間的差值 → 使用者看得懂的數字。
 * @param {ReturnType<typeof parseTick> | null} prev
 * @param {ReturnType<typeof parseTick>} curr
 * @param {number} logicalCores
 */
function diffSamples(prev, curr, logicalCores) {
  const cores = Math.max(1, num(logicalCores) || 1)
  const elapsedSec = prev ? Math.max(0.001, (curr.tMs - prev.tMs) / 1000) : 0

  // ── 每進程 GPU：先把每張卡每種引擎的「該 pid 佔比」算出來 ─────────────
  /** @type {Map<number, number>} */
  const gpuByPid = new Map()
  /** @type {Map<string, number>} */
  const engineTotals = new Map()
  if (prev) {
    const prevEngines = new Map()
    for (const e of prev.gpuEngines) prevEngines.set(`${e.pid}|${e.adapter}|${e.engineId}|${e.engine}`, e)
    for (const e of curr.gpuEngines) {
      const before = prevEngines.get(`${e.pid}|${e.adapter}|${e.engineId}|${e.engine}`)
      if (!before) continue
      // 補數繞回的垃圾值（驅動寫出的負數）不做差值：會把該進程夾成恆 100%
      if (e.util >= COUNTER_WRAP || before.util >= COUNTER_WRAP) continue
      const dTs = e.ts - before.ts
      if (dTs <= 0) continue
      const pct = ((e.util - before.util) / dTs) * 100
      if (!(pct > 0)) continue
      // 工作管理員的「GPU」欄位取的是該進程用得最兇的那個引擎，不是全部相加；單引擎不可能超過 100%
      gpuByPid.set(e.pid, Math.min(100, Math.max(gpuByPid.get(e.pid) || 0, pct)))
      const engKey = `${e.adapter}|${e.engine}`
      engineTotals.set(engKey, (engineTotals.get(engKey) || 0) + pct)
    }
  }
  /** @type {Map<string, number>} 每張卡的總使用率＝該卡最忙的引擎 */
  const gpuAdapterUtil = new Map()
  for (const [key, value] of engineTotals) {
    const adapter = key.split('|')[0]
    gpuAdapterUtil.set(adapter, Math.min(100, Math.max(gpuAdapterUtil.get(adapter) || 0, value)))
  }

  /** @type {Map<number, { dedicated: number, shared: number }>} */
  const vramByPid = new Map()
  for (const v of curr.gpuMemory) {
    const acc = vramByPid.get(v.pid) || { dedicated: 0, shared: 0 }
    acc.dedicated += v.dedicated
    acc.shared += v.shared
    vramByPid.set(v.pid, acc)
  }

  // ── 進程 ──────────────────────────────────────────────────────────
  const prevProcs = new Map()
  if (prev) for (const p of prev.procs) prevProcs.set(`${p.pid}|${p.name}`, p)

  const processes = curr.procs.map((p) => {
    const before = prevProcs.get(`${p.pid}|${p.name}`)
    let cpu = 0
    let diskRead = 0
    let diskWrite = 0
    if (before) {
      const dTs = p.ts - before.ts
      // 同一族 uint64 累計計數器：垃圾值不做差值（同 GPU engine 那條）
      if (dTs > 0 && p.cpuTime < COUNTER_WRAP && before.cpuTime < COUNTER_WRAP) {
        cpu = ((p.cpuTime - before.cpuTime) / dTs) * 100 / cores
        const sec = dTs / HUNDRED_NS_PER_SEC
        diskRead = Math.max(0, (p.ioRead - before.ioRead) / sec)
        diskWrite = Math.max(0, (p.ioWrite - before.ioWrite) / sec)
      }
    }
    const vram = vramByPid.get(p.pid)
    return {
      pid: p.pid,
      name: cleanProcName(p.name),
      cpu: Math.max(0, Math.min(100, cpu)),
      memory: p.memory,
      privateMemory: p.privateMemory,
      threads: p.threads,
      handles: p.handles,
      parentPid: p.parentPid,
      diskRead,
      diskWrite,
      gpu: gpuByPid.get(p.pid) || 0,
      gpuMemory: vram ? vram.dedicated : 0
    }
  })

  // ── 磁碟 ──────────────────────────────────────────────────────────
  const prevDisks = new Map()
  if (prev) for (const d of prev.disks) prevDisks.set(d.name, d)
  const disks = curr.disks.map((d) => {
    const before = prevDisks.get(d.name)
    let read = 0
    let write = 0
    if (before) {
      const sec = (d.ts - before.ts) / HUNDRED_NS_PER_SEC
      if (sec > 0) {
        read = Math.max(0, (d.read - before.read) / sec)
        write = Math.max(0, (d.write - before.write) / sec)
      }
    }
    return { name: d.name, read, write }
  })

  // ── 網路 ──────────────────────────────────────────────────────────
  const prevNets = new Map()
  if (prev) for (const n of prev.nets) prevNets.set(n.name, n)
  const nets = curr.nets.map((n) => {
    const before = prevNets.get(n.name)
    let rx = 0
    let tx = 0
    if (before && elapsedSec > 0) {
      rx = Math.max(0, (n.rx - before.rx) / elapsedSec)
      tx = Math.max(0, (n.tx - before.tx) / elapsedSec)
    }
    return { name: n.name, rx, tx, linkSpeed: n.linkSpeed }
  })

  return {
    tMs: curr.tMs,
    memory: curr.memory,
    processes,
    disks,
    // 累計值不用做差，直接原樣往上送
    driveTemps: curr.driveTemps,
    nets,
    gpuAdapterUtil: Object.fromEntries(gpuAdapterUtil)
  }
}

/**
 * 整機 CPU 使用率。用 Node 的 os.cpus() 而不是再開一次 WMI：免費、每核心都有。
 * @param {{ times: { user: number, nice: number, sys: number, idle: number, irq: number } }[] | null} prev
 * @param {{ times: { user: number, nice: number, sys: number, idle: number, irq: number } }[]} curr
 * @returns {{ total: number, perCore: number[] }}
 */
function cpuUsage(prev, curr) {
  const perCore = curr.map((core, i) => {
    const before = prev && prev[i]
    if (!before) return 0
    const a = before.times
    const b = core.times
    const idle = b.idle - a.idle
    const busy = (b.user - a.user) + (b.nice - a.nice) + (b.sys - a.sys) + (b.irq - a.irq)
    const total = idle + busy
    if (total <= 0) return 0
    return Math.max(0, Math.min(100, (busy / total) * 100))
  })
  const total = perCore.length
    ? perCore.reduce((sum, v) => sum + v, 0) / perCore.length
    : 0
  return { total, perCore }
}

/**
 * nvidia-smi 的 CSV（--format=csv,noheader,nounits）。
 * 拿不到的欄位上游會給 `[N/A]`，一律當成 null 而不是 0——0 會被畫成「溫度 0 度」。
 * @param {string} line
 */
function parseNvidiaSmiRow(line) {
  const f = String(line || '').split(',').map((v) => v.trim())
  if (f.length < 8) return null
  const val = (s) => {
    if (!s || /^\[?N\/A\]?$/i.test(s)) return null
    const n = Number(s)
    return Number.isFinite(n) ? n : null
  }
  return {
    index: val(f[0]) ?? 0,
    name: f[1] || 'GPU',
    memoryTotal: val(f[2]),
    memoryUsed: val(f[3]),
    utilization: val(f[4]),
    temperature: val(f[5]),
    power: val(f[6]),
    clockSm: val(f[7]),
    fan: val(f[8]),
    clockMem: val(f[9]),
    pcieGen: val(f[10]),
    pcieWidth: val(f[11]),
    vbios: f[12] && !/^\[?N\/A\]?$/i.test(f[12]) ? f[12] : ''
  }
}

/**
 * @param {any[]} list
 * @param {string} key
 * @param {'asc'|'desc'} dir
 */
function sortProcesses(list, key, dir) {
  const pick = SORT_KEYS[key] || SORT_KEYS.cpu
  const sign = dir === 'asc' ? 1 : -1
  // pid 當第二鍵：CPU 都是 0 的時候不加這個，每輪順序都會跳
  return [...list].sort((a, b) => {
    const av = pick(a)
    const bv = pick(b)
    if (av < bv) return -sign
    if (av > bv) return sign
    return a.pid - b.pid
  })
}

/**
 * 結束工作的 pid 驗證。IPC 的信任邊界——renderer 傳什麼都要當成不可信。
 * @param {unknown} pid
 * @returns {{ ok: true, pid: number } | { ok: false, reason: string }}
 */
function validateKillPid(pid) {
  // 刻意只收 number：`Number({ toString: () => '99' })` 會乖乖給你 99，
  // 用 Number() 當守衛等於讓任何物件都能假裝成 pid。
  if (typeof pid !== 'number') return { ok: false, reason: '無效的處理程序 ID' }
  const n = pid
  if (!Number.isInteger(n) || n < 0) return { ok: false, reason: '無效的處理程序 ID' }
  if (PROTECTED_PIDS.has(n)) return { ok: false, reason: '這是系統核心處理程序，不能結束' }
  return { ok: true, pid: n }
}

module.exports = {
  SORT_KEYS,
  PROTECTED_PIDS,
  MEMORY_TYPES,
  ATA_ATTRS,
  NVME_FEATURES,
  PORT_TYPES,
  kelvinToC,
  smartHealth,
  createFrameParser,
  parseStatic,
  parseTick,
  parseGpuInstance,
  cleanProcName,
  diffSamples,
  cpuUsage,
  parseNvidiaSmiRow,
  sortProcesses,
  validateKillPid
}
