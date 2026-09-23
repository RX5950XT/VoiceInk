/**
 * voiceink-probe.exe（Rust）跟兩支 PowerShell 的輸出要一模一樣：metrics.js／observer.js
 * 逐格解析，對面換了人它們不會知道。改 native/voiceink-probe 或 probe.ps1 之後跑這支。
 *
 * 用法：npm run build:probe && node scripts/probe-native-probe-parity.js
 *
 * 比法：
 *  - static：整份逐列相同；只有會自己一直變的欄位（SMART 讀寫量、VOL 剩餘空間、PAGE 用量）遮掉
 *  - tick：每一種列的數量級一致、欄位數一致；P 列同一個 pid 名稱相同；N／D 名稱清單相同
 *  - detail：pid／名稱／擁有者／啟動時間／父程序相同（路徑只比不分大小寫）
 *  - observer：同一組 JSON 欄位
 */
const { spawnSync } = require('child_process')
const path = require('path')
const { resolveProbeExe } = require('../src/main/native-probe')

const ROOT = path.join(__dirname, '..')
const EXE = resolveProbeExe({ resourcesPath: '' })
const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']

let failed = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`)
  if (!ok) failed++
}

function run(file, args, input, timeout = 90_000) {
  const r = spawnSync(file, args, { input, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  return String(r.stdout || '').split(/\r?\n/)
}

function frame(lines, cmd) {
  const start = lines.findIndex((l) => l.startsWith(`#B ${cmd} `))
  const end = lines.findIndex((l, i) => i > start && l.startsWith(`#E ${cmd} `))
  return start >= 0 && end > start ? lines.slice(start + 1, end) : null
}

/** 會自己變的欄位遮掉（NVMe 溫度／通電時數／讀寫量／命令數／忙碌時間、VOL 剩餘空間、PAGE 目前用量） */
function stable(row) {
  const f = row.split('|')
  if (f[0] === 'SMART' && f[2] === 'nvme') [4, 8, 11, 12, 13, 14, 17, 20].forEach((i) => { f[i] = '*' })
  if (f[0] === 'VOL') f[4] = '*'
  if (f[0] === 'PAGE') { f[3] = '*'; f[4] = '*' }
  return f.join('|')
}

const byKind = (rows) => rows.reduce((m, r) => {
  const k = r.split('|')[0]
  m[k] = (m[k] || []).concat([r])
  return m
}, {})

function compareStatic(ps, rs) {
  const a = ps.map(stable).sort()
  const b = rs.map(stable).sort()
  const missing = a.filter((r) => !b.includes(r))
  const extra = b.filter((r) => !a.includes(r))
  check(`static 逐列相同（${a.length} 列）`, missing.length === 0 && extra.length === 0,
    [...missing.slice(0, 5).map((r) => `- ${r}`), ...extra.slice(0, 5).map((r) => `+ ${r}`)].join('\n      '))
}

function compareTick(ps, rs) {
  const a = byKind(ps)
  const b = byKind(rs)
  for (const kind of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const na = (a[kind] || []).length
    const nb = (b[kind] || []).length
    // 程序與 GPU 引擎兩次執行之間本來就會變，差太多才算錯；Idle 與 _Total 兩列 ps1 有、metrics.js 本來就丟
    const slack = kind === 'P' || kind === 'G' || kind === 'V' ? Math.max(10, na * 0.1) : 0
    check(`tick ${kind} 列數（ps1 ${na} / rust ${nb}）`, Math.abs(na - nb) <= slack)
    const width = (rows) => new Set((rows || []).map((r) => r.split('|').length))
    check(`tick ${kind} 欄位數一致`, [...width(b[kind])].every((w) => width(a[kind]).has(w)))
  }
  for (const kind of ['N', 'D']) {
    const names = (rows) => (rows || []).map((r) => r.split('|')[1]).sort().join(',')
    check(`tick ${kind} 名稱清單相同`, names(a[kind]) === names(b[kind]), `${names(a[kind])}\n      ${names(b[kind])}`)
  }
  const psP = new Map((a.P || []).map((r) => r.split('|')).map((f) => [f[1], f[2].replace(/#\d+$/, '')]))
  const wrong = (b.P || []).map((r) => r.split('|')).filter((f) => psP.has(f[1]) && psP.get(f[1]) !== f[2])
  check('tick P 同一個 pid 名稱相同', wrong.length === 0, wrong.slice(0, 5).map((f) => `${f[1]} ${psP.get(f[1])} ≠ ${f[2]}`).join('; '))
}

function compareDetail(ps, rs) {
  const pick = (rows) => {
    const x = (rows.find((r) => r.startsWith('X|')) || '').split('|')
    return [x[1], x[2], x[4], x[5], x[6], (x[3] || '').toLowerCase()].join('|')
  }
  check('detail 相同', pick(ps) === pick(rs), `${pick(ps)}\n      ${pick(rs)}`)
  check('detail 版本資訊相同', ps.find((r) => r.startsWith('XV|')) === rs.find((r) => r.startsWith('XV|')))
}

function compareObserver() {
  const keys = (lines) => {
    const row = lines.find((l) => l.startsWith('{'))
    return row ? Object.keys(JSON.parse(row)).sort().join(',') : ''
  }
  // observer 是無窮迴圈：靠 timeout 收掉，拿到第一列就夠
  const rs = run(EXE, ['observer'], '', 2500)
  const ps = run(PS, [...PS_ARGS, path.join(ROOT, 'src/main/screentime/observer.ps1')], '', 8000)
  check('observer JSON 欄位相同', keys(rs) !== '' && keys(rs) === keys(ps), `${keys(ps)} / ${keys(rs)}`)
}

function main() {
  if (!EXE) {
    console.error('找不到 resources/probe/voiceink-probe.exe，先跑 npm run build:probe')
    process.exit(1)
  }
  const explorer = spawnSync('tasklist', ['/FI', 'IMAGENAME eq explorer.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
  const pid = (String(explorer.stdout).split('"')[3] || '0').trim()
  const input = `static 1\ntick 2\ndetail 3 ${pid}\nbye\n`
  const rs = run(EXE, ['sysmon'], input)
  const ps = run(PS, [...PS_ARGS, path.join(ROOT, 'src/main/sysmon/probe.ps1')], input)
  check('兩邊都 #READY', rs[0] === '#READY' && ps[0] === '#READY')
  compareStatic(frame(ps, 'static') || [], frame(rs, 'static') || [])
  compareTick(frame(ps, 'tick') || [], frame(rs, 'tick') || [])
  compareDetail(frame(ps, 'detail') || [], frame(rs, 'detail') || [])
  compareObserver()
  console.log(failed ? `\n${failed} 項不一致` : '\nALL PASS')
  process.exitCode = failed ? 1 : 0
}

main()
