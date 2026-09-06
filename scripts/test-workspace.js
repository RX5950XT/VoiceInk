#!/usr/bin/env node
/**
 * VoiceInk — 專案工作區的純邏輯回歸測試（node 直跑，不需 electron）
 *
 * 重點只有兩塊：
 *
 * 1. **路徑逃逸守衛**（`files.resolveIn`）。renderer 送過來的是專案內的相對路徑，
 *    只要有一種寫法能爬出專案根目錄，整個功能就變成「幫你讀寫任意檔案」的 API。
 *    這裡把已知的六種寫法（`..`、絕對路徑、混用分隔符號、NUL、字首相同的鄰居目錄）釘住。
 * 2. **`git status --porcelain=v2 -z` 的解析**。欄位是位置決定的，改名那型
 *    還會在後面多吃一格原檔名——數錯一格就整排檔名錯位。
 *
 * 另外釘住 agent 恢復指令的 id 白名單（那個字串會被送進終端機）。
 */

'use strict'

const path = require('path')
const os = require('os')
const fs = require('fs')
const fsp = require('fs/promises')

const ROOT = path.join(__dirname, '..')
const files = require(path.join(ROOT, 'src/main/workspace/files.js'))
const git = require(path.join(ROOT, 'src/main/workspace/git.js'))
const agents = require(path.join(ROOT, 'src/main/workspace/agents.js'))
const store = require(path.join(ROOT, 'src/main/workspace/store.js'))
const search = require(path.join(ROOT, 'src/main/workspace/search.js'))
const ports = require(path.join(ROOT, 'src/main/workspace/ports.js'))
const worktree = require(path.join(ROOT, 'src/main/workspace/worktree.js'))

let passed = 0
let failed = 0
function ok(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const SEP = path.sep
const NUL = String.fromCharCode(0)
const ROOT_DIR = path.resolve('D:' + SEP + 'Proj')

/** @param {string} rel @returns {boolean} 有沒有被擋下來 */
function blocked(rel) {
  try {
    files.resolveIn(ROOT_DIR, rel)
    return false
  } catch (error) {
    return error.code === 'BAD_PATH'
  }
}

// ===== [A] 路徑逃逸守衛 =====
console.log('\n[A] 路徑逃逸守衛')
{
  ok('往上爬一層', blocked('../x'))
  ok('往上爬（反斜線）', blocked('..' + SEP + 'x'))
  ok('中途才往上爬', blocked('a/b/../../../c'))
  ok('絕對路徑（Windows）', blocked('C:' + SEP + 'Windows' + SEP + 'System32'))
  ok('絕對路徑（POSIX 風格）', blocked('/etc/passwd'))
  ok('NUL 位元組', blocked(NUL + 'x'))
  // 字首相同但其實是隔壁的資料夾——比對沒帶分隔符號就會漏掉這一種
  ok('字首相同的鄰居目錄', blocked('..' + SEP + 'Proj-evil' + SEP + 'x'))

  ok('正常的相對路徑放行', files.resolveIn(ROOT_DIR, 'src/a.js') === path.join(ROOT_DIR, 'src', 'a.js'))
  ok('空字串＝專案根目錄', files.resolveIn(ROOT_DIR, '') === ROOT_DIR)
  ok('`.` 也是根目錄', files.resolveIn(ROOT_DIR, '.') === ROOT_DIR)
  ok('非字串當成根目錄', files.resolveIn(ROOT_DIR, undefined) === ROOT_DIR)
  ok('toRel 一律回 / 分隔', files.toRel(ROOT_DIR, path.join(ROOT_DIR, 'a', 'b.js')) === 'a/b.js')
}

/** 1×1 透明 PNG（真的含 NUL byte，所以能證明圖片沒被判成二進位檔） */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)

// ===== [B] 真的讀寫一輪 =====
async function fileRoundTrip() {
  console.log('\n[B] 檔案讀寫（暫存資料夾）')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-ws-'))
  try {
    fs.mkdirSync(path.join(tmp, 'sub'))
    fs.writeFileSync(path.join(tmp, 'a.md'), '# 標題\n')
    fs.writeFileSync(path.join(tmp, 'sub', 'b.txt'), 'hello')
    fs.writeFileSync(path.join(tmp, 'bin.dat'), Buffer.from([1, 2, 0, 3]))
    fs.writeFileSync(path.join(tmp, 'pic.png'), PNG_1PX)
    fs.mkdirSync(path.join(tmp, 'node_modules'))

    {
      const listed = await files.listDir(tmp, '')
      const names = listed.entries.map((e) => e.name)
      ok('列得到檔案與資料夾', names.includes('a.md') && names.includes('sub'))
      ok('node_modules 被跳過', !names.includes('node_modules'))
      ok('資料夾排在前面', listed.entries[0].dir === true)

      const read = await files.readFile(tmp, 'a.md')
      ok('讀得到內容', read.content === '# 標題\n' && read.binary === false)

      const bin = await files.readFile(tmp, 'bin.dat')
      ok('二進位檔不回內容', bin.binary === true && bin.content === '')

      // 圖片走 `image` 那條，不可以被 NUL byte 判成「二進位檔」（那樣點開等於什麼都沒有）
      const png = await files.readFile(tmp, 'pic.png')
      ok('圖片回 data: URI', png.image === `data:image/png;base64,${PNG_1PX.toString('base64')}`)
      ok('圖片不被判成二進位', png.binary === false)
      ok('.svg 也算圖片', files.imageMime('x/y.SVG') === 'image/svg+xml')
      ok('.txt 不是圖片', files.imageMime('x/y.txt') === '')

      await files.writeFile(tmp, 'sub/b.txt', 'changed')
      ok('存檔生效', fs.readFileSync(path.join(tmp, 'sub', 'b.txt'), 'utf8') === 'changed')
      ok('沒有留下暫存檔', !fs.existsSync(path.join(tmp, 'sub', 'b.txt.voiceink-tmp')))

      let escaped = false
      try {
        await files.writeFile(tmp, '../escape.txt', 'x')
      } catch (error) {
        escaped = error.code === 'BAD_PATH'
      }
      ok('寫檔一樣擋逃逸', escaped)

      let badType = false
      try {
        await files.writeFile(tmp, 'a.md', { not: 'a string' })
      } catch (error) {
        badType = error.code === 'BAD_CONTENT'
      }
      ok('非字串內容被擋', badType)
    }

      // ===== [F] 新增／改名／刪除 =====
    console.log('\n[F] 檔案新增／改名／刪除')
    {
      const made = await files.createEntry(tmp, 'sub', 'new.txt', false)
      ok('新增檔案', made.rel === 'sub/new.txt' && fs.existsSync(path.join(tmp, 'sub', 'new.txt')))

      const dir = await files.createEntry(tmp, '', '新資料夾', true)
      ok('新增資料夾', dir.dir === true && fs.statSync(path.join(tmp, '新資料夾')).isDirectory())

      let dup = false
      try {
        await files.createEntry(tmp, 'sub', 'new.txt', false)
      } catch (error) {
        dup = error.code === 'EXISTS'
      }
      ok('同名的不覆蓋', dup)

      // 名稱是使用者打的，含分隔符號就等於在指定路徑——必須擋在 checkName
      let escaped = 0
      for (const bad of ['../out.txt', 'a/b.txt', 'a\\b.txt', '..', 'CON', '']) {
        try {
          await files.createEntry(tmp, '', bad, false)
        } catch (error) {
          if (error.code === 'BAD_NAME') escaped += 1
        }
      }
      ok('名稱含分隔符號／保留字一律擋掉', escaped === 6, `擋掉 ${escaped}/6`)
      ok('沒有在專案外面建出東西', !fs.existsSync(path.join(tmp, '..', 'out.txt')))

      const moved = await files.renameEntry(tmp, 'sub/new.txt', 'renamed.txt')
      ok('改名', moved.rel === 'sub/renamed.txt'
        && fs.existsSync(path.join(tmp, 'sub', 'renamed.txt'))
        && !fs.existsSync(path.join(tmp, 'sub', 'new.txt')))

      let rootRename = false
      try {
        await files.renameEntry(tmp, '', 'x')
      } catch (error) {
        rootRename = error.code === 'BAD_PATH'
      }
      ok('不准改專案根目錄的名字', rootRename)

      let rootDelete = false
      try {
        await files.removeEntry(tmp, '')
      } catch (error) {
        rootDelete = error.code === 'BAD_PATH'
      }
      ok('不准刪專案根目錄', rootDelete && fs.existsSync(tmp))

      await files.removeEntry(tmp, 'sub/renamed.txt')
      ok('刪檔案', !fs.existsSync(path.join(tmp, 'sub', 'renamed.txt')))
      await files.removeEntry(tmp, '新資料夾')
      ok('刪資料夾', !fs.existsSync(path.join(tmp, '新資料夾')))
    }

    // ===== [G] 專案內搜尋 =====
    console.log('\n[G] 專案內搜尋')
    {
      fs.writeFileSync(path.join(tmp, 'hit.txt'), 'alpha\nBRAVO here\ncharlie\n')
      fs.mkdirSync(path.join(tmp, 'node_modules', 'pkg'), { recursive: true })
      fs.writeFileSync(path.join(tmp, 'node_modules', 'pkg', 'x.js'), 'bravo\n')

      const found = await search.search(tmp, 'bravo')
      const rels = found.hits.map((h) => h.rel)
      ok('找得到（預設不分大小寫）', rels.includes('hit.txt'), JSON.stringify(rels))
      ok('回的是行號', found.hits.find((h) => h.rel === 'hit.txt').line === 2)
      ok('node_modules 不掃', !rels.some((r) => r.startsWith('node_modules')), JSON.stringify(rels))

      const cased = await search.search(tmp, 'bravo', true)
      ok('分大小寫時找不到', cased.hits.length === 0)
      const casedUp = await search.search(tmp, 'BRAVO', true)
      ok('分大小寫時大寫找得到', casedUp.hits.length === 1)

      let short = false
      try {
        await search.search(tmp, 'a')
      } catch (error) {
        short = error.code === 'BAD_QUERY'
      }
      ok('一個字的查詢被擋（不然等於整個專案倒出來）', short)

      // 命中那一行很長時要截斷，否則 minified 檔會把 IPC 塞爆
      const long = `${'x'.repeat(500)}needle${'y'.repeat(500)}`
      ok('長行有截斷', search.trimLine(long, 500).length <= search.MAX_LINE_CHARS + 2,
        String(search.trimLine(long, 500).length))
      ok('短行不動', search.trimLine('abc', 0) === 'abc')

      fs.writeFileSync(path.join(tmp, 'bin2.dat'), Buffer.from([98, 0, 114, 97, 118, 111]))
      const skipBin = await search.search(tmp, 'bravo')
      ok('二進位檔不進結果', !skipBin.hits.some((h) => h.rel === 'bin2.dat'))
    }

  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * [U] 資料夾連結不可以當成後門。
 *
 * `path.resolve` 只做字面運算：在專案裡建一個指向專案外的 junction／symlink，
 * 組出來的路徑看起來完全在專案內，實際讀到的卻是別的地方。
 */
async function linkEscape() {
  console.log('\n[U] 連結逃逸守衛')
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-link-'))
  const proj = path.join(base, 'proj')
  const outside = path.join(base, 'outside')
  fs.mkdirSync(proj)
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET')
  fs.writeFileSync(path.join(proj, 'inside.txt'), 'ok')
  fs.mkdirSync(path.join(proj, 'real'))
  fs.writeFileSync(path.join(proj, 'real', 'deep.txt'), 'deep')

  let madeLink = false
  try {
    fs.symlinkSync(outside, path.join(proj, 'out'), 'junction')
    madeLink = true
  } catch {
    // 沒有建立連結的權限（非 Windows 的某些環境）：這一段跳過
  }
  try {
    ok('專案內的一般檔案照樣讀得到', (await files.readFile(proj, 'inside.txt')).content === 'ok')

    if (madeLink) {
      let escaped = false
      try {
        await files.readFile(proj, 'out/secret.txt')
      } catch (error) {
        escaped = error.code === 'BAD_PATH'
      }
      ok('連到專案外的資料夾連結被擋下來', escaped)

      let wrote = false
      try {
        await files.writeFile(proj, 'out/planted.txt', 'x')
      } catch (error) {
        wrote = error.code === 'BAD_PATH'
      }
      ok('也不准經由連結寫出去', wrote)
      ok('沒有真的寫出去', !fs.existsSync(path.join(outside, 'planted.txt')))
    }

    // 專案內部的連結（指回專案自己）仍然可用——擋的是「連到外面」，不是「有連結」
    let inLink = false
    try {
      fs.symlinkSync(path.join(proj, 'real'), path.join(proj, 'alias'), 'junction')
      inLink = true
    } catch {
      // 同上
    }
    if (inLink) {
      const read = await files.readFile(proj, 'alias/deep.txt')
      ok('專案內部的連結還是能用', read.content === 'deep')
    }

    // 專案根目錄自己住在連結底下也合法（使用者把 junction 拖進側欄）
    let rootLink = ''
    try {
      rootLink = path.join(base, 'projlink')
      fs.symlinkSync(proj, rootLink, 'junction')
    } catch {
      rootLink = ''
    }
    if (rootLink) {
      const read = await files.readFile(rootLink, 'inside.txt')
      ok('專案根目錄本身是連結時照常運作', read.content === 'ok')
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
}

/**
 * [V] 存檔前要比對磁碟版本：外部改過就不准硬蓋。
 */
async function staleWrite() {
  console.log('\n[V] 存檔版本守衛')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-stale-'))
  try {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'v1')
    const first = await files.readFile(tmp, 'a.txt')

    // 外部改一次（把 mtime 往前推，避免同一毫秒內看不出差別）
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'v2-外部')
    const later = new Date(Date.now() + 5000)
    fs.utimesSync(path.join(tmp, 'a.txt'), later, later)

    let stale = false
    try {
      await files.writeFile(tmp, 'a.txt', 'v1-我的', first.mtimeMs)
    } catch (error) {
      stale = error.code === 'STALE'
    }
    ok('外部改過就不准存', stale)
    ok('外部那一版還在', fs.readFileSync(path.join(tmp, 'a.txt'), 'utf8') === 'v2-外部')

    const forced = await files.writeFile(tmp, 'a.txt', 'v3-覆寫')
    ok('不帶版本＝明確覆寫', fs.readFileSync(path.join(tmp, 'a.txt'), 'utf8') === 'v3-覆寫')
    ok('回傳新的版本識別', typeof forced.mtimeMs === 'number' && forced.mtimeMs > 0)

    const again = await files.writeFile(tmp, 'a.txt', 'v4', forced.mtimeMs)
    ok('版本對得上就存得進去', fs.readFileSync(path.join(tmp, 'a.txt'), 'utf8') === 'v4' && again.rel === 'a.txt')

    // 檔案被刪掉之後，普通存檔不可以把它重新建出來
    const before = await files.readFile(tmp, 'a.txt')
    fs.unlinkSync(path.join(tmp, 'a.txt'))
    let gone = false
    try {
      await files.writeFile(tmp, 'a.txt', 'zombie', before.mtimeMs)
    } catch (error) {
      gone = error.code === 'STALE'
    }
    ok('原檔被刪掉就不准無聲重建', gone && !fs.existsSync(path.join(tmp, 'a.txt')))

    // 新建檔案（沒有版本可比）照樣寫得進去
    await files.writeFile(tmp, 'brand-new.txt', 'x')
    ok('全新檔案不受影響', fs.readFileSync(path.join(tmp, 'brand-new.txt'), 'utf8') === 'x')

    // 同一個檔案同時存兩次：暫存檔不可以撞在一起
    await Promise.all([
      files.writeFile(tmp, 'race.txt', 'A'.repeat(5000)),
      files.writeFile(tmp, 'race.txt', 'B'.repeat(5000))
    ])
    const raced = fs.readFileSync(path.join(tmp, 'race.txt'), 'utf8')
    ok('併發存檔不會寫出混在一起的內容', raced === 'A'.repeat(5000) || raced === 'B'.repeat(5000))
    ok('沒有留下暫存檔', fs.readdirSync(tmp).every((n) => !n.includes('voiceink-tmp')))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * [W] AI 記錄的來源：家目錄不是只有一個。
 *
 * 這台機器實測 `CODEX_HOME` 指到別的工作台（Orca）的 runtime home——
 * 只看 `~/.codex` 的話，明明剛跑過的對話一筆都列不出來。
 * 順便釘住「同一個 session 在兩個家目錄各一份時只留最新的一份」。
 */
async function agentHomes() {
  console.log('\n[W] AI 記錄的家目錄與去重')
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-agent-homes-'))
  const home = path.join(base, 'home')
  const runtime = path.join(base, 'runtime')
  fs.mkdirSync(path.join(home, '.codex', 'sessions'), { recursive: true })
  fs.mkdirSync(path.join(runtime, 'sessions'), { recursive: true })

  const project = path.join(base, 'proj')
  fs.mkdirSync(project, { recursive: true })

  const rollout = (id, title) => [
    JSON.stringify({ type: 'session_meta', payload: { id, cwd: project } }),
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: title }] }
    })
  ].join('\n')

  // 同一個 id 兩邊各一份（備份／回填會這樣），runtime 那份比較新
  fs.writeFileSync(path.join(home, '.codex', 'sessions', 'rollout-dup.jsonl'), rollout('dup-000001', '舊的那一份'))
  fs.writeFileSync(path.join(runtime, 'sessions', 'rollout-dup.jsonl'), rollout('dup-000001', '新的那一份'))
  // 只有 runtime 有的那一份
  fs.writeFileSync(path.join(runtime, 'sessions', 'rollout-only.jsonl'), rollout('only-000002', '只有 runtime 有'))

  const originalHome = os.homedir
  const originalCodexHome = process.env.CODEX_HOME
  const originalClaudeDir = process.env.CLAUDE_CONFIG_DIR
  os.homedir = () => home
  process.env.CODEX_HOME = runtime
  delete process.env.CLAUDE_CONFIG_DIR
  try {
    // 這台機器上可能真的裝著別的工作台，所以只驗「順序」與「有沒有收進來」，
    // 不驗總筆數（那會跟機器上裝了什麼綁在一起）
    const homes = agents.codexHomes()
    ok('CODEX_HOME 排在預設家目錄前面', fs.realpathSync.native(runtime) === homes[0])
    ok('預設家目錄也還在', homes.includes(fs.realpathSync.native(path.join(home, '.codex'))))

    const rows = await agents.sessions(project)
    ok('環境變數指到的家目錄也掃得到', rows.some((row) => row.id === 'only-000002'))
    const dup = rows.filter((row) => row.id === 'dup-000001')
    ok('同一個 session 只留一筆', dup.length === 1)
    ok('留下來的是比較新的那一份', dup[0]?.title === '新的那一份')

    // 不存在的家目錄要安靜跳過，不是拋錯
    const missing = path.join(base, 'nope')
    process.env.CODEX_HOME = missing
    ok('家目錄不存在就跳過', !agents.codexHomes().includes(missing))
  } finally {
    os.homedir = originalHome
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = originalCodexHome
    if (originalClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeDir
    fs.rmSync(base, { recursive: true, force: true })
  }

  // 純函式：去重規則本身
  const merged = agents.dedupeSessions([
    { agent: 'claude', id: 'a', mtime: 10, title: '' },
    { agent: 'claude', id: 'a', mtime: 5, title: '有標題' },
    { agent: 'codex', id: 'a', mtime: 1, title: '別家的同名 id' }
  ])
  ok('去重只看 agent + id', merged.length === 2)
  ok('標題只有舊的那份有時會補回來', merged.find((one) => one.agent === 'claude')?.title === '有標題')

  // 工具分類：讀過的不可以被說成改過的
  ok('Edit 算改過', agents.EDIT_TOOLS.test('Edit') && agents.EDIT_TOOLS.test('apply_patch'))
  // 不認得的工具名一律算「讀過」，所以判斷只有 EDIT_TOOLS 這一條
  ok('Read 不算改過', !agents.EDIT_TOOLS.test('Read') && !agents.EDIT_TOOLS.test('Grep'))
  ok('Codex 的參數挑得出路徑', agents.codexFileArg('{"path":"src/a.js","x":1}') === 'src/a.js')
  ok('挑不出路徑就回空字串', agents.codexFileArg('{"command":"ls"}') === '')
}

/**
 * [X] 審閱：`git diff --numstat -z` 的解析與 ref 白名單。
 *
 * 那個 ref 會變成 `git merge-base <ref> HEAD` 的參數。走陣列不會被 shell 吃掉，
 * 但 `-` 開頭會被 git 當成選項、`..` 會變成範圍語法。
 */
async function reviewParsing() {
  console.log('\n[X] 審閱的解析與 ref 白名單')
  const rows = git.parseNumstat('12\t3\tsrc/a.js\x00-\t-\tbin/x.png\x000\t7\tdocs/b b.md\x00')
  ok('numstat 三筆都解得出來', rows.length === 3)
  ok('數字對得上', rows[0].additions === 12 && rows[0].deletions === 3 && rows[0].path === 'src/a.js')
  ok('二進位檔標得出來', rows[1].binary === true && rows[1].additions === 0)
  ok('檔名有空白也不會斷', rows[2].path === 'docs/b b.md')
  ok('空輸入回空陣列', git.parseNumstat('').length === 0)

  ok('正常分支收得下', git.checkRef('feat/voice-input') === 'feat/voice-input')
  ok('遠端分支收得下', git.checkRef('origin/master') === 'origin/master')
  for (const bad of ['--upload-pack=x', 'a..b', 'a b', '', 'x/', 'a;rm -rf /', 'a$(id)']) {
    let code = ''
    try {
      git.checkRef(bad)
    } catch (error) {
      code = error.code
    }
    ok(`ref 擋掉「${bad || '(空的)'}」`, code === 'BAD_REF')
  }

  // 工作樹的路徑比對鍵（Windows 不分大小寫）
  const sameKey = worktree.keyOf('D:/Workspace/Proj') === worktree.keyOf('D:\\Workspace\\Proj\\')
  ok('工作樹路徑比對鍵一致', process.platform === 'win32' ? sameKey : true)
}

/**
 * [Y] 對話與終端機的專案歸屬：可選欄位，缺值＝未分類。
 */
async function projectOwnership() {
  console.log('\n[Y] 對話與終端機的專案歸屬')
  const chatStore = require(path.join(ROOT, 'src/main/chat-store.js'))
  const termStore = require(path.join(ROOT, 'src/main/terminal/store.js'))
  ok('合法的 id 收得下', chatStore.sanitizeProjectId('w_abc_123') === 'w_abc_123')
  ok('缺值＝未分類', chatStore.sanitizeProjectId(undefined) === '')
  ok('路徑之類的字串一律丟掉', chatStore.sanitizeProjectId('../../etc') === '')
  ok('太長的丟掉', chatStore.sanitizeProjectId('w'.repeat(65)) === '')
  ok('終端機那邊同一套', termStore.normalizeProjectId('w_abc_123') === 'w_abc_123'
    && termStore.normalizeProjectId({}) === '')

  const rows = termStore.sanitizeAll([
    { id: 't1', shell: 'pwsh', preset: 'shell', cwd: os.tmpdir(), projectId: 'w_1' },
    { id: 't2', shell: 'pwsh', preset: 'shell', cwd: os.tmpdir() }
  ])
  ok('舊檔沒有這個欄位也讀得起來', rows.length === 2 && rows[1].projectId === '')
  ok('有值的讀得回來', rows[0].projectId === 'w_1')
}

/**
 * [Z] 資料夾監看：哪些變動要理、哪些是雜訊。
 */
async function watchClassify() {
  console.log('\n[Z] 資料夾監看的分類')
  const watch = require(path.join(ROOT, 'src/main/workspace/watch.js'))
  ok('一般檔案要理', watch.classify('src/a.js').ignore === false)
  ok('.git 底下只當成 Git 狀態變了', watch.classify('.git/index').git === true
    && watch.classify('.git/index').ignore === true)
  ok('node_modules 整段丟掉', watch.classify('node_modules/x/y.js').ignore === true
    && watch.classify('node_modules/x/y.js').git === false)
  ok('反斜線的路徑也認得', watch.classify('node_modules\\x\\y.js').ignore === true)
  ok('名字裡有 .git 的資料夾不算', watch.classify('.github/workflows/a.yml').ignore === false)

  // 事件一直來時，純 trailing debounce 會永遠等不到安靜（npm install 就是這樣），
  // 而那正好是最需要更新畫面的時候 → 最久 MAX_WAIT_MS 一定要送一次。
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vi-watch-'))
  try {
    let sent = 0
    const started = watch.start('p-watch', dir, () => { sent += 1 })
    if (!started.watching) {
      console.log('  SKIP 這個檔案系統不支援 recursive watch')
    } else {
      // 固定 1.6 秒，不跟著 MAX_WAIT_MS 走——沒有上限時這個迴圈會永遠跑不完
      const stop = Date.now() + 1600
      while (Date.now() < stop) {
        await fsp.writeFile(path.join(dir, `a${Date.now()}.txt`), 'x')
        await new Promise((r) => setTimeout(r, watch.DEBOUNCE_MS / 4))
      }
      ok('事件一直來也送得出去（不會被 debounce 餓死）', sent >= 1)
    }
  } finally {
    watch.stop()
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * [T2] worktree 移除前的「有什麼擋著」：改名是兩格，不可以算成兩個檔案。
 */
function worktreeDirty() {
  console.log('\n[T2] worktree 的未提交變更計數')

  const NUL = '\0'
  const raw = ['1 .M src/app.js', 'R  new/name.js', 'old/name.js', '?? untracked.log', ''].join(NUL)
  const r = worktree.parseDirty(raw)
  ok('改名只算一個檔案', r.dirty === 3)
  ok('改名取的是新檔名，而且沒被切頭', r.samples.includes('new/name.js'))
  ok('原檔名不會變成獨立一筆', !r.samples.some((s) => s.startsWith('/name.js')))
  ok('空輸入是 0', worktree.parseDirty('').dirty === 0)
}

async function main() {
  await fileRoundTrip()
  await linkEscape()
  await staleWrite()
  await agentHomes()
  await reviewParsing()
  await projectOwnership()
  await watchClassify()
  worktreeDirty()

  // ===== [C] git status --porcelain=v2 -z 解析 =====
  console.log('\n[C] git status 解析')
  {
    const raw = [
      '# branch.oid abc123',
      '# branch.head feat/x',
      '# branch.upstream origin/feat/x',
      '# branch.ab +3 -2',
      '1 .M N... 100644 100644 100644 aaa bbb src/app.js',
      '1 M. N... 100644 100644 100644 aaa bbb 有 空白 的.md',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new/name.js',
      'old/name.js',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflicted.txt',
      '? untracked.log',
      '! ignored.tmp',
      ''
    ].join(NUL)
    const r = git.parseStatus(raw)
    ok('分支', r.branch === 'feat/x')
    ok('上游', r.upstream === 'origin/feat/x')
    ok('ahead/behind', r.ahead === 3 && r.behind === 2)
    ok('檔案筆數（! 不算）', r.files.length === 5, `got ${r.files.length}`)
    ok('工作區已修改', r.files[0].path === 'src/app.js' && r.files[0].worktree === 'M')
    ok('檔名含空白不會被切斷', r.files[1].path === '有 空白 的.md')
    ok('已暫存', r.files[1].index === 'M' && r.files[1].worktree === '.')
    ok('改名取新檔名', r.files[2].path === 'new/name.js')
    ok('改名帶原檔名', r.files[2].from === 'old/name.js')
    ok('原檔名沒有變成另一筆', r.files[3].path === 'conflicted.txt')
    ok('衝突標成 U', r.files[3].index === 'U' && r.files[3].worktree === 'U')
    ok('未追蹤', r.files[4].path === 'untracked.log' && r.files[4].index === '?')

    const detached = git.parseStatus(['# branch.head (detached)', ''].join(NUL))
    ok('detached HEAD 不當成分支名', detached.branch === '')

    const empty = git.parseStatus('')
    ok('空輸出不會炸', empty.files.length === 0 && empty.ahead === 0)

    // 上游還沒設定時 git 不會印 branch.ab，那時候不能憑空給數字
    const noUpstream = git.parseStatus(['# branch.head main', ''].join(NUL))
    ok('沒有上游時 ahead/behind 是 0', noUpstream.ahead === 0 && noUpstream.behind === 0)
  }

  // ===== [D] agent 恢復指令 =====
  console.log('\n[D] agent 恢復指令')
  {
    ok(
      'claude 的指令形狀',
      agents.resumeCommand('claude', '5626ac7b-ff69-4b79-80a4-051aabe4f06e')
        === 'claude --resume 5626ac7b-ff69-4b79-80a4-051aabe4f06e'
    )
    ok('codex 的指令形狀', agents.resumeCommand('codex', 'abc-123') === 'codex resume abc-123')

    /** @param {string} agent @param {string} id */
    const rejects = (agent, id) => {
      try {
        agents.resumeCommand(agent, id)
        return false
      } catch (error) {
        return error.code === 'BAD_AGENT' || error.code === 'BAD_SESSION'
      }
    }
    ok('未知工具被擋', rejects('evil', 'abcdef'))
    ok('指令注入（分號）被擋', rejects('claude', 'abc; rm -rf /'))
    ok('指令注入（空白）被擋', rejects('claude', 'abc def'))
    ok('指令注入（反引號）被擋', rejects('claude', 'abc`whoami`'))
    ok('太短的 id 被擋', rejects('claude', 'ab'))

    ok(
      'Claude 專案資料夾的編碼',
      agents.encodeClaudeDir('D:' + SEP + 'Code' + SEP + 'My_Project' + SEP + 'App')
        === 'D--Code-My-Project-App'
    )

    // 開場那份 AGENTS.md／系統提示不能拿來當標題，否則每一筆長得一模一樣
    ok('系統提示不當標題', agents.looksLikePrompt('# AGENTS.md instructions for D:\\x\n<INSTRUCTIONS>') === false)
    ok('XML 開頭不當標題', agents.looksLikePrompt('<system-reminder>x</system-reminder>') === false)
    ok('真的提問可以當標題', agents.looksLikePrompt('幫我修一下這個 bug') === true)

    const head = agents.codexHead([
      JSON.stringify({ type: 'session_meta', payload: { session_id: 'abc-123', cwd: 'D:\\Proj' } }),
      JSON.stringify({
        type: 'response_item',
        payload: { role: 'user', content: [{ type: 'input_text', text: '幫我加測試' }] }
      })
    ])
    ok('Codex 讀得到 cwd 與 id', head.cwd === 'D:\\Proj' && head.sessionId === 'abc-123')

    const currentFormatHead = agents.codexHead([
      JSON.stringify({ type: 'session_meta', payload: { id: 'xyz-789', cwd: 'D:\\Proj' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '目前格式的提問' }]
        }
      })
    ])
    ok('Codex 新格式讀得到 id 與標題', currentFormatHead.sessionId === 'xyz-789' && currentFormatHead.title === '目前格式的提問')

    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-codex-detail-'))
    const codexDir = path.join(codexHome, '.codex', 'sessions')
    fs.mkdirSync(codexDir, { recursive: true })
    fs.writeFileSync(path.join(codexDir, 'rollout-xyz-789.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { id: 'xyz-789', cwd: 'D:\\Proj' } }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '目前格式的提問' }] }
      }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '目前格式的回答' }] }
      })
    ].join('\n'))
    fs.writeFileSync(path.join(codexDir, 'rollout-other-456.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { id: 'other-456', cwd: 'D:\\Other' } }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '別的專案的提問' }] }
      })
    ].join('\n'))
    const originalHome = os.homedir
    const originalCodexHome = process.env.CODEX_HOME
    const originalClaudeDir = process.env.CLAUDE_CONFIG_DIR
    os.homedir = () => codexHome
    delete process.env.CODEX_HOME
    delete process.env.CLAUDE_CONFIG_DIR
    try {
      const detail = await agents.sessionDetail('D:\\Proj', 'codex', 'xyz-789')
      ok('Codex 新格式 detail 讀得到對話', detail.turns?.length === 2
        && detail.turns[0].text === '目前格式的提問'
        && detail.turns[1].text === '目前格式的回答')
      ok('AI 卡片 detail 契約與 renderer 對得上', detail.sessionId === 'xyz-789'
        && detail.prompts?.length === 1
        && detail.prompts[0].text === '目前格式的提問'
        && detail.toolCallsCount === 0
        // 「改過」與「讀過」是兩個欄位（以前混成一個 modifiedFiles，
        // 看過三十個檔案會被說成改過三十個）
        && Array.isArray(detail.editedFiles) && detail.editedFiles.length === 0
        && Array.isArray(detail.readFiles) && detail.readFiles.length === 0
        && detail.truncated === false)

      // 接續要驗「這段對話是不是這個專案的」，不是只驗 id 長得像不像
      const resumed = await agents.resume('D:\\Proj', 'codex', 'xyz-789')
      ok('接續指令由 main 組', resumed.command === 'codex resume xyz-789')
      let resumeBlocked = ''
      try {
        await agents.resume('D:\\Proj', 'codex', 'other-456')
      } catch (error) {
        resumeBlocked = error.code
      }
      ok('別的專案的對話接續不了', resumeBlocked === 'SESSION_NOT_FOUND')
      let crossProjectBlocked = false
      try {
        await agents.sessionDetail('D:\\Proj', 'codex', 'other-456')
      } catch (error) {
        crossProjectBlocked = error.code === 'SESSION_NOT_FOUND'
      }
      ok('Codex detail 不跨專案讀取', crossProjectBlocked)
    } finally {
      os.homedir = originalHome
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalCodexHome
      if (originalClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = originalClaudeDir
      fs.rmSync(codexHome, { recursive: true, force: true })
    }
    ok('Codex 讀得到標題', head.title === '幫我加測試')

    // fork 出來的子代理是母 thread 的重播，列出來只會多一份一模一樣的
    const forked = agents.codexHead([
      JSON.stringify({
        type: 'session_meta',
        payload: { session_id: 'x', cwd: 'D:\\Proj', forked_from_id: 'y' }
      })
    ])
    ok('fork 的子代理不列', forked.sessionId === '')

    ok('大小寫不同的同一個路徑算同一個', agents.samePath('D:\\Proj', 'd:\\proj') === true)
    ok('結尾分隔符號不影響', agents.samePath('D:\\Proj\\', 'D:\\Proj') === true)
    ok('不同路徑不算同一個', agents.samePath('D:\\Proj', 'D:\\Proj2') === false)
  }

  // ===== [E] 專案清單 sanitize =====
  console.log('\n[E] 專案清單 sanitize')
  {
    const home = os.homedir()
    const items = store.sanitizeAll([
      { id: 'a', path: home, name: '  我的  專案  ' },
      { id: 'a', path: 'D:\\Other' },
      { id: '', path: 'D:\\NoId' },
      { id: 'b', path: 123 },
      { id: 'c', path: home },
      null,
      { id: 'd', path: 'D:\\Real', name: 'x'.repeat(200) }
    ])
    ok('重複 id 只留第一筆', items.filter((i) => i.id === 'a').length === 1)
    ok('沒有 id 的丟掉', !items.some((i) => i.id === ''))
    ok('路徑不是字串的丟掉', !items.some((i) => i.id === 'b'))
    ok('同一個路徑不重複加', items.filter((i) => i.path === path.resolve(home)).length === 1)
    ok('名稱收斂空白', items[0].name === '我的 專案')
    ok('名稱截斷', items[items.length - 1].name.length === store.MAX_NAME)

    const many = store.sanitizeAll(
      Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, path: `D:\\P${i}` }))
    )
    ok('超過上限截斷', many.length === store.MAX_PROJECTS)

    // 資料夾暫時找不到（隨身碟拔掉）不可以整筆丟掉——插回去就沒了
    const missing = store.sanitizeAll([{ id: 'm', path: 'D:\\definitely-not-here-12345' }])
    ok('路徑不存在仍保留該筆', missing.length === 1)
    ok('pathExists 認得出不存在', store.pathExists('D:\\definitely-not-here-12345') === false)
  }

  // ===== [H] 埠號解析 =====
console.log('\n[H] 埠號解析')
{
  // zh-TW 的 Windows 只翻欄位標題，`LISTENING` 本身是英文——這一段就是那個假設的守衛
  const raw = [
    '',
    '使用中連線',
    '',
    '  協定   本機位址               外部位址               狀態            PID',
    '  TCP    0.0.0.0:5173           0.0.0.0:0              LISTENING       4321',
    '  TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       999',
    '  TCP    [::1]:3000             [::]:0                 LISTENING       999',
    '  TCP    192.168.1.9:51000      140.112.1.1:443        ESTABLISHED     777',
    '  TCP    10.0.0.5:9999          0.0.0.0:0              LISTENING       555',
    '  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4'
  ].join('\n')
  const map = ports.parseNetstat(raw)
  ok('抓得到監聽的埠', map.get(5173) === 4321 && map.get(3000) === 999)
  ok('已連線的不算監聽', !map.has(51000))
  ok('別台機器才連得到的位址不列', !map.has(9999))
  ok('IPv4 與 IPv6 的同一個埠只算一次', map.size === 3, String(map.size))

  const named = ports.parseTasklist('"node.exe","4321","Console","1","120,000 K"\n"svchost.exe","999","Services","0","8,000 K"')
  ok('對得回程序名', named.get(4321) === 'node.exe' && named.get(999) === 'svchost.exe')

  ok('埠號不合法就不收', ports.parseAddress('0.0.0.0:abc') === null)
  ok('超過 65535 不收', ports.parseAddress('0.0.0.0:70000') === null)
  ok('本機位址認得出來', ports.parseAddress('[::1]:8080').local === true)
  ok('別人的位址不算本機', ports.parseAddress('192.168.1.9:8080').local === false)
  ok('Windows 自己的服務被過濾', ports.NOISE_PORTS.has(445))
}

// ===== [J] git log 解析與檔名守衛 =====
console.log('\n[J] git log 解析與檔名守衛')
{
  const raw = [
    `abc1234\x1f${Math.floor(Date.now() / 1000)}\x1ffeat: 加工作區`,
    `def5678\x1f${Math.floor(Date.now() / 1000)}\x1ffix: 修守衛`,
    ''
  ].join('\n')
  const entries = git.parseLog(raw)
  ok('log 解析出兩筆', entries.length === 2, JSON.stringify(entries))
  ok('hash 與 subject 對得上', entries[0].short === 'abc1234' && entries[0].subject === 'feat: 加工作區')
  ok('時間戳是數字', Number.isFinite(entries[1].at))
  ok('空輸入回空清單', git.parseLog('').length === 0)
}

// ===== [K] git diff 解析與統計 =====
console.log('\n[K] git diff 解析與統計')
{
  const rawDiff = [
    'diff --git a/test.txt b/test.txt',
    '--- a/test.txt',
    '+++ b/test.txt',
    '@@ -1,3 +1,4 @@',
    ' line 1',
    '-line 2',
    '+line 2 modified',
    '+line 3 added',
    ' line 4'
  ].join('\n')

  let additions = 0
  let deletions = 0
  for (const line of rawDiff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
  }
  ok('計算新增行數', additions === 2)
  ok('計算刪除行數', deletions === 1)
}

// ===== [L] 分頁狀態持久化 sanitizeTabsState =====
console.log('\n[L] 分頁狀態持久化 sanitizeTabsState')
{
  const raw = {
    activeId: 'e:p1:src/index.js',
    tabs: [
      { id: 'e:p1:src/index.js', kind: 'editor', title: 'index.js', relPath: 'src/index.js', draftContent: 'console.log("hi")', preview: false },
      { id: 'd:p1:w:src/index.js', kind: 'diff', title: 'index.js', relPath: 'src/index.js', staged: false },
      { id: 'b:1', kind: 'browser', title: 'Google', url: 'https://www.google.com' },
      { id: 't:1', kind: 'terminal', title: '終端機' }, // 每個專案自己一組終端機分頁，要存
      { id: 'bad', kind: 'unknown', title: 'bad' } // 非法類型該被過濾
    ]
  }
  const clean = store.sanitizeTabsState(raw)
  ok('過濾掉未知 kind', clean.tabs.every(t => ['terminal', 'editor', 'diff', 'browser', 'ai-session'].includes(t.kind)))
  ok('terminal 分頁要存進 tabsState（分頁狀態跟著專案走）',
    clean.tabs.some(t => t.kind === 'terminal' && t.id === 't:1' && t.title === '終端機'))
  ok('editor 保留 draftContent', clean.tabs[0].draftContent === 'console.log("hi")')
  ok('browser 保留合法 http(s) url', clean.tabs[2].url === 'https://www.google.com')
  ok('非 http(s) url 被過濾', store.sanitizeTabsState({ tabs: [{ id: 'b:2', kind: 'browser', url: 'file:///etc/passwd' }] }).tabs[0].url === '')
}

// ===== [M] 外部變更偵測 getFileMtime =====
console.log('\n[M] 外部變更偵測 getFileMtime')
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-mtime-'))
  try {
    const testFile = path.join(tmpDir, 'test.txt')
    fs.writeFileSync(testFile, 'hello')
    const mtimeRes = await files.getFileMtime(tmpDir, 'test.txt')
    ok('成功讀取 mtimeMs', typeof mtimeRes.mtimeMs === 'number' && mtimeRes.mtimeMs > 0)

    // 路徑逃逸應被擋
    let escapeBlocked = false
    try {
      await files.getFileMtime(tmpDir, '../evil.txt')
    } catch (e) {
      escapeBlocked = e.code === 'BAD_PATH'
    }
    ok('逃逸路徑取 mtime 被擋', escapeBlocked)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ===== [N] agentSessionDetail 結構化解析 =====
console.log('\n[N] agentSessionDetail 結構化解析')
{
  // 檢驗 ID_RE 驗證與非法 session 防護
  let rejectBadSession = false
  try {
    await agents.sessionDetail('D:\\test', 'claude', 'bad;id/attack')
  } catch (e) {
    rejectBadSession = e.code === 'BAD_SESSION'
  }
ok('非法 session ID 被擋', rejectBadSession)
}

// ===== [O] workspace IPC service 接線 =====
console.log('\n[O] workspace IPC service 接線')
{
  // main.js 不能直接 require（會啟動 Electron），但 service 是逐一列舉的白名單；
  // 這個檢查會在 renderer 已有 IPC、main 忘了轉接時立刻失敗。
  const mainSource = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8')
  const expected = [
    'saveTabsState',
    'getTabsState',
    'getFileMtime',
    'gitStageAll',
    'gitUnstageAll',
    'listFiles',
    'agentSessionDetail'
  ]
  for (const name of expected) {
    const wired = `${name}: (...args) => loadWorkspace().${name}(...args)`
    ok(`${name} 已接到 main service`, mainSource.includes(wired))
  }
}

// ===== [P] AI 會話 detail caller 傳 projectId =====
console.log('\n[P] AI 會話 detail caller 傳 projectId')
{
  const tabsSource = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/ws-tabs.js'), 'utf8')
  const calls = [...tabsSource.matchAll(/agentSessionDetail\(([^\n]+)\)/g)].map((match) => match[1])
  ok('所有 AI detail caller 都傳 projectId', calls.length === 2 && calls.every((args) => args.trim().startsWith('proj.id,')))
  ok('AI 記錄工具名稱走 textContent', !/\.innerHTML\s*=/.test(tabsSource))
}

// ===== [Q] index.js 的 module.exports 每一個名字都真的有定義 =====
// index.js 要 electron 才 require 得起來，單元測試載不了它 → 少一個定義是
// **載入期的 ReferenceError**，整個 workspace 模組掛掉、每一支 IPC 都回
// 「工作區操作失敗」，而 node --check 與所有既有測試全綠（實測踩過 agentResumeCommand）。
console.log('\n[Q] index.js 的 exports 都有定義')
{
  const indexSource = fs.readFileSync(path.join(ROOT, 'src/main/workspace/index.js'), 'utf8')
  const block = indexSource.slice(indexSource.lastIndexOf('module.exports = {'))
  const names = [...block.matchAll(/^ {2}([A-Za-z_$][\w$]*)\s*,?\s*$/gm)].map((match) => match[1])
  ok('exports 不是空的', names.length > 20, String(names.length))
  const missing = names.filter((name) => !new RegExp(
    `(?:^|\\n)\\s*(?:async\\s+function|function|const|let|var)\\s+${name}\\b`
  ).test(indexSource))
  ok('每個 export 都在檔案裡定義得到', missing.length === 0, missing.join(', '))
}

// ===== [Q2] 三份清單要對得起來：ipc.js ↔ main.js 的 service ↔ preload =====
// `main.js` 的 `registerWorkspaceIpc({ service })` 是**逐一列舉**的白名單
// （AGY 與系統監控都踩過同一條）。ipc.js 加了 handler 但那裡漏一行，
// `service.X` 就是 undefined → TypeError → renderer 只看得到通用的
// 「工作區操作失敗」，IPC 層與單元測試全綠。實測這一輪的 gitBranches 就漏過。
console.log('\n[Q2] ipc.js／main.js／preload 三份清單對得起來')
{
  const ipcSource = fs.readFileSync(path.join(ROOT, 'src/main/workspace/ipc.js'), 'utf8')
  const mainSource = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8')
  const preloadSource = fs.readFileSync(path.join(ROOT, 'src/preload/preload.js'), 'utf8')

  const used = [...new Set([...ipcSource.matchAll(/service\.([A-Za-z_$][\w$]*)\(/g)].map((m) => m[1]))]
  ok('ipc.js 真的有在用 service', used.length > 30, String(used.length))

  const at = mainSource.indexOf('registerWorkspaceIpc({')
  const block = mainSource.slice(at, mainSource.indexOf('isMainSender', at))
  const missing = used.filter((name) => !block.includes(`${name}: (...args)`))
  ok('main.js 的 service 白名單一個都沒漏', missing.length === 0, missing.join(', '))

  const channels = [...new Set(
    [...ipcSource.matchAll(/ipcMain\.handle\('workspace:([A-Za-z_$][\w$]*)'/g)].map((m) => m[1])
  )]
  const noPreload = channels.filter((name) => !preloadSource.includes(`'workspace:${name}'`))
  ok('每一支 IPC 在 preload 都接得到', noPreload.length === 0, noPreload.join(', '))
}

// ===== [R] 快速開檔的檔案清單 =====
// 跟全文搜尋共用同一份 walk，所以**跳過的資料夾一定要一致**——
// 不一致的話會出現「搜尋找得到但 Ctrl+P 找不到」（或反過來）這種說不清的怪事。
console.log('\n[R] 快速開檔的檔案清單 listFiles')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-ws-qo-'))
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'README.md'), '#')
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), '1')
  fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), '1')
  fs.writeFileSync(path.join(dir, '.git', 'config'), '1')

  const result = await search.listFiles(dir)
  const rels = result.paths.slice().sort()
  ok('列得出專案內的檔案', rels.includes('README.md') && rels.includes('src/a.js'), rels.join(', '))
  ok('跳過 node_modules 與 .git', rels.length === 2, rels.join(', '))
  ok('路徑一律是正斜線的相對路徑', rels.every((rel) => !rel.includes('\\') && !path.isAbsolute(rel)))
  ok('沒有超過上限時 truncated 是 false', result.truncated === false)
  fs.rmSync(dir, { recursive: true, force: true })
}

// ===== [S] 拖曳搬檔 files.moveEntry =====
// 搬檔是少數會**弄丟東西**的操作：搬進自己底下會讓整棵子樹變孤兒，
// 覆蓋同名檔則是直接刪掉別人的東西。兩條都要在 main 這一層擋死。
console.log('\n[S] 拖曳搬檔 files.moveEntry')
{
  /**
   * @param {string} label
   * @param {() => Promise<unknown>} run
   * @param {string} code
   */
  const denies = async (label, run, code) => {
    try {
      await run()
      ok(label, false, '沒有擋下來')
    } catch (error) {
      ok(label, error && error.code === code, `code=${error && error.code}`)
    }
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-ws-move-'))
  fs.mkdirSync(path.join(dir, 'src', 'lib'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'a.txt'), 'A')
  fs.writeFileSync(path.join(dir, 'docs', 'a.txt'), 'OTHER')
  fs.writeFileSync(path.join(dir, 'src', 'b.txt'), 'B')

  const moved = await files.moveEntry(dir, 'src/b.txt', 'docs')
  ok('搬得動，而且回相對路徑', moved.rel === 'docs/b.txt', moved.rel)
  ok('原本的位置真的不見了', !fs.existsSync(path.join(dir, 'src', 'b.txt')))
  ok('內容沒變', fs.readFileSync(path.join(dir, 'docs', 'b.txt'), 'utf8') === 'B')

  await denies('目的地有同名檔案就不覆蓋', () => files.moveEntry(dir, 'a.txt', 'docs'), 'EXISTS')
  ok('被擋下來之後原檔還在', fs.readFileSync(path.join(dir, 'docs', 'a.txt'), 'utf8') === 'OTHER')

  await denies('資料夾不能搬進自己底下', () => files.moveEntry(dir, 'src', 'src/lib'), 'BAD_PATH')
  ok('被擋下來之後 src 還在', fs.existsSync(path.join(dir, 'src', 'lib')))

  await denies('不能搬專案資料夾本身', () => files.moveEntry(dir, '', ''), 'BAD_PATH')
  await denies('目的地不是資料夾就拒絕', () => files.moveEntry(dir, 'a.txt', 'docs/a.txt'), 'BAD_PATH')
  await denies('目的地爬不出專案', () => files.moveEntry(dir, 'a.txt', '../paodiao'), 'BAD_PATH')

  const same = await files.moveEntry(dir, 'a.txt', '')
  ok('搬到原本就在的那一層＝什麼都不做', same.rel === 'a.txt', same.rel)

  fs.rmSync(dir, { recursive: true, force: true })
}

// ===== [T] git worktree =====
// `--porcelain` 是「一段一個工作樹、空行分隔」，而且**每段的行數不一樣**
// （detached 的沒有 branch 那行）。數行號一定錯，只能逐行看關鍵字。
console.log('\n[T] git worktree 的解析與分支名白名單')
{
  const raw = [
    'worktree D:/repo',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/master',
    '',
    'worktree D:/repo-feat',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/feat/x',
    '',
    'worktree D:/repo-detached',
    'HEAD 3333333333333333333333333333333333333333',
    'detached',
    'locked someone is using it',
    ''
  ].join('\n')
  const trees = worktree.parseList(raw)
  ok('三個工作樹都解得出來', trees.length === 3, String(trees.length))
  ok('分支名剝掉 refs/heads/', trees[1].branch === 'feat/x', trees[1].branch)
  ok(
    'detached 那段少一行也不會錯位',
    trees[2].path === 'D:/repo-detached' && trees[2].branch === '',
    JSON.stringify(trees[2])
  )
  ok('detached 認得出來', trees[2].detached === true)
  ok('locked 帶原因也算 locked', trees[2].locked === true)
  ok('HEAD 只留前 12 碼', trees[0].head === '111111111111', trees[0].head)

  ok('正常分支名收得下', worktree.checkBranch('feat/new-thing_1.2') === 'feat/new-thing_1.2')
  for (const bad of ['-force', '', '   ', 'a..b', 'a b', 'a;rm -rf /', 'x/', '/x', 'a'.repeat(101)]) {
    let threw = false
    try {
      worktree.checkBranch(bad)
    } catch {
      threw = true
    }
    ok(`分支名擋掉「${bad.slice(0, 12) || '(空的)'}」`, threw)
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
