const { app } = require('electron')
const path = require('path')

app.whenReady().then(async () => {
  try {
    app.setPath('userData', path.join(app.getPath('appData'), 'voiceink'))
    const root = path.join(__dirname, '..')
    const engine = require(path.join(root, 'src/main/engine'))
    const localAsr = require(path.join(root, 'src/main/local-asr'))
    console.log('acquire file asr+llm...')
    const t0 = Date.now()
    const r = await engine.acquire('file', { asr: true, llm: true })
    console.log('acquire result', JSON.stringify(r), 'ms', Date.now()-t0)
    const samples = new Float32Array(16000)
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i/20)*0.1
    console.log('transcribe...')
    const text = await localAsr.transcribe({ samples, sampleRate: 16000, lang: 'zh-TW', modelKey: 'qwen3asr' })
    console.log('text', JSON.stringify(text))
    await engine.release('file')
    console.log('OK')
    app.exit(0)
  } catch (e) {
    console.error('FAIL', e)
    app.exit(1)
  }
})
