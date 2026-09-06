'use strict'
/**
 * 把安裝版設定複製進預覽的獨立 userData（寫入不會回到安裝版）。
 * 風扇接管／語音熱鍵／AGY 反代關掉，避免兩份搶同一台機器。
 */
const fs = require('fs')
const path = require('path')
const os = require('os')

const SRC = path.join(process.env.APPDATA, 'voiceink')
const DST = path.join(os.tmpdir(), 'voiceink-preview')

function copyFile(name) {
  const from = path.join(SRC, name)
  const to = path.join(DST, name)
  if (!fs.existsSync(from)) return false
  fs.copyFileSync(from, to)
  return true
}

function junction(name) {
  const from = path.join(SRC, name)
  const to = path.join(DST, name)
  if (!fs.existsSync(from)) return false
  if (fs.existsSync(to)) {
    const st = fs.lstatSync(to)
    if (st.isSymbolicLink() || st.isDirectory()) {
      try { fs.rmdirSync(to) } catch { return fs.existsSync(to) && fs.lstatSync(to).isSymbolicLink() }
    }
  }
  fs.symlinkSync(from, to, 'junction')
  return true
}

fs.mkdirSync(DST, { recursive: true })
const copied = ['config.json', 'cc-providers.json', 'hf-presets.ini'].filter(copyFile)
const linked = ['models', 'hf-models'].filter(junction)

const cfgPath = path.join(DST, 'config.json')
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
cfg.agyEnabled = false
cfg.dictationEnabled = false
cfg.closeToTray = false
cfg.sysmonSensors = true
if (cfg.fanControl && typeof cfg.fanControl === 'object') {
  cfg.fanControl = { ...cfg.fanControl, enabled: false }
}
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, '\t'), 'utf8')

console.log(JSON.stringify({
  dst: DST,
  copied,
  linked,
  theme: cfg.theme,
  chatProvider: cfg.chatProviderId,
  sysmonSensors: cfg.sysmonSensors,
  fanEnabled: cfg.fanControl?.enabled === true,
  agyEnabled: cfg.agyEnabled === true,
  dictationEnabled: cfg.dictationEnabled === true
}))
