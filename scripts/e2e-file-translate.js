const { app } = require('electron')
const path = require('path')

app.whenReady().then(async () => {
  try {
    app.setPath('userData', path.join(app.getPath('appData'), 'voiceink'))
    const root = path.join(__dirname, '..')
    const engine = require(path.join(root, 'src/main/engine'))
    const localAsr = require(path.join(root, 'src/main/local-asr'))
    const localLlm = require(path.join(root, 'src/main/local-llm'))
    const Store = (await import('electron-store')).default
    const store = new Store({ cwd: app.getPath('userData') })
    console.log('translator setting', store.get('translator'))
    console.log('acquire...')
    const r = await engine.acquire('file', { asr: true, llm: true })
    console.log('acquire', r)
    // tiny speech-like noise
    const samples = new Float32Array(32000)
    for (let i = 0; i < samples.length; i++) samples[i] = (Math.random()*2-1)*0.05
    const text = 'Hello world this is a test.'
    console.log('translate file mode...')
    const t0 = Date.now()
    const out = await localLlm.translate(store, text, 'zh-TW', {
      previousSource: '',
      previousTranslation: '',
      mode: 'file'
    })
    console.log('translated', JSON.stringify(out), 'ms', Date.now()-t0)
    await engine.release('file')
    app.exit(0)
  } catch (e) {
    console.error('FAIL', e)
    app.exit(1)
  }
})
