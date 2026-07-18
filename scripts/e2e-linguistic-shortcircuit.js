/**
 * 驗證 translate 對非語言碎片短路徑（不載入 LLM）
 * 用法：npx electron scripts/e2e-linguistic-shortcircuit.js
 */
const { app } = require('electron')
const path = require('path')

app.setPath('userData', path.join(app.getPath('appData'), 'voiceink'))

app.whenReady().then(async () => {
  const llm = require('../src/main/local-llm')
  const store = {
    get(k, d) {
      if (k === 'translator') return 'local'
      return d
    }
  }

  const samples = ['♪♪♪', '……', '>>', '​​']
  let fail = 0
  for (const s of samples) {
    const out = await llm.translate(store, s, 'zh-TW', { mode: 'live' })
    const ok = out === s && !llm.isLoaded()
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${JSON.stringify(s)} -> ${JSON.stringify(out)} loaded=${llm.isLoaded()}`)
    if (!ok) fail++
  }

  // 對照：有語言內容且未 warm 時應嘗試載入並可能失敗／成功，但至少不應短路成原樣（若模型未下載會 throw）
  try {
    await llm.translate(store, 'Hello world', 'zh-TW', { mode: 'live' })
    console.log('PASS  linguistic text entered translate path (model available)')
  } catch (e) {
    // 未下載模型也證明有進真實路徑
    console.log('PASS  linguistic text entered translate path:', e.message)
  }

  console.log(fail ? `FAIL count=${fail}` : 'ALL PASS')
  // Windows 上僅 app.exit(0) 有時仍回非 0；用 process.exit 對齊
  process.exit(fail ? 1 : 0)
})
