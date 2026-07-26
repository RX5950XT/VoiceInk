/**
 * 驗證 getSession 同意圖並發 join，不會誤報 LLM load cancelled
 */
const path = require('path')
const { app } = require('electron')

app.setPath('userData', path.join(app.getPath('appData'), 'voiceink'))

async function main() {
  await app.whenReady()
  const Store = (await import('electron-store')).default
  const store = new Store({
    cwd: path.join(app.getPath('appData'), 'voiceink'),
    name: 'e2e-llm-load-cancel-tmp'
  })
  const localLlm = require('../src/main/local-llm')
  localLlm.setStore(store)

  // 強制 CPU，加快／穩定；模型 key 走 resolve fallback
  store.set('llmGpu', false)
  store.set('translator', 'local')

  const results = []

  // 1) 並發 warm ×2：應皆 ok，不可 cancelled
  const [a, b] = await Promise.all([localLlm.warm(), localLlm.warm()])
  results.push({
    name: 'concurrent warm',
    pass: a.ok && b.ok,
    a,
    b,
    info: localLlm.getLoadInfo()
  })

  // 2) 再 warm 一次應直接命中已載入
  const c = await localLlm.warm()
  results.push({
    name: 'warm after loaded',
    pass: c.ok && localLlm.isLoaded(),
    c,
    info: localLlm.getLoadInfo()
  })

  // 3) unload 後 warm 應成功
  await localLlm.unload()
  const d = await localLlm.warm()
  results.push({
    name: 'warm after unload',
    pass: d.ok && localLlm.isLoaded(),
    d,
    info: localLlm.getLoadInfo()
  })

  await localLlm.unload()

  const failed = results.filter((r) => !r.pass)
  console.log(JSON.stringify({ results, failed: failed.length }, null, 2))
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}: ${r.name}`)
  }
  app.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  app.exit(1)
})
