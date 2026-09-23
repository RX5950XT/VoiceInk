/**
 * `npm run build:probe` 的第二步：把 cargo 產出的 voiceink-probe.exe 放到 resources/probe/
 * （打包時由 extraResources 帶進 resources/probe/，見 src/main/native-probe.js）。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const from = path.join(ROOT, 'native', 'voiceink-probe', 'target', 'release', 'voiceink-probe.exe')
const dir = path.join(ROOT, 'resources', 'probe')

fs.mkdirSync(dir, { recursive: true })
fs.copyFileSync(from, path.join(dir, 'voiceink-probe.exe'))
console.log(`[build:probe] ${path.relative(ROOT, dir)}\\voiceink-probe.exe（${fs.statSync(from).size} bytes）`)
