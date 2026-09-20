'use strict'

/**
 * 自動更新的純邏輯回歸（不需要 Electron、不會連網）。
 *
 * 用假的 `electron` 與 `electron-updater` 把 `src/main/updater.js` 撐起來，
 * 驗四件容易改壞的事：開發模式不動作、自動下載開關真的傳下去、
 * 狀態機把事件翻成 UI 看得懂的字串、以及「結束時安裝」的守衛。
 * 另外用字串比對守住 main.js 那三行接線（這個專案漏過太多次白名單）。
 */

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { tempDir, removeTree } = require('./lib/test-temp')
const Module = require('module')

const ROOT = path.join(__dirname, '..')
const resources = tempDir('vi-update-test-')
process.resourcesPath = resources
process.on('exit', () => removeTree(resources))

/** 假的 electron-updater：把 on() 收下來，測試自己觸發 */
function makeFakeAutoUpdater() {
  const handlers = {}
  return {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    disableDifferentialDownload: false,
    installCalls: [],
    quitCalls: [],
    checkCount: 0,
    on(name, fn) { handlers[name] = fn },
    fire(name, payload) { handlers[name]?.(payload) },
    async checkForUpdates() { this.checkCount += 1; return null },
    install(silent, runAfter) { this.installCalls.push([silent, runAfter]); return true },
    quitAndInstall(silent, runAfter) { this.quitCalls.push([silent, runAfter]) }
  }
}

/** 假模組整場都掛著（updater.js 是延遲 require 的，中途拆掉就會載到真的那顆） */
const stubs = { electron: null, 'electron-updater': null }
const origLoad = Module._load
Module._load = function (request, ...rest) {
  if (stubs[request]) return stubs[request]
  return origLoad.call(this, request, ...rest)
}

/**
 * 每個案例都要一份乾淨的 updater（模組內有狀態）
 * @param {{isPackaged: boolean}} appOpts
 */
function loadUpdater(appOpts) {
  const config = path.join(resources, 'app-update.yml')
  if (appOpts.hasConfig === false) fs.rmSync(config, { force: true })
  else fs.writeFileSync(config, 'provider: github\n')
  const fake = makeFakeAutoUpdater()
  stubs.electron = { app: { isPackaged: appOpts.isPackaged, getVersion: () => '1.11.0' } }
  stubs['electron-updater'] = { autoUpdater: fake }
  delete require.cache[require.resolve('../src/main/updater.js')]
  return { updater: require('../src/main/updater.js'), fake }
}

async function main() {
  {
    const { updater, fake } = loadUpdater({ isPackaged: true, hasConfig: false })
    await updater.check()
    assert.strictEqual(updater.status().state, 'unsupported', '缺更新資訊要說明，不能安靜停在 idle')
    assert.strictEqual(fake.checkCount, 0)
    console.log('[預覽] 缺更新資訊有明確狀態 ✓')
  }
  // [A] 開發模式：不檢查、不安裝，UI 有話可說
  {
    const { updater, fake } = loadUpdater({ isPackaged: false })
    const st = updater.status()
    assert.strictEqual(st.state, 'unsupported')
    assert.ok(st.message.includes('開發模式'), '開發模式要講原因，不能留白')
    updater.configure({ autoUpdate: true, onStatus: () => {} })
    updater.checkQuietly()
    assert.strictEqual(fake.checkCount, 0, '開發模式不可以真的去檢查')
    assert.strictEqual(updater.installOnQuit(), false)
    assert.strictEqual(updater.quitAndInstall(), false)
    console.log('[A] 開發模式不動作 ✓')
  }

  // [B] 自動更新關閉：只通知有新版，不自己下載
  {
    const seen = []
    const { updater, fake } = loadUpdater({ isPackaged: true })
    updater.configure({ autoUpdate: false, onStatus: (s) => seen.push(s) })
    await updater.check()
    assert.strictEqual(fake.autoDownload, false, 'autoUpdate 關掉時 autoDownload 一定要跟著關')
    assert.strictEqual(fake.autoInstallOnAppQuit, false, 'quit 事件在這個 App 不會發，要自己接管')
    assert.strictEqual(fake.disableDifferentialDownload, true,
      '差分下載一定要關：GitHub 上是一段一個請求且完全序列，實測比整包下載慢 36 倍')
    fake.fire('update-available', { version: '1.12.0' })
    assert.strictEqual(updater.status().state, 'available')
    assert.strictEqual(updater.status().version, '1.12.0')
    assert.ok(seen.length > 0, '狀態要推播給 renderer')
    console.log('[B] 關閉自動更新只通知不下載 ✓')
  }

  // [C] 狀態機：檢查 → 下載 → 完成，百分比與訊息都要跟上
  {
    const { updater, fake } = loadUpdater({ isPackaged: true })
    updater.configure({ autoUpdate: true, onStatus: () => {} })
    await updater.check()
    assert.strictEqual(fake.autoDownload, true)
    fake.fire('checking-for-update')
    assert.strictEqual(updater.status().state, 'checking')
    fake.fire('update-available', { version: '1.12.0' })
    assert.strictEqual(updater.status().state, 'downloading')
    fake.fire('download-progress', { percent: 42.6 })
    assert.strictEqual(updater.status().percent, 43)
    fake.fire('update-downloaded', { version: '1.12.0' })
    assert.strictEqual(updater.status().state, 'downloaded')

    // 結束時安裝：靜默、不要自己重開（使用者按的是「結束」）
    assert.strictEqual(updater.installOnQuit(), true)
    assert.deepStrictEqual(fake.installCalls, [[true, false]])

    // 「重新啟動並安裝」：靜默 ＋ 裝完自己開起來
    assert.strictEqual(updater.quitAndInstall(), true)
    assert.deepStrictEqual(fake.quitCalls, [[true, true]])
    console.log('[C] 下載狀態機與兩種安裝路徑 ✓')
  }

  // [D] 沒下載完就不准裝；錯誤訊息不得夾帶上游原文
  {
    const { updater, fake } = loadUpdater({ isPackaged: true })
    updater.configure({ autoUpdate: true, onStatus: () => {} })
    await updater.check()
    assert.strictEqual(updater.installOnQuit(), false, '沒下載完不可以叫 install')
    assert.strictEqual(fake.installCalls.length, 0)
    const origErr = console.error
    const logged = []
    console.error = (...args) => logged.push(args.join(' '))
    fake.fire('error', new Error('SECRET-TOKEN-abc123 leaked from upstream'))
    console.error = origErr
    const msg = updater.status().message
    assert.strictEqual(updater.status().state, 'error')
    assert.ok(!msg.includes('SECRET-TOKEN'), '上游錯誤原文不可以進 UI')
    assert.ok(!logged.join(' ').includes('SECRET-TOKEN'), '上游錯誤原文不可以進 console')
    console.log('[D] 未下載不安裝、錯誤訊息不外洩 ✓')
  }

  // [E] main.js／preload／package.json 的接線（漏一行就整條靜默失效）
  {
    const main = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8')
    const preload = fs.readFileSync(path.join(ROOT, 'src/preload/preload.js'), 'utf8')
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

    assert.ok(main.includes("require('./updater')"), 'main.js 沒有載入 updater')
    for (const ch of ['update:status', 'update:check', 'update:install']) {
      assert.ok(main.includes(`ipcMain.handle('${ch}'`), `main.js 少了 ${ch} 的 handler`)
      assert.ok(preload.includes(`'${ch}'`), `preload 少了 ${ch}`)
    }
    assert.ok(/updater\.installOnQuit\(\)\s*\n\s*app\.exit\(0\)/.test(main),
      'before-quit 要在 app.exit(0) 之前安裝（exit 不發 quit 事件，autoInstallOnAppQuit 沒用）')
    assert.ok(main.includes("'autoUpdate',"), 'autoUpdate 沒進 STORE_ALLOWLIST')
    assert.ok(Array.isArray(pkg.build.publish) && pkg.build.publish[0].provider === 'github',
      'package.json 少了 publish 設定 → electron-builder 不會產 latest.yml，更新永遠檢查不到')
    assert.ok(pkg.dependencies['electron-updater'], 'electron-updater 要在 dependencies（打包要進 asar）')
    // latest.yml 裡的 url 是連字號版（electron-builder 自己轉的），而預設 artifactName 帶空白 →
    // 上傳到 GitHub 會被改名成 `VoiceInk.Setup.x.y.z.exe`，跟 latest.yml 對不上，下載時 404
    assert.strictEqual(pkg.build.nsis.artifactName, '${productName}-Setup-${version}.${ext}',
      '安裝檔檔名要跟 latest.yml 裡的 url 一模一樣，否則更新下載會 404')
    // 假的 autoUpdater 收得下任何屬性名，打錯字一樣全綠 → 對真的那顆型別定義核一次
    const updaterOut = path.dirname(require.resolve('electron-updater/out/AppUpdater.js'))
    const dts = fs.readFileSync(path.join(updaterOut, 'AppUpdater.d.ts'), 'utf8')
    assert.ok(/disableDifferentialDownload:\s*boolean/.test(dts),
      'electron-updater 換掉了 disableDifferentialDownload 這個名字 → 差分下載會自己開回來（更新慢 36 倍）')
    const nsis = fs.readFileSync(path.join(updaterOut, 'NsisUpdater.js'), 'utf8')
    assert.ok(nsis.includes('downloadUpdateOptions.disableDifferentialDownload'),
      'NsisUpdater 不再看這面旗子了 → 要重新確認關法')

    console.log('[E] IPC／before-quit／publish 接線 ✓')
  }

  // [F] GitHub 安裝檔要先走鏡像：APAC 上官方 CDN 實測 ~50KB/s，代理 ~25MB/s。
  // latest.yml 仍只從 GitHub 讀（sha512 是信任根，不可跟 exe 走同一條代理）。
  {
    const mirrors = require('../src/main/update-mirrors')
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    const pub = pkg.build.publish[0]
    assert.strictEqual(mirrors.OWNER, pub.owner, '鏡像的 owner 要跟 publish 一致')
    assert.strictEqual(mirrors.REPO, pub.repo, '鏡像的 repo 要跟 publish 一致')
    assert.ok(mirrors.MIRRORS.length >= 2, '至少兩條代理，一條掛了還有下一條')
    for (const prefix of mirrors.MIRRORS) {
      assert.ok(prefix.startsWith('https://') && prefix.endsWith('/'), `代理前綴要是 https://…/：${prefix}`)
    }

    const exe = `https://github.com/${pub.owner}/${pub.repo}/releases/download/v1.24.0/VoiceInk-Setup-1.24.0.exe`
    const urls = mirrors.downloadUrls(exe).map((u) => String(u))
    assert.strictEqual(urls[urls.length - 1], exe, '最後一個一定是官方 GitHub，代理全掛才走它')
    assert.ok(urls[0].startsWith(mirrors.MIRRORS[0]), '第一個要走第一條代理')
    assert.ok(urls.includes(`${mirrors.MIRRORS[0]}${exe}`))
    assert.ok(urls.includes(`${mirrors.MIRRORS[1]}${exe}`))
    assert.ok(!urls.some((u, i) => i < urls.length - 1 && u === exe), '官方網址不可排在代理前面（慢但會成功＝永遠輪不到代理）')

    const yml = `https://github.com/${pub.owner}/${pub.repo}/releases/download/v1.24.0/latest.yml`
    assert.deepStrictEqual(mirrors.downloadUrls(yml).map(String), [yml], 'latest.yml 不准走代理')

    const other = 'https://github.com/other/repo/releases/download/v1.0.0/Setup.exe'
    assert.deepStrictEqual(mirrors.downloadUrls(other).map(String), [other], '別人的 repo 不准改寫')

    const dest = path.join(resources, 'installer.exe')
    const calls = []
    const failing = {
      async download(url, destination) {
        calls.push(String(url))
        if (String(url).includes('gh-proxy.com') || String(url).includes('ghfast.top')) {
          fs.writeFileSync(destination, 'partial')
          throw new Error('proxy down')
        }
        fs.writeFileSync(destination, 'full-ok')
        return destination
      }
    }
    mirrors.downloadWithFallback(failing)
    await failing.download(new URL(exe), dest, {})
    assert.ok(calls[0].startsWith(mirrors.MIRRORS[0]), '實際下載第一跳要走代理')
    assert.strictEqual(calls[calls.length - 1], exe, '代理失敗要落到官方')
    assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'full-ok', '失敗那跳留下的半截檔要清掉再試')

    const src = fs.readFileSync(path.join(ROOT, 'src/main/updater.js'), 'utf8')
    assert.ok(src.includes("require('./update-mirrors')"), 'updater.js 沒接鏡像')
    assert.ok(src.includes('downloadWithFallback'), 'httpExecutor.download 沒包鏡像回退')
    console.log('[F] 安裝檔鏡像順序與回退 ✓')
  }

  console.log('\n全部通過')

}

main().catch((err) => { console.error(err); process.exit(1) })
