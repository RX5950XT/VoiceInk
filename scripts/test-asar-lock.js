/**
 * 回歸：列資料夾／看檔案資訊碰到 `app.asar`，不可以把那個檔案鎖住。
 * 用法：npx electron scripts/test-asar-lock.js
 *
 * Electron 的 `fs` 把 `.asar` 當資料夾打開，而且開了就不關——檔案總管列過一次打包輸出，
 * 那個 `app.asar` 就刪不掉、下一次打包也會 `EBUSY: unlink app.asar`，直到 App 關掉。
 */
const { app } = require('electron')
const path = require('path')
const fs = require('original-fs')
const asar = require('@electron/asar')
const { tempDir } = require('./lib/test-temp')

const ROOT = path.join(__dirname, '..')
let passed = 0
let failed = 0

function ok(name, cond, detail = '') {
  if (cond) passed += 1
  else failed += 1
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` — ${detail}`}`)
}

/**
 * @param {string} name
 * @param {(dir: string, file: string) => Promise<void>} touch
 */
async function check(name, touch) {
  const dir = tempDir('asar-lock-')
  const src = path.join(dir, 'src')
  fs.mkdirSync(src)
  fs.writeFileSync(path.join(src, 'a.txt'), 'hello')
  const target = path.join(dir, 'pack')
  fs.mkdirSync(target)
  const file = path.join(target, 'app.asar')
  await asar.createPackage(src, file)
  let error = ''
  try {
    await touch(target, file)
  } catch (e) {
    error = e?.code || e?.message || String(e)
  }
  try {
    fs.unlinkSync(file)
    ok(`${name}：之後 app.asar 刪得掉`, true)
  } catch (e) {
    ok(`${name}：之後 app.asar 刪得掉`, false, `${e.code}${error ? `（呼叫本身：${error}）` : ''}`)
  }
}

app.whenReady().then(async () => {
  try {
    const explorerFs = require(path.join(ROOT, 'src/main/explorer/fs.js'))
    const explorerPaths = require(path.join(ROOT, 'src/main/explorer/paths.js'))
    const workspaceFiles = require(path.join(ROOT, 'src/main/workspace/files.js'))
    const search = require(path.join(ROOT, 'src/main/workspace/search.js'))
    const links = require(path.join(ROOT, 'src/main/terminal/links.js'))

    await check('檔案總管列資料夾', (dir) => explorerFs.listDir(dir))
    await check('檔案總管看詳細資訊', (dir, file) => explorerFs.inspect(file))
    await check('檔案總管解析路徑', (dir, file) => Promise.resolve(explorerPaths.resolveExisting(file)))
    await check('工作區列資料夾', (dir) => workspaceFiles.listDir(dir, ''))
    await check('工作區讀檔', (dir) => workspaceFiles.readFile(dir, 'app.asar').catch(() => {}))
    await check('工作區快速開檔清單', (dir) => search.listFiles(dir))
    await check('工作區全文搜尋', (dir) => search.search(dir, 'hello'))
    await check('終端機連結偵測', (dir, file) => Promise.resolve(links.resolveCandidate(dir, file)))
  } catch (e) {
    ok('測試本身跑得起來', false, e?.stack || String(e))
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  app.exit(failed ? 1 : 0)
})
