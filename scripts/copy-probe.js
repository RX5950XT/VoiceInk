/**
 * `npm run build:probe` 的第二步：把 cargo 產出的 voiceink-probe.exe 放到 resources/probe/
 * （打包時由 extraResources 帶進 resources/probe/，見 src/main/native-probe.js）。
 * voiceink-term.exe＝終端機背景宿主（同一個 crate 的第二支，見 src/main/terminal/host-runtime.js）。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const dir = path.join(ROOT, 'resources', 'probe')

fs.mkdirSync(dir, { recursive: true })
for (const name of ['voiceink-probe.exe', 'voiceink-term.exe']) {
  const from = path.join(ROOT, 'native', 'voiceink-probe', 'target', 'release', name)
  fs.copyFileSync(from, path.join(dir, name))
  console.log(`[build:probe] ${path.join(path.relative(ROOT, dir), name)}（${fs.statSync(from).size} bytes）`)
}
