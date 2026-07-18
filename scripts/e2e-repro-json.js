const { app } = require('electron')
const path = require('path')
const fs = require('fs')

app.whenReady().then(async () => {
  app.setPath('userData', path.join(app.getPath('appData'), 'voiceink'))
  const fileTranscribe = require('../src/main/file-transcribe')
  const engine = require('../src/main/engine')
  const localAsr = require('../src/main/local-asr')
  const localLlm = require('../src/main/local-llm')
  const Store = (await import('electron-store')).default
  const store = new Store({ cwd: path.join(app.getPath('appData'), 'voiceink') })
  console.log('translator', store.get('translator'))

  const wav = process.argv[2]
  console.log('wav', wav, fs.existsSync(wav))

  try {
    await engine.acquire('file', { asr: true, llm: false })
    console.log('asr ok')
    const r = await fileTranscribe.transcribeFile({ filePath: wav, lang: 'zh-TW' })
    console.log('asr result', JSON.stringify({ text: r.text, chunks: r.chunks, d: r.durationSec }))

    if (store.get('translator') === 'local' && r.text) {
      await engine.acquire('file', { asr: true, llm: true })
      console.log('llm ok')
      const tr = await localLlm.translate(store, r.text, 'zh-TW', { mode: 'file' })
      console.log('tr', tr)
    } else {
      console.log('skip translate, text empty or translator', store.get('translator'))
    }
    await engine.release('file')
    console.log('DONE')
    app.exit(0)
  } catch (e) {
    console.error('CAUGHT', e && e.stack || e)
    try { await engine.release('file') } catch {}
    app.exit(1)
  }
}).catch(e => { console.error(e); app.exit(1) })
