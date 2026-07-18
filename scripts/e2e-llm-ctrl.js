const { app } = require('electron')
const path = require('path')

app.whenReady().then(async () => {
  app.setPath('userData', path.join(app.getPath('appData'), 'voiceink'))
  const engine = require('../src/main/engine')
  const localLlm = require('../src/main/local-llm')
  const Store = (await import('electron-store')).default
  const store = new Store({ cwd: path.join(app.getPath('appData'), 'voiceink') })

  try {
    console.log('acquire llm')
    const w = await engine.acquire('file', { asr: false, llm: true })
    console.log('warm', w)
    // text with control chars
    const texts = [
      'Hello world',
      'Hello\u0001world',
      'line1\nline2',
      'a'.repeat(200),
    ]
    for (const t of texts) {
      try {
        const out = await localLlm.translate(store, t, 'zh-TW', { mode: 'file' })
        console.log('OK', JSON.stringify(t.slice(0,20)), '->', JSON.stringify(out).slice(0,60))
      } catch (e) {
        console.log('FAIL', JSON.stringify(t.slice(0,20)), e.message)
      }
    }
    await engine.release('file')
    app.exit(0)
  } catch (e) {
    console.error('TOP', e)
    app.exit(1)
  }
}).catch(e => { console.error(e); app.exit(1) })
