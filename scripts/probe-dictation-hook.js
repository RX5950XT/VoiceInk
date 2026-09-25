/**
 * 語音輸入原生熱鍵 sidecar 的實測（node 直跑，不需要 electron）
 *
 *   node scripts/probe-dictation-hook.js          # 只驗「拉得起來、收得掉」
 *   node scripts/probe-dictation-hook.js --live   # 再等 10 秒，按右 Alt 看事件
 *
 * 注意：跑起來的那幾秒**右 Alt 會被吞掉**（那正是這支程式的目的），
 * 其他按鍵完全不受影響。`--live` 模式會在按下時印出 down／up。
 */

const hook = require('../src/main/dictation/hook')

const live = process.argv.includes('--live')
let passed = 0
let failed = 0

function check(name, cond, extra) {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${extra === undefined ? '' : ` → ${extra}`}`)
  }
}

async function main() {
  const command = hook.hookCommand()
  const exePath = command.file
  check('找得到 sidecar', Boolean(exePath), exePath || '沒有，先跑 npm run build:probe（或 build:hook）')
  if (!exePath) {
    process.exit(1)
  }
  console.log(`    ${exePath} ${command.args.join(' ')}`)

  const events = []
  const started = Date.now()
  let pid = 0
  const spawnFn = (...args) => {
    const child = require('child_process').spawn(...args)
    pid = child.pid
    return child
  }
  const res = await hook.startHook({ spawnFn, onEvent: (kind) => {
    events.push(kind)
    if (live) console.log(`    [${new Date().toLocaleTimeString()}] ${kind}`)
  } })
  check('掛得上 hook', res.ok === true, res.error)
  check('READY 在 1 秒內回來', Date.now() - started < 1000, `${Date.now() - started}ms`)

  if (live) {
    console.log('\n  現在按右 Alt（10 秒）。前景程式應該完全收不到那顆鍵。')
    await new Promise((resolve) => setTimeout(resolve, 10000))
    check('有收到按鍵事件', events.length > 0, String(events))
  }

  res.stop?.()
  await new Promise((resolve) => setTimeout(resolve, 800))
  // 認 pid 不認映像名：Rust 版跟系統監控的取樣器同一支 voiceink-probe.exe
  let alive = true
  try { process.kill(pid, 0) } catch { alive = false }
  check('停止後沒有留下孤兒程序', pid > 0 && !alive, `pid ${pid}`)

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()
