/**
 * 兩條守門規則（掃原始碼，不跑任何東西）：
 *
 * 1. 測試／探針腳本不准自己往 `%TEMP%` 撒資料夾：一律走 `scripts/lib/test-temp.js`
 *    （統一放 `%TEMP%\voiceink-tests`、結束自動刪、過期自動清）。
 * 2. `scripts/` 與 `src/main/` 不准用 `fs.rmSync(..., { recursive: true })`：Node 24（＝Electron 43）的
 *    同步遞迴刪除會穿過 junction 刪掉對面的真資料（暫存 userData 裡的 junction 指著使用者的模型）。
 *    一律用 `src/main/safe-rm.js` 的 `removeTreeSync`（腳本裡是 `test-temp.js` 的 `removeTree`）。
 *
 * 用法：node scripts/test-temp-hygiene.js
 * 真的有理由的那一行加註記：`// temp-ok: 原因` 或 `// rm-ok: 原因`。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const HELPER = path.join(__dirname, 'lib', 'test-temp.js')
const SAFE_RM = path.join(ROOT, 'src', 'main', 'safe-rm.js')
const TEMP_BANNED = /\bos\.tmpdir\(\)|require\(['"](node:)?os['"]\)\.tmpdir\(\)|\bmkdtemp(Sync)?\(|\btmpdir\(\)/
const RM_BANNED = /\brmSync\([^)]*recursive/

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : jsFiles(full)
    return entry.name.endsWith('.js') ? [full] : []
  })
}

const offenders = { temp: [], rm: [] }
function scan(files, { temp }) {
  for (const file of files) {
    if (file === __filename || file === HELPER || file === SAFE_RM) continue
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
      const where = `${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`
      if (RM_BANNED.test(line) && !line.includes('rm-ok')) offenders.rm.push(where)
      if (!temp || !TEMP_BANNED.test(line) || line.includes('temp-ok')) return
      // 寫在專案 dist/ 底下的暫存（終端機宿主測試）不在 %TEMP%，放行
      if (/mkdtemp(Sync)?\(path\.join\((root|ROOT), 'dist\//.test(line)) return
      offenders.temp.push(where)
    })
  }
}

scan(jsFiles(__dirname), { temp: true })
scan(jsFiles(path.join(ROOT, 'src', 'main')), { temp: false })

let failed = false
if (offenders.temp.length) {
  failed = true
  console.log('FAIL  這些地方自己往 %TEMP% 建東西，改用 scripts/lib/test-temp.js 的 tempDir()／tempFile()：')
  for (const row of offenders.temp) console.log(`  ${row}`)
} else {
  console.log('PASS  scripts/ 的暫存全部走 test-temp.js')
}
if (offenders.rm.length) {
  failed = true
  console.log('FAIL  這些地方用了遞迴 rmSync（Node 24 會穿過 junction 刪到真資料），改用 removeTreeSync／removeTree：')
  for (const row of offenders.rm) console.log(`  ${row}`)
} else {
  console.log('PASS  scripts/ 與 src/main/ 沒有遞迴 rmSync')
}
process.exit(failed ? 1 : 0)
