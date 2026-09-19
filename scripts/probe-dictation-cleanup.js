'use strict'

/**
 * 語音輸入整理器：**打真的整理模型**，量它到底有沒有修錯字、有沒有排版。
 *
 *   npx electron scripts/probe-dictation-cleanup.js
 *
 * mock 全綠證明不了對面長什麼樣：prompt 改了幾個字，模型聽不聽是另一回事。
 * 這支用使用者設定裡那顆整理模型（`dictationLlm`，雲端才跑）真的送三段話過去。
 *
 * 只讀設定：userData 指到暫存資料夾，字典與紀錄都寫在那裡，不碰使用者的檔。
 */

const { app } = require('electron')
const fs = require('fs')
const path = require('path')
const { tempDir } = require('./lib/test-temp')

const USER_DATA_DIR = tempDir('voiceink-probe-clean-')
app.setPath('userData', USER_DATA_DIR)

let passed = 0
const failures = []

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

/** 使用者真正的設定（只讀）：供應商與金鑰都在這裡 */
function readRealConfig() {
  const file = path.join(app.getPath('appData'), 'voiceink', 'config.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const SAMPLES = [
  {
    name: '同音錯字',
    raw: '這個檔案的首頁上面會顯示定選在側邊欄的那些資料夾 你因該看的到',
    expect: (out) => out.includes('釘選') && out.includes('應該'),
    detail: '要把「定選」修成「釘選」、「因該」修成「應該」'
  },
  {
    name: '條列換行',
    raw: '那個待辦有三個 第一個是修登入的 bug 第二個是把設定頁補完 然後第三個 呃 是寫測試',
    expect: (out) => out.includes('\n'),
    detail: '列項目要換行，不可以全部擠成一行'
  },
  {
    name: '長篇分段',
    raw: '那我們今天先講一下進度 就是那個登入的部分已經做完了 然後嗯 註冊那邊還沒好 '
      + '註冊卡在簡訊驗證那個第三方的 API 一直回四零一 對 然後我剛剛想到登入那邊還有一個記住我的功能沒做 '
      + '另外就是下禮拜要開始做設定頁 設定頁我想說先把主題切換做出來 其他的再慢慢補 '
      + '喔對了還有測試 測試現在只有主流程有 邊界的狀況都還沒補',
    expect: (out) => (out.match(/\n/g) || []).length >= 1,
    detail: '長篇要分段（段落之間空一行）'
  }
]

async function main() {
  await app.whenReady()
  const cfg = readRealConfig()
  if (!cfg) {
    console.log('讀不到 config.json，先在 App 裡設好整理模型再跑這支。')
    app.exit(0)
    return
  }
  const store = { get: (key, fallback) => (key in cfg ? cfg[key] : fallback) }
  const dictation = require('../src/main/dictation')
  dictation.setStore(store)
  const cleaner = dictation.status().cleaner
  if (cleaner.mode !== 'cloud') {
    console.log(`整理模型不是雲端（目前：${cleaner.mode || 'off'}），這支只打雲端，跳過。`)
    app.exit(0)
    return
  }
  console.log(`整理模型：${cleaner.providerName} / ${cleaner.modelId}\n`)

  for (const sample of SAMPLES) {
    const result = await dictation.cleanup(sample.raw)
    const out = String(result.text || '')
    console.log(`[${sample.name}]`)
    console.log(`  原文：${sample.raw}`)
    console.log(`  整理：${JSON.stringify(out)}`)
    check(`${sample.name} — ${sample.detail}`, Boolean(result.cleaned) && sample.expect(out), result.warning || '')
  }

  console.log(`\n${passed} passed, ${failures.length} failed`)
  app.exit(failures.length ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  app.exit(1)
})
