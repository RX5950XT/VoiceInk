/**
 * 壓力測試到底有沒有壓到——**實機量測**，不是看按鈕會不會動。
 * 用法：node scripts/probe-sysmon-stress.js（會自己啟動 dist/win-unpacked/VoiceInk.exe）
 *
 * 為什麼要有這一支：`e2e-sysmon-cdp.js` 只驗「按了開始之後狀態變成執行中」，
 * 而「執行中」跟「滿載」是兩件事。GPU 那項就是這樣漏掉的——`requestAnimationFrame`
 * 每秒只叫 60～165 次，一次只畫 320×180，狀態顯示得漂漂亮亮但顯示卡幾乎在發呆。
 *
 * 三項各自的量法都**繞開 App 自己的數字**（否則量錯的話會自己騙自己）：
 *  - CPU：CIM `Win32_PerfFormattedData_PerfOS_Processor(_Total)`（不受系統語言影響，
 *    不像 `Get-Counter` 的計數器名稱會被在地化）
 *  - GPU：`nvidia-smi` 的 utilization.gpu；沒有 NVIDIA 卡就跳過並說明
 *  - 記憶體：`Win32_OperatingSystem.FreePhysicalMemory` 前後差
 * 順便把 App 自己顯示的數字印出來對照。
 *
 * 會改到 `sysmonSensors`（避免自動化停在 UAC 對話框前），finally 寫回原值。
 */
'use strict'

const { spawn, execFileSync } = require('child_process')
const path = require('path')
const http = require('http')

const PORT = 9248
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
/** 每一項壓多久（秒）。太短的話 GPU 的自動加壓還沒爬到預算就結束了 */
const LOAD_SEC = 10
/** 判定門檻：低於這個就算「沒壓到」 */
const CPU_TARGET = 90
const GPU_TARGET = 80

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
  }

  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve)
      this.ws.addEventListener('error', reject)
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
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

/**
 * 跑一段 PowerShell。逾時要**很寬**：CPU 被壓到 100% 的時候 PowerShell 自己也會變慢，
 * 60 秒的逾時在滿載那一段一定會踩到（實測踩過，而且 stdout 其實已經量到 100%）。
 * @param {string} script @param {number} [timeoutMs] @returns {string}
 */
function ps(script, timeoutMs = 180_000) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: timeoutMs, windowsHide: true
  }).trim()
}

/**
 * 整機 CPU 使用率取樣（%）。用 CIM 不用 Get-Counter：計數器名稱會被系統語言在地化，
 * 在 zh-TW 上寫死英文名字會直接失敗。
 * @param {number} samples
 * @returns {number[]}
 */
function sampleCpu(samples) {
  const out = ps(
    `1..${samples} | ForEach-Object { ` +
    "(Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter \"Name='_Total'\").PercentProcessorTime; " +
    'Start-Sleep -Milliseconds 900 }',
    samples * 4000 + 120_000
  )
  return out.split(/\r?\n/).map((line) => Number(line.trim())).filter((n) => Number.isFinite(n))
}

/** @returns {number} 目前可用實體記憶體（GB） */
function freeGb() {
  const out = ps('(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory')
  return Number(out) / (1024 * 1024)
}

/** @returns {boolean} */
function hasNvidiaSmi() {
  try {
    execFileSync('nvidia-smi', ['--version'], { stdio: 'ignore', timeout: 15_000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

/**
 * @param {number} samples
 * @returns {number[]} GPU 使用率（%）
 */
function sampleGpu(samples) {
  const out = execFileSync('nvidia-smi', [
    '--query-gpu=utilization.gpu', '--format=csv,noheader,nounits', '-l', '1'
  ], { encoding: 'utf8', timeout: (samples + 4) * 1000, windowsHide: true, killSignal: 'SIGKILL' })
  return out.split(/\r?\n/).map((line) => Number(line.trim())).filter((n) => Number.isFinite(n))
}

/** nvidia-smi -l 只能靠逾時停下來，包一層把逾時當成正常結束 */
function sampleGpuSafe(samples) {
  try {
    return sampleGpu(samples)
  } catch (error) {
    const stdout = String(error?.stdout || '')
    return stdout.split(/\r?\n/).map((line) => Number(line.trim())).filter((n) => Number.isFinite(n))
  }
}

const max = (list) => (list.length ? Math.max(...list) : 0)
/**
 * 中位數。`nvidia-smi -l` 只能靠逾時停下來，尾巴那幾筆常常落在「已經按了停止」之後，
 * 用平均的話一個 0 就把整組拉下來（實測 80,80,81,…,81,0 平均變成 75）。
 * @param {number[]} list
 */
const median = (list) => {
  if (!list.length) return 0
  const sorted = [...list].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

async function main() {
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { stdio: ['ignore', 'ignore', 'ignore'] })
  let cdp = null
  let originalSensors = null
  const results = []
  const ok = (name, cond, detail) => {
    results.push({ name, cond, detail })
    console.log(`${cond ? 'PASS ' : 'FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
  }

  try {
    const target = await (async () => {
      const deadline = Date.now() + 30_000
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
    while (!(await cdp.eval("document.readyState === 'complete' && typeof window.electronAPI?.sysmon?.status === 'function'"))) {
      await sleep(400)
    }

    originalSensors = await cdp.eval("window.electronAPI.store.get('sysmonSensors', null)")
    await cdp.eval("window.electronAPI.store.set('sysmonSensors', false)")

    await cdp.eval('document.querySelector(\'[data-page="sysmon"]\').click()')
    await sleep(800)
    await cdp.eval('document.querySelector(\'.sysmon-tab[data-subtab="stress"]\').click()')
    await sleep(1200)

    console.log(`\n閒置基準（${LOAD_SEC / 2} 秒）…`)
    const idleCpu = sampleCpu(Math.round(LOAD_SEC / 2))
    console.log(`  閒置 CPU 中位數 ${median(idleCpu).toFixed(1)}%`)

    // ── CPU ───────────────────────────────────────────────────
    const threads = await cdp.eval("Number(document.getElementById('sysmonCpuThreads').value)")
    console.log(`\nCPU 壓力測試（${threads} 條執行緒，量 ${LOAD_SEC} 秒）…`)
    await cdp.eval("document.getElementById('sysmonCpuStressStart').click()")
    await sleep(1500)
    const busyCpu = sampleCpu(LOAD_SEC)
    const cpuStat = await cdp.eval("document.getElementById('sysmonCpuStressStat').textContent")
    await cdp.eval("document.getElementById('sysmonCpuStressStop').click()")
    await sleep(500)
    console.log(`  App 顯示：${cpuStat}`)
    ok(`CPU 真的滿載（中位數 ${median(busyCpu).toFixed(1)}% ≥ ${CPU_TARGET}%）`,
      median(busyCpu) >= CPU_TARGET, `樣本 ${busyCpu.join('/')}`)
    ok('執行緒預設就是全部邏輯核心', threads === require('os').cpus().length, String(threads))

    // ── GPU ───────────────────────────────────────────────────
    if (!hasNvidiaSmi()) {
      console.log('\nGPU：找不到 nvidia-smi，跳過（這台機器沒有 NVIDIA 卡或驅動沒裝）')
    } else {
      const level = await cdp.eval("Number(document.getElementById('sysmonGpuLoad').value)")
      console.log(`\nGPU 壓力測試（強度 ${level}，量 ${LOAD_SEC} 秒）…`)
      const idleGpu = sampleGpuSafe(4)
      console.log(`  閒置 GPU 中位數 ${median(idleGpu).toFixed(1)}%`)
      await cdp.eval("document.getElementById('sysmonStressStart').click()")
      // 自動加壓要幾個 frame 才爬到預算，先讓它跑一下再開始量
      await sleep(3000)
      const busyGpu = sampleGpuSafe(LOAD_SEC)
      const gpuStat = await cdp.eval("document.getElementById('sysmonStressStat').textContent")
      const visibility = await cdp.eval('document.visibilityState')
      console.log(`  視窗狀態：${visibility}`)
      await cdp.eval("document.getElementById('sysmonStressStop').click()")
      await sleep(500)
      console.log(`  App 顯示：${gpuStat}`)
      ok(`GPU 真的滿載（中位數 ${median(busyGpu).toFixed(1)}%／尖峰 ${max(busyGpu)}% ≥ ${GPU_TARGET}%）`,
        median(busyGpu) >= GPU_TARGET, `樣本 ${busyGpu.join('/')}`)
      ok('GPU 測試沒有把 WebGL context 弄丟（TDR）',
        !/無法|失敗|lost/i.test(gpuStat), gpuStat)
    }

    // ── 記憶體 ────────────────────────────────────────────────
    const wantGb = await cdp.eval("Number(document.getElementById('sysmonMemSize').value)")
    console.log(`\n記憶體壓力測試（要求 ${wantGb} GB）…`)
    const beforeFree = freeGb()
    await cdp.eval("document.getElementById('sysmonMemStressStart').click()")
    await sleep(4000)
    const afterFree = freeGb()
    const memStat = await cdp.eval("document.getElementById('sysmonMemStressStat').textContent")
    const status = await cdp.eval('window.electronAPI.sysmon.stressStatus()')
    await cdp.eval("document.getElementById('sysmonMemStressStop').click()")
    await sleep(2000)
    const releasedFree = freeGb()
    const allocatedGb = (status?.data?.memory?.allocatedBytes || 0) / (1024 ** 3)
    const eaten = beforeFree - afterFree
    console.log(`  App 顯示：${memStat}`)
    console.log(`  可用記憶體 ${beforeFree.toFixed(1)} → ${afterFree.toFixed(1)} → ${releasedFree.toFixed(1)} GB`)
    ok('預設值就是現在吃得下的最大值（不是寫死的 4 GB）', wantGb > 4 || wantGb >= Math.floor(beforeFree * 0.7),
      `要求 ${wantGb} GB／當時可用 ${beforeFree.toFixed(1)} GB`)
    ok(`記憶體真的被吃掉（作業系統少了 ${eaten.toFixed(1)} GB）`,
      eaten >= allocatedGb * 0.8, `App 說配了 ${allocatedGb.toFixed(1)} GB`)
    ok('停掉之後真的還回去', releasedFree >= afterFree + allocatedGb * 0.7,
      `${afterFree.toFixed(1)} → ${releasedFree.toFixed(1)} GB`)
  } finally {
    if (cdp && originalSensors !== null) {
      await cdp.eval(`window.electronAPI.store.set('sysmonSensors', ${JSON.stringify(originalSensors)})`).catch(() => {})
    }
    cdp?.close()
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch { /* 已經結束了 */ }
  }

  const failed = results.filter((r) => !r.cond).length
  console.log(`\n${results.length - failed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
