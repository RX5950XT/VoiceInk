/**
 * 打包版 CDP：系統監控頁
 * 用法：node scripts/e2e-sysmon-cdp.js（會自己啟動 dist/win-unpacked/VoiceInk.exe）
 *
 * 驗證重點：
 *  - probe.ps1 在打包版真的跑得起來（asarUnpack 有生效；PowerShell 執行不了 asar 內的檔案）
 *  - 進程表是**虛擬捲動**：400+ 列時 DOM 只有幾十個節點（這一頁的效能就是驗收標準）
 *  - 排序在升冪／降冪之間切換，且 aria-sort 跟著改
 *  - 搜尋會過濾
 *  - 「結束工作」要選了列才會亮，而且是**彈窗二次確認**，不是按了就殺
 *  - 離開分頁會停掉取樣（PowerShell 不該在背景整天跑）
 *
 * **絕不結束使用者的任何處理程序**：只驗按鈕與彈窗的狀態，真正的 kill 由
 * `npx electron scripts/e2e-sysmon.js` 用它自己 spawn 的子程序覆蓋。
 * 會改到 `sysmonInterval`／`sysmonSort`／`sysmonSensors` 三個 store key，開頭讀下來、finally 寫回。
 */
const { spawn } = require('child_process')
const path = require('path')
const os = require('os')
const fs = require('fs')
const http = require('http')

const PORT = 9247
// Windows 偶爾會有別的東西鎖住 dist/win-unpacked（打包失敗、防毒掃描中），
// 這時可以打包到別的資料夾再用 VOICEINK_EXE 指過去，測試不必等鎖放掉
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
// 暫存 user-data-dir：使用者開著的正式實例佔 single-instance lock，
// 沒有自己的資料夾會被擋掉（second-instance 轉交後退出，CDP 等不到主視窗）
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-cdp-'))
const RESTORE_KEYS = ['sysmonInterval', 'sysmonSort', 'sysmonSensors']
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
      })
    }).on('error', reject)
  })
}

class Cdp {
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
    this.exceptions = []
  }

  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve)
      this.ws.addEventListener('error', reject)
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(message.params?.exceptionDetails?.exception?.description || 'runtime exception')
      }
      if (!message.id || !this.pending.has(message.id)) return
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
    await this.send('Runtime.enable')
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    }
    return result.result?.value
  }

  close() { try { this.ws.close() } catch { /* ignore */ } }
}

async function waitFor(action, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await action()) return true
    await sleep(300)
  }
  throw new Error(`等待逾時：${label}`)
}

async function main() {
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`], { stdio: ['ignore', 'pipe', 'pipe'] })
  let processLog = ''
  child.stdout.on('data', (c) => { processLog += c })
  child.stderr.on('data', (c) => { processLog += c })

  let cdp = null
  let original = null
  let passed = 0
  let failed = 0
  const ok = (name, cond, extra = '') => {
    if (cond) { passed++; console.log(`PASS  ${name}`) }
    else { failed++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`) }
  }

  try {
    const target = await (async () => {
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        const pages = await getJson(`http://127.0.0.1:${PORT}/json/list`).catch(() => [])
        const page = pages.filter((p) => p.type === 'page').find((p) => /index\.html/.test(p.url))
        if (page) return page
        await sleep(400)
      }
      throw new Error('等不到主視窗')
    })()
    cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.connect()
    await waitFor(
      () => cdp.eval(`document.readyState === 'complete' && typeof window.electronAPI?.sysmon?.status === 'function'`),
      15000, 'preload 初始化'
    )

    original = await cdp.eval(`(async () => {
      const keys = ${JSON.stringify(RESTORE_KEYS)}
      const out = {}
      for (const k of keys) out[k] = await window.electronAPI.store.get(k, null)
      return out
    })()`)

    // 提權感測器預設會在進頁時自動啟用（走 UAC）。自動化測試不能停在那扇對話框前，
    // 所以先關掉；finally 會把使用者原本的值寫回去。
    await cdp.eval(`window.electronAPI.store.set('sysmonSensors', false)`)

    // ── 分頁 ────────────────────────────────────────────────────
    const nav = await cdp.eval(`(() => {
      const tabs = [...document.querySelectorAll('.nav-tab')].map((t) => t.dataset.page)
      return { tabs, hasPage: Boolean(document.getElementById('page-sysmon')) }
    })()`)
    ok('nav 有系統監控分頁', nav.tabs.includes('sysmon'), JSON.stringify(nav.tabs))
    // 只固定相對位置（在翻譯之後、設定之前）；中間有沒有別的分頁不是這支要管的
    // （終端機已併入聊天頁，nav 沒有 terminal 了）
    ok('系統監控排在翻譯之後、設定之前',
      nav.tabs.indexOf('translate') < nav.tabs.indexOf('sysmon') &&
      nav.tabs.indexOf('sysmon') < nav.tabs.indexOf('settings'), nav.tabs.join(','))
    ok('page-sysmon 存在', nav.hasPage)

    await cdp.eval(`document.querySelector('[data-page="sysmon"]').click()`)
    ok('切過去之後是 active',
      await cdp.eval(`document.getElementById('page-sysmon').classList.contains('active')`))

    // ── 取樣真的跑起來（打包版最容易掛在 asarUnpack）────────────
    await waitFor(
      () => cdp.eval(`(document.getElementById('sysmonBlocks')?.children.length || 0) > 0`),
      25000, '第一輪取樣'
    )
    const blocks = await cdp.eval(`(() => {
      const host = document.getElementById('sysmonBlocks')
      return [...host.children].map((c) => ({
        id: c.dataset.block,
        value: c.querySelector('.sysmon-block-value')?.textContent || '',
        stats: c.querySelectorAll('.sysmon-stat').length,
        spark: Boolean(c.querySelector('canvas.sysmon-block-spark')),
        bodyHidden: c.querySelector('.sysmon-block-body').hidden,
        expanded: c.querySelector('.sysmon-block-head').getAttribute('aria-expanded')
      }))
    })()`)
    ok('打包版的 probe.ps1 跑得起來（有硬體區塊）', blocks.length >= 6, JSON.stringify(blocks.map((b) => b.id)))
    ok('有 CPU 區塊且值不是 —', blocks.some((b) => b.id === 'cpu' && b.value.endsWith('%')),
      JSON.stringify(blocks.find((b) => b.id === 'cpu')))
    ok('有記憶體與 GPU 區塊',
      blocks.some((b) => b.id === 'memory') && blocks.some((b) => b.id.startsWith('gpu')))
    ok('有儲存、網路、主機板、系統區塊',
      ['storage', 'network', 'board', 'system'].every((id) => blocks.some((b) => b.id === id)),
      JSON.stringify(blocks.map((b) => b.id)))
    ok('每個區塊都有關鍵讀數', blocks.every((b) => b.stats > 0))
    // 進頁預設就是完整資訊：沒按過任何東西的狀態下每一塊都要是展開的
    ok('預設全部展開', blocks.every((b) => b.expanded === 'true' && !b.bodyHidden),
      JSON.stringify(blocks.map((b) => [b.id, b.expanded])))

    // 漸進式揭露：收起時內文不進 DOM 佈局，展開才長出視覺化與規格
    const collapsed = await cdp.eval(`(() => {
      document.querySelector('[data-block="cpu"] .sysmon-block-head').click()
      const cpu = document.querySelector('[data-block="cpu"]')
      return {
        hidden: cpu.querySelector('.sysmon-block-body').hidden,
        // 只看 .hidden 屬性抓不到真正的坑：作者寫的 display 會壓過瀏覽器內建的
        // [hidden]{display:none}，屬性明明是 true 但畫面上照樣展開著（實際出貨過）
        height: cpu.querySelector('.sysmon-block-body').offsetHeight,
        expanded: cpu.querySelector('.sysmon-block-head').getAttribute('aria-expanded'),
        gauge: Boolean(cpu.querySelector('.sysmon-gauge > i').style.width)
      }
    })()`)
    ok('收起時內文是 hidden', collapsed.hidden && collapsed.expanded === 'false', JSON.stringify(collapsed))
    ok('收起時內文真的不佔版面', collapsed.height === 0, `offsetHeight=${collapsed.height}`)
    ok('收起時仍有進度條這個視覺摘要', collapsed.gauge)

    const expanded = await cdp.eval(`(() => {
      document.querySelector('[data-block="cpu"] .sysmon-block-head').click()
      const cpu = document.querySelector('[data-block="cpu"]')
      return {
        hidden: cpu.querySelector('.sysmon-block-body').hidden,
        height: cpu.querySelector('.sysmon-block-body').offsetHeight,
        expanded: cpu.querySelector('.sysmon-block-head').getAttribute('aria-expanded'),
        cores: cpu.querySelectorAll('.sysmon-corecell').length,
        specs: cpu.querySelectorAll('.sysmon-block-body > .sysmon-spec-grid dd').length,
        subs: cpu.querySelectorAll('details.sysmon-sub').length
      }
    })()`)
    ok('展開後內文出現', !expanded.hidden && expanded.expanded === 'true' && expanded.height > 0, JSON.stringify(expanded))
    ok('CPU 展開後有每執行緒長條', expanded.cores > 1, String(expanded.cores))

    // 靜態清單是取樣器的第二個框，機器忙時會晚一點到——等它，不要寫死 sleep
    await waitFor(
      () => cdp.eval(
        `document.querySelector('[data-block="board"] .sysmon-block-sub')?.textContent !== '偵測中…'`
      ),
      45000, '硬體清單'
    )

    // 補上的硬體資訊：主機板／顯示器／網路卡／音效這幾塊以前完全沒有
    const extra = await cdp.eval(`(() => {
      document.querySelectorAll('.sysmon-block-head[aria-expanded="false"]').forEach((h) => h.click())
      const text = (id) => document.querySelector('[data-block="' + id + '"]')?.textContent || ''
      return {
        board: text('board'),
        system: text('system'),
        network: text('network'),
        storage: text('storage'),
        memory: text('memory'),
        cpu: text('cpu'),
        monitors: text('monitors'),
        subs: document.querySelectorAll('#sysmonBlocks details.sysmon-sub').length,
        cpuSpecs: document.querySelectorAll('[data-block="cpu"] > .sysmon-block-body > .sysmon-spec-grid dd').length
      }
    })()`)
    // 規格表要等靜態清單到齊；在那之前 describeBlocks 只給得出即時數值
    ok('CPU 展開後有完整規格表', extra.cpuSpecs >= 10, String(extra.cpuSpecs))
    ok('主機板區塊有 BIOS 版本與日期',
      extra.board.includes('BIOS 版本') && extra.board.includes('BIOS 日期'), extra.board.slice(0, 160))
    ok('系統區塊有作業系統與音效裝置',
      extra.system.includes('作業系統') && extra.system.includes('音效裝置'), extra.system.slice(0, 160))
    ok('網路區塊有網路介面卡明細', extra.network.includes('網路介面卡'), extra.network.slice(0, 160))
    ok('儲存區塊有實體磁碟與磁碟區明細',
      extra.storage.includes('實體磁碟') && extra.storage.includes('磁碟區'), extra.storage.slice(0, 160))
    ok('同性質的長清單都收在可展開的子項裡', extra.subs >= 4, String(extra.subs))
    // 後補的硬體資訊（都要真的有值，不能只是多一列破折號）
    ok('CPU 規格有 L1 快取', /L1 快取\s*\d/.test(extra.cpu.replace(/\s+/g, ' ')), extra.cpu.slice(0, 200))
    ok('記憶體有插槽總數與主機板上限',
      extra.memory.includes('主機板上限') && /\d+ 條 \/ \d+ 槽/.test(extra.memory), extra.memory.slice(0, 200))
    ok('網路有預設閘道與 DNS',
      extra.network.includes('預設閘道') && extra.network.includes('DNS 伺服器'), extra.network.slice(0, 200))
    ok('顯示器有桌面配置（每台的解析度與更新率）',
      extra.monitors.includes('桌面配置') && extra.monitors.includes('縮放'), extra.monitors.slice(0, 200))

    // 第二批補上的規格（總覽以前整片留白的那些）。全部要求「標籤 + 真的有值」，
    // 只斷言標籤在不在的話，資料源壞掉時會是一整排破折號卻照樣綠燈
    // `textContent` 把 dt 跟 dd 直接接在一起（「架構x64」而不是「架構 x64」），所以標籤與值之間是 `\s*`
    const flat = (s) => s.replace(/\s+/g, ' ')
    ok('CPU 有架構與外頻', /架構\s*x64/.test(flat(extra.cpu)) && /外頻\s*\d/.test(flat(extra.cpu)), flat(extra.cpu).slice(-260))
    ok('CPU 有快取階層子項', extra.cpu.includes('快取階層'), extra.cpu.slice(0, 240))
    ok('記憶體有通道數與分頁檔', /通道\s*\d+\s*通道/.test(flat(extra.memory)) && extra.memory.includes('分頁檔'), flat(extra.memory).slice(-260))
    ok('儲存有硬體總容量與磁碟區可用', extra.storage.includes('硬體總容量') && extra.storage.includes('磁碟區可用'), flat(extra.storage).slice(0, 240))
    ok('網路有子網路遮罩與主要連線', /子網路遮罩\s*\d/.test(flat(extra.network)) && extra.network.includes('主要連線'), flat(extra.network).slice(-260))
    ok('主機板有 SMBIOS 版本與擴充插槽', /SMBIOS 版本\s*\d/.test(flat(extra.board)) && extra.board.includes('擴充插槽'), flat(extra.board).slice(-260))
    ok('主機板有 USB 控制器子項', extra.board.includes('USB 控制器'), extra.board.slice(0, 240))
    // 韌體模式與 TPM 掛在主機板那一塊（跟安全開機同一組），不是系統那塊。
    // `$env:firmware_type` 被 spawn 時不存在，所以這一格要靠 SecureBoot 機碼推——空著就是那條退路壞了
    ok('主機板有韌體模式與 TPM',
      /韌體模式\s*(UEFI|Legacy)/.test(flat(extra.board)) && /TPM\s*\S/.test(flat(extra.board)), flat(extra.board).slice(-300))
    ok('顯示器有面板原生解析度', /面板原生解析度\s*\d/.test(flat(extra.monitors)), flat(extra.monitors).slice(-260))
    ok('系統有功能更新版本與安裝日期',
      /功能更新版本\s*\w/.test(flat(extra.system)) && /安裝日期\s*\d{4}-/.test(flat(extra.system)), flat(extra.system).slice(0, 300))
    ok('系統有輸入裝置子項', extra.system.includes('輸入裝置'), extra.system.slice(0, 300))
    // 第三批（盤點補上的）：攝影機／藍牙／I/O 埠／音訊端點／Windows 更新
    ok('系統有喇叭與麥克風子項', extra.system.includes('喇叭與麥克風'), extra.system.slice(0, 300))
    ok('系統有攝影機子項', extra.system.includes('攝影機'), extra.system.slice(0, 300))
    ok('主機板有機殼 I/O 埠子項', extra.board.includes('機殼 I/O 埠') && /USB|HDMI|音源/.test(extra.board), extra.board.slice(0, 300))
    ok('系統有 Windows 更新子項', extra.system.includes('Windows 更新') && /KB\d+/.test(extra.system), extra.system.slice(-400))
    // ── S.M.A.R.T.（CrystalDiskInfo 那一塊）────────────────────────
    // NVMe 走 access=0 的 IOCTL，**不需要提權**，所以打包版也該有；
    // 全 SATA 的機器可能拿不到（那條多半要系統管理員），所以先問有沒有 NVMe
    const hasNvme = await cdp.eval(`(async () => {
      // sysmon 的 IPC 一律包成 { ok, data }；忘了拆 data 的話這裡永遠是 undefined，
      // 症狀是整段 SMART 斷言被「這台沒有 NVMe」安靜跳過（假綠燈）
      const inv = (await window.electronAPI.sysmon.inventory())?.data
      return (inv?.physicalDisks || []).some((d) => /nvme/i.test(d.busType))
    })()`)
    // `extra` 是硬體清單剛到齊那一刻的快照，那時通常只跑過第一輪 tick——
    // 而第一輪 tick 比 static 早送出（sampler 在 launch 就排了），所以還沒有 DT 溫度列。
    // 溫度這幾格要等下一輪，重抓一次文字才問得到。
    await sleep(2500)
    const st = flat(await cdp.eval(`document.querySelector('[data-block="storage"]')?.textContent || ''`))
    if (!hasNvme) {
      console.log('  SKIP 這台沒有 NVMe，跳過 SMART 的 UI 斷言')
    } else {
      ok('儲存區塊有 S.M.A.R.T. 子項', extra.storage.includes('S.M.A.R.T.'), st.slice(0, 240))
      ok('健康狀態有真的判定過（不是破折號）', /健康狀態\s*(良好|警告|不良)/.test(st), st.slice(0, 300))
      // 忘了減 273 的症狀是「17134 °C」而不是報錯。上限用 200 而不是「兩位數」——
      // 廠商的警告／危險門檻本來就是 100／110 °C，那兩個是對的
      ok('溫度是攝氏不是克氏',
        /溫度\s*\d{1,2}\s*°C/.test(st) && !/(?:^|\D)(?:[2-9]\d{2}|\d{4,})\s*°C/.test(st), st.slice(0, 400))
      ok('有通電時數與通電次數', /通電時數\s*[\d,]+ 小時/.test(st) && /通電次數\s*[\d,]+ 次/.test(st), st.slice(-400))
      // Data Units Written 的單位是 1000×512 bytes；當成 bytes 會顯示成幾十 MB
      ok('累計寫入是 TB／GB 等級', /累計寫入\s*[\d.]+\s*(GB|TB)/.test(st), st.slice(-400))
      ok('有剩餘壽命與備援空間', /剩餘壽命\s*\d+%/.test(st) && /可用備援空間\s*\d+%/.test(st), st.slice(-400))
      ok('有 NVMe 規格版本與支援功能', /NVMe 規格版本\s*\d+\.\d+/.test(st) && st.includes('TRIM'), st.slice(-400))
      ok('實體磁碟列有磁區大小與分割配置', /磁區 \d+B\/\d+B/.test(st) && st.includes('GPT'), st.slice(0, 400))
      // 感測器 sidecar 要 UAC（測試裡是關掉的），這格有值就代表退回 NVMe 溫度那條路真的通
      ok('沒有感測器元件時也看得到硬碟溫度', /各硬碟即時速率[\s\S]*?\d+ °C/.test(st), st.slice(0, 500))
    }

    // SMBIOS 沒填時 OEM 會塞這幾個字串，原樣顯示等於規格表上寫著「Default string」
    const all = [extra.board, extra.system, extra.cpu, extra.memory, extra.storage].join(' ')
    ok('沒有把 SMBIOS 佔位字串當成規格顯示',
      !/Default string|To be filled by O\.E\.M/i.test(all), all.slice(0, 200))

    // 規格值一律完整顯示：被 ellipsis 截掉的那筆等於沒有資料（實際出貨過，
    // 裝置 ID／序號那種長字串沒有空白可斷，一定要 overflow-wrap 才折得下去）
    await cdp.eval(`document.querySelectorAll('#sysmonBlocks details.sysmon-sub').forEach((d) => { d.open = true })`)
    await sleep(1200)
    const clipped = await cdp.eval(`(() => {
      const sel = '#sysmonBlocks .sysmon-spec-grid dd, #sysmonBlocks .sysmon-spec-grid dt,'
        + ' #sysmonBlocks .sysmon-metercell > i'
      const bad = []
      for (const el of document.querySelectorAll(sel)) {
        if (el.scrollWidth > el.clientWidth + 1) bad.push(el.textContent.slice(0, 40))
      }
      return { count: bad.length, sample: bad.slice(0, 5) }
    })()`)
    ok('沒有任何欄位被截成「…」', clipped.count === 0, JSON.stringify(clipped.sample))

    // 展開狀態要記得住（重畫每 1～2 秒一次，記不住的話會自己彈回去）
    await sleep(2500)
    const stillOpen = await cdp.eval(
      `document.querySelector('[data-block="cpu"] .sysmon-block-head').getAttribute('aria-expanded')`
    )
    ok('下一輪取樣不會把展開狀態洗掉', stillOpen === 'true', String(stillOpen))

    // ── 進程表：虛擬捲動 ────────────────────────────────────────
    await cdp.eval(`document.querySelector('.sysmon-tab[data-subtab="processes"]').click()`)
    await sleep(400)
    const table = await cdp.eval(`(() => {
      const rows = document.querySelectorAll('#sysmonRows .sysmon-row:not(.hidden)')
      const spacer = document.getElementById('sysmonSpacer')
      const count = document.getElementById('sysmonProcCount').textContent
      const total = Number((count.match(/(\\d+)\\s*個/) || [])[1] || 0)
      return {
        domRows: document.querySelectorAll('#sysmonRows .sysmon-row').length,
        visibleRows: rows.length,
        spacerHeight: parseInt(spacer.style.height, 10) || 0,
        total,
        cols: document.querySelectorAll('#sysmonHead .sysmon-th').length,
        firstCells: rows[0] ? [...rows[0].children].map((c) => c.textContent) : []
      }
    })()`)
    ok('列出的是整台機器的所有處理程序', table.total > 100, String(table.total))
    ok('spacer 撐出完整高度', table.spacerHeight >= table.total * 30 - 1,
      `${table.spacerHeight} vs ${table.total * 30}`)
    ok('虛擬捲動：DOM 節點遠少於總列數', table.domRows < 60 && table.domRows < table.total,
      `DOM ${table.domRows} / 總 ${table.total}`)
    ok('有八個欄位', table.cols === 8, String(table.cols))
    ok('第一列有資料', table.firstCells.length === 8 && table.firstCells[0].length > 0,
      JSON.stringify(table.firstCells))

    // 捲到底之後仍然只有那幾十個節點（節點池有在重用）
    await cdp.eval(`(() => {
      const body = document.getElementById('sysmonBody')
      body.scrollTop = body.scrollHeight
      body.dispatchEvent(new Event('scroll'))
    })()`)
    await sleep(200)
    const afterScroll = await cdp.eval(`(() => ({
      domRows: document.querySelectorAll('#sysmonRows .sysmon-row').length,
      transform: document.getElementById('sysmonRows').style.transform,
      firstPid: document.querySelector('#sysmonRows .sysmon-row:not(.hidden)')?.dataset.pid || ''
    }))()`)
    ok('捲到底之後節點數沒有暴增', afterScroll.domRows < 60, String(afterScroll.domRows))
    ok('捲動是靠 transform 位移', /translateY\([1-9]/.test(afterScroll.transform), afterScroll.transform)
    await cdp.eval(`(() => { const b = document.getElementById('sysmonBody'); b.scrollTop = 0; b.dispatchEvent(new Event('scroll')) })()`)
    await sleep(200)

    // ── 排序 ────────────────────────────────────────────────────
    const sortState = async () => cdp.eval(`(() => {
      const th = document.querySelector('#sysmonHead .sysmon-th.is-sorted')
      const rows = [...document.querySelectorAll('#sysmonRows .sysmon-row:not(.hidden)')]
      return {
        key: th?.dataset.key || '',
        aria: th?.getAttribute('aria-sort') || '',
        pids: rows.slice(0, 6).map((r) => Number(r.dataset.pid)),
        cells: rows.slice(0, 6).map((r) => r.children[2].textContent)
      }
    })()`)
    // 不假設「預設就是 CPU 降冪」：排序會存進 store，上一次跑完留下來的值也算數
    await cdp.eval(`(() => {
      const th = document.querySelector('#sysmonHead .sysmon-th[data-key="cpu"]')
      th.click()
      if (th.getAttribute('aria-sort') !== 'descending') th.click()
    })()`)
    await sleep(150)
    const cpuDesc = await sortState()
    ok('可以切成 CPU 降冪', cpuDesc.key === 'cpu' && cpuDesc.aria === 'descending', JSON.stringify(cpuDesc))
    ok('CPU 降冪真的由高到低',
      cpuDesc.cells.map((c) => parseFloat(c) || 0).every((v, i, a) => i === 0 || a[i - 1] >= v),
      JSON.stringify(cpuDesc.cells))

    await cdp.eval(`document.querySelector('#sysmonHead .sysmon-th[data-key="pid"]').click()`)
    await sleep(150)
    const pidAsc = await sortState()
    ok('點 PID 欄改成 PID 升冪', pidAsc.key === 'pid' && pidAsc.aria === 'ascending', JSON.stringify(pidAsc))
    ok('PID 升冪真的由小到大',
      pidAsc.pids.every((v, i, a) => i === 0 || a[i - 1] <= v), JSON.stringify(pidAsc.pids))

    await cdp.eval(`document.querySelector('#sysmonHead .sysmon-th[data-key="pid"]').click()`)
    await sleep(150)
    const pidDesc = await sortState()
    ok('再點一次變降冪', pidDesc.aria === 'descending', JSON.stringify(pidDesc))
    ok('PID 降冪真的由大到小',
      pidDesc.pids.every((v, i, a) => i === 0 || a[i - 1] >= v), JSON.stringify(pidDesc.pids))

    await cdp.eval(`document.querySelector('#sysmonHead .sysmon-th[data-key="memory"]').click()`)
    await sleep(150)
    const memDesc = await cdp.eval(`(() => {
      const th = document.querySelector('#sysmonHead .sysmon-th.is-sorted')
      return { key: th?.dataset.key, aria: th?.getAttribute('aria-sort') }
    })()`)
    ok('記憶體欄預設降冪（想看誰吃最多）',
      memDesc.key === 'memory' && memDesc.aria === 'descending', JSON.stringify(memDesc))

    ok('排序有寫回 store',
      (await cdp.eval(`window.electronAPI.store.get('sysmonSort', '')`)) === 'memory:desc')

    // ── 搜尋 ────────────────────────────────────────────────────
    const beforeFilter = await cdp.eval(`document.getElementById('sysmonProcCount').textContent`)
    await cdp.eval(`(() => {
      const input = document.getElementById('sysmonSearch')
      input.value = 'VoiceInk'
      input.dispatchEvent(new Event('input'))
    })()`)
    await sleep(200)
    const filtered = await cdp.eval(`(() => ({
      count: document.getElementById('sysmonProcCount').textContent,
      names: [...document.querySelectorAll('#sysmonRows .sysmon-row:not(.hidden)')]
        .map((r) => r.children[1].textContent)
    }))()`)
    ok('搜尋會過濾', filtered.count !== beforeFilter && filtered.count.includes('/'),
      `${beforeFilter} → ${filtered.count}`)
    ok('過濾結果都符合關鍵字',
      filtered.names.length > 0 && filtered.names.every((n) => n.toLowerCase().includes('voiceink')),
      JSON.stringify(filtered.names))

    await cdp.eval(`(() => {
      const input = document.getElementById('sysmonSearch')
      input.value = ''
      input.dispatchEvent(new Event('input'))
    })()`)
    await sleep(200)

    // ── 強制結束：只驗按鈕與彈窗狀態，**不真的殺任何東西** ───────
    const beforeSelect = await cdp.eval(`(() => ({
      end: Boolean(document.getElementById('sysmonEndBtn')),
      kill: document.getElementById('sysmonKillBtn').disabled
    }))()`)
    ok('沒有溫和的「結束工作」鈕，只留強制結束', beforeSelect.end === false)
    ok('沒選列時強制結束是 disabled', beforeSelect.kill, JSON.stringify(beforeSelect))

    const selected = await cdp.eval(`(() => {
      const row = document.querySelector('#sysmonRows .sysmon-row:not(.hidden)')
      row.click()
      return {
        pid: row.dataset.pid,
        marked: row.classList.contains('is-selected'),
        kill: document.getElementById('sysmonKillBtn').disabled
      }
    })()`)
    ok('點列會選取', selected.marked)
    ok('選了之後強制結束才亮', !selected.kill, JSON.stringify(selected))

    await sleep(600)
    ok('選取後會顯示細節', (await cdp.eval(`document.getElementById('sysmonDetail').textContent.length`)) > 0)

    const dialogState = await cdp.eval(`(() => {
      document.getElementById('sysmonKillBtn').click()
      const d = document.getElementById('sysmonKillDialog')
      return {
        open: d.open,
        desc: document.getElementById('sysmonKillDesc').textContent,
        confirmLabel: document.getElementById('sysmonKillConfirm').textContent,
        force: document.getElementById('sysmonKillConfirm').dataset.force
      }
    })()`)
    ok('強制結束會先跳二次確認，不是按了就殺', dialogState.open === true)
    ok('確認彈窗有講清楚要殺哪一個',
      dialogState.desc.includes(selected.pid) && dialogState.desc.includes('強制'), dialogState.desc)
    ok('確認鈕標示為強制結束', dialogState.confirmLabel === '強制結束' && dialogState.force === '1')

    // 取消（絕不按確認）
    await cdp.eval(`document.getElementById('sysmonKillCancel').click()`)
    await sleep(150)
    ok('取消會關掉彈窗且什麼都沒做',
      (await cdp.eval(`document.getElementById('sysmonKillDialog').open`)) === false)

    // ── 壓力測試面板 ────────────────────────────────────────────
    await cdp.eval(`document.querySelector('.sysmon-tab[data-subtab="stress"]').click()`)
    await sleep(200)
    const stressUi = await cdp.eval(`(() => ({
      webgl2: Boolean(document.createElement('canvas').getContext('webgl2')),
      hasCanvas: Boolean(document.getElementById('sysmonStressCanvas')),
      startDisabled: document.getElementById('sysmonStressStart').disabled,
      stopDisabled: document.getElementById('sysmonStressStop').disabled,
      cards: document.querySelectorAll('#sysmon-stress .sysmon-stress-card').length,
      warn: document.querySelectorAll('#sysmon-stress .sysmon-warn').length,
      // 2×2：四張卡只佔兩種 left 值
      columns: new Set([...document.querySelectorAll('#sysmon-stress .sysmon-stress-card')]
        .map((c) => Math.round(c.getBoundingClientRect().left))).size,
      canvasShown: !document.getElementById('sysmonStressCanvas').hidden,
      gauges: document.querySelectorAll('#sysmon-stress .sysmon-metercell').length,
      gaugeText: document.getElementById('sysmonStressDisks').textContent
        + document.getElementById('sysmonStressCpu').textContent,
      // CPU／GPU 各四格一排：同一組的四個 left 值相同
      cpuRow: document.querySelectorAll('#sysmonStressCpu .sysmon-metercell').length,
      gpuRow: document.querySelectorAll('#sysmonStressGpu .sysmon-metercell').length,
      cpuColumns: new Set(
        [...document.querySelectorAll('#sysmonStressCpu .sysmon-metercell')]
          .map((el) => Math.round(el.getBoundingClientRect().left))
      ).size,
      gpuColumns: new Set(
        [...document.querySelectorAll('#sysmonStressGpu .sysmon-metercell')]
          .map((el) => Math.round(el.getBoundingClientRect().left))
      ).size,
      diskCells: document.querySelectorAll('#sysmonStressDisks .sysmon-metercell').length,
      benchStartDisabled: document.getElementById('sysmonBenchStart').disabled,
      benchDiskOptions: document.querySelectorAll('#sysmonBenchDisk option').length
    }))()`)
    ok('有 WebGL2（GPU 壓力測試的前提）', stressUi.webgl2)
    ok('壓力測試畫布存在', stressUi.hasCanvas)
    ok('未開始時「開始」可按、「停止」不可按',
      !stressUi.startDisabled && stressUi.stopDisabled, JSON.stringify(stressUi))
    ok('四項測試都在：CPU／GPU／記憶體／磁碟', stressUi.cards === 4, String(stressUi.cards))
    ok('排成 2×2', stressUi.columns === 2, `不同左緣=${stressUi.columns}`)
    ok('CPU 儀錶四格一排（負載／功耗／溫度／轉速）',
      stressUi.cpuRow === 4 && stressUi.cpuColumns === 4,
      `${stressUi.cpuRow} 格 / ${stressUi.cpuColumns} 欄`)
    ok('GPU 儀錶四格一排（負載／功耗／溫度／轉速）',
      stressUi.gpuRow === 4 && stressUi.gpuColumns === 4,
      `${stressUi.gpuRow} 格 / ${stressUi.gpuColumns} 欄`)
    ok('閒置時 GPU 畫布收起來（不然那張卡會比別人高一截）', !stressUi.canvasShown)
    // 黃色警告條已移除，說明併進各卡的敘述裡
    ok('沒有黃色警告條', stressUi.warn === 0, String(stressUi.warn))
    ok('上方有即時負載與溫度儀錶', stressUi.gauges >= 8, String(stressUi.gauges))
    // 磁碟那格量的是**讀寫速率**不是容量：容量在壓力測試中不會動，看不出有沒有在跑
    ok('儀錶有 CPU 的負載／功耗／溫度／轉速與記憶體已用',
      ['負載', '功耗', '溫度', '轉速', '記憶體已用']
        .every((label) => stressUi.gaugeText.includes(label)),
      stressUi.gaugeText.slice(0, 200))
    ok('硬碟一顆一格（至少記憶體那格在）', stressUi.diskCells >= 2, String(stressUi.diskCells))
    ok('測速位置是磁碟代號下拉（偵測到的硬碟）',
      stressUi.benchDiskOptions >= 1, String(stressUi.benchDiskOptions))
    ok('測速鈕可按', !stressUi.benchStartDisabled)

    // CPU 壓力測試：跑在 main 的 worker_threads，兩秒後負載要真的上得去
    const cpuBefore = await cdp.eval(`(async () => (await window.electronAPI.sysmon.stressStatus()).data.cpu.running)()`)
    ok('一開始 CPU 壓力測試沒在跑', cpuBefore === false)
    await cdp.eval(`(() => {
      document.getElementById('sysmonCpuThreads').value = '2'
      document.getElementById('sysmonCpuStressStart').click()
    })()`)
    await sleep(2000)
    const cpuRunning = await cdp.eval(`(async () => {
      const st = (await window.electronAPI.sysmon.stressStatus()).data
      return {
        threads: st.cpu.threads,
        running: st.cpu.running,
        stat: document.getElementById('sysmonCpuStressStat').textContent,
        stopDisabled: document.getElementById('sysmonCpuStressStop').disabled
      }
    })()`)
    ok('CPU 壓力測試開得起來且執行緒數對得上',
      cpuRunning.running && cpuRunning.threads === 2, JSON.stringify(cpuRunning))
    ok('執行中「停止」可按', !cpuRunning.stopDisabled, JSON.stringify(cpuRunning))
    await cdp.eval(`document.getElementById('sysmonCpuStressStop').click()`)
    await sleep(400)
    ok('CPU 壓力測試停得下來',
      (await cdp.eval(`(async () => (await window.electronAPI.sysmon.stressStatus()).data.cpu.running)()`)) === false)

    // 記憶體壓力測試：配 1GB 再放掉
    await cdp.eval(`(() => {
      document.getElementById('sysmonMemSize').value = '1'
      document.getElementById('sysmonMemStressStart').click()
    })()`)
    await sleep(1200)
    const memRunning = await cdp.eval(`(async () => {
      const st = (await window.electronAPI.sysmon.stressStatus()).data
      return { running: st.memory.running, bytes: st.memory.allocatedBytes }
    })()`)
    ok('記憶體壓力測試真的配到記憶體',
      memRunning.running && memRunning.bytes >= 256 * 1024 * 1024, JSON.stringify(memRunning))
    await cdp.eval(`document.getElementById('sysmonMemStressStop').click()`)
    await sleep(400)
    ok('記憶體壓力測試停得下來（配置歸零）',
      (await cdp.eval(`(async () => (await window.electronAPI.sysmon.stressStatus()).data.memory.allocatedBytes)()`)) === 0)

    // 真的跑 1.2 秒 GPU 負載再停掉（強度 1，最輕的一檔）
    await cdp.eval(`(() => {
      document.getElementById('sysmonGpuLoad').value = '1'
      document.getElementById('sysmonStressStart').click()
    })()`)
    await sleep(1200)
    const running = await cdp.eval(`(() => ({
      stat: document.getElementById('sysmonStressStat').textContent,
      startDisabled: document.getElementById('sysmonStressStart').disabled,
      stopDisabled: document.getElementById('sysmonStressStop').disabled
    }))()`)
    ok('GPU 壓力測試跑得起來且回報 FPS', /FPS/.test(running.stat), running.stat)
    ok('執行中「開始」變灰、「停止」可按',
      running.startDisabled && !running.stopDisabled, JSON.stringify(running))
    await cdp.eval(`document.getElementById('sysmonStressStop').click()`)
    await sleep(200)
    ok('停得下來',
      (await cdp.eval(`document.getElementById('sysmonStressStart').disabled`)) === false)

    // ── 取樣間隔 ────────────────────────────────────────────────
    await cdp.eval(`(() => {
      const s = document.getElementById('sysmonInterval')
      s.value = 'slow'
      s.dispatchEvent(new Event('change'))
    })()`)
    await sleep(300)
    ok('取樣間隔寫回 store',
      (await cdp.eval(`window.electronAPI.store.get('sysmonInterval', '')`)) === 'slow')
    ok('main 的狀態跟著換',
      (await cdp.eval(`(async () => (await window.electronAPI.sysmon.status()).data.intervalKey)()`)) === 'slow')

    // ── 離開分頁要停掉取樣 ──────────────────────────────────────
    await cdp.eval(`document.querySelector('[data-page="chat"]').click()`)
    await sleep(500)
    ok('離開分頁後取樣器停止（PowerShell 不在背景整天跑）',
      (await cdp.eval(`(async () => (await window.electronAPI.sysmon.status()).data.running)()`)) === false)

    // ── 信任邊界 ────────────────────────────────────────────────
    const guards = await cdp.eval(`(async () => {
      const api = window.electronAPI.sysmon
      return {
        pid4: await api.kill(4, true),
        strPid: await api.kill('1234', true),
        // Number([1234]) === 1234：用 Number() 當守衛的話這個會過關
        arrayPid: await api.kill([1234], true),
        badDir: await api.diskBench({ dir: 'Z:/nope/nope', sizeMb: 128 }),
        pathDrive: await api.diskBench({ drive: 'C:\\Users', sizeMb: 128 }),
        traversalDrive: await api.diskBench({ drive: 'C:..\\..', sizeMb: 128 })
      }
    })()`)
    ok('IPC 擋下 pid 4', guards.pid4.ok === false && guards.pid4.error.code === 'SYSMON_BAD_PID')
    ok('IPC 擋下字串 pid', guards.strPid.ok === false)
    ok('IPC 擋下假裝成 pid 的陣列', guards.arrayPid.ok === false, JSON.stringify(guards.arrayPid))
    ok('IPC 擋下舊格式的路徑字串', guards.badDir.ok === false && guards.badDir.error.code === 'SYSMON_BAD_DIR')
    ok('IPC 只收單一磁碟代號（路徑擋掉）', guards.pathDrive.ok === false, JSON.stringify(guards.pathDrive))
    ok('IPC 擋下帶走路字元的代號', guards.traversalDrive.ok === false, JSON.stringify(guards.traversalDrive))
    ok('錯誤訊息不外洩路徑', !/Z:/.test(guards.badDir.error.message), guards.badDir.error.message)

    ok('renderer 無未處理例外', cdp.exceptions.length === 0, JSON.stringify(cdp.exceptions))
  } catch (error) {
    failed++
    console.error(`\n未預期例外：${error.stack || error}`)
    console.error('Renderer exceptions:', JSON.stringify(cdp?.exceptions || []))
    console.error('Process log:', processLog.slice(-4000))
  } finally {
    if (cdp && original) {
      try {
        await cdp.eval(`(async () => {
          const orig = ${JSON.stringify(original)}
          // 原本沒設過的 key 要寫回預設值，不能留著測試中途改出來的值
          const defaults = { sysmonInterval: 'normal', sysmonSort: 'cpu:desc', sysmonSensors: true }
          for (const [k, v] of Object.entries(orig)) {
            await window.electronAPI.store.set(k, v === null ? defaults[k] : v)
          }
          return 'ok'
        })()`)
        console.log(`（已還原使用者設定：${JSON.stringify(original)}）`)
      } catch (e) {
        console.error('還原設定失敗：', e)
      }
    }
    cdp?.close()
    try { child.kill() } catch { /* ignore */ }
    // 只殺自己 spawn 的那棵樹；禁止 /IM VoiceInk.exe（會關掉使用者的安裝版）
    if (child.pid) {
      try { spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }) } catch { /* ignore */ }
    }
    // 暫存資料夾清掉（Windows 釋放 SQLite 較慢，有限重試）
    for (let i = 0; i < 5; i += 1) {
      try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true }); break } catch { await sleep(600) }
    }
  }

  console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILED'}  ${passed} passed, ${failed} failed\n`)
  process.exitCode = failed === 0 ? 0 : 1
}

main()
