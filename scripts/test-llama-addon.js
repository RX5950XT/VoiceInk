'use strict'

/**
 * llama-addon 在未打包時必須是 no-op，且打包路徑只能是 userData。
 */
const fs = require('fs')
const path = require('path')
const { ensureLlamaAddon, GPU_PACKAGES } = require('../src/main/llama-addon')

let failed = 0
function pass(name) {
  console.log(`  PASS  ${name}`)
}
function fail(name, detail) {
  failed += 1
  console.log(`  FAIL  ${name} — ${detail}`)
}

if (GPU_PACKAGES.includes('win-x64-cuda') && GPU_PACKAGES.includes('win-x64-vulkan')) {
  pass('GPU 套件名單含 cuda 與 vulkan')
} else fail('GPU 套件名單', String(GPU_PACKAGES))

const source = fs.readFileSync(path.join(__dirname, '../src/main/llama-addon.js'), 'utf8')
if (/resourcesPath[\s\S]{0,120}asar\.unpacked/.test(source)) {
  fail('不得寫安裝目錄', 'dest 仍指向 resources/app.asar.unpacked')
} else pass('GPU 套件不寫安裝目錄 asar.unpacked')
if (!source.includes("getPath('userData')") || !source.includes('native-modules')) {
  fail('必須寫進 userData', '缺少 userData/native-modules')
} else pass('GPU 套件解到 userData/native-modules')

try {
  ensureLlamaAddon('win-x64-cuda')
  ensureLlamaAddon('win-x64-vulkan')
  ensureLlamaAddon('not-a-package')
  pass('未打包時 ensureLlamaAddon 不丟錯、不寫檔')
} catch (e) {
  fail('未打包 no-op', e.message || e)
}

if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nALL PASS')
