#!/usr/bin/env node
/**
 * VoiceInk — 檔案總管 Ctrl+滾輪縮放 ＋ 終端機貼上截圖的回歸（node 直跑，不開 Electron）
 *
 *  [A] 縮放級距：往上滾一級一級變大、在最小的方格往下滾掉回清單、兩端不會滾出界
 *  [B] `explorer/store.js` 的 `tile` 消毒：只收級距裡的值，怪值靠回最近的一級
 *  [C] renderer 與 main 的級距是同一份（兩邊各寫一份遲早會不一致）
 *  [D] 剪貼簿截圖的落檔資料夾：舊圖會被掃掉，最近的留著
 *  [E] 大預覽的網址：`vi-media://` 的 `~local` 路線解得回同一條絕對路徑
 *
 * 用法：node scripts/test-explorer-zoom.js
 */

'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tempDir, removeTree } = require('./lib/test-temp')

const ROOT = path.join(__dirname, '..')
const store = require(path.join(ROOT, 'src/main/explorer/store.js'))
const media = require(path.join(ROOT, 'src/main/workspace/media.js'))
const clipboardImage = require(path.join(ROOT, 'src/main/terminal/clipboard-image.js'))

let passed = 0
let failed = 0
function ok(name, cond, detail = '') {
  if (cond) {
    passed += 1
    console.log(`  PASS ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/**
 * renderer 的 `explorer-zoom.js` 是 ESM，這支測試是 CJS——直接讀原始碼再 import
 * 那一段太重，改用 `data:` URI 動態載入（沒有 DOM 相依，純函式）。
 */
async function loadZoom() {
  const file = path.join(ROOT, 'src/renderer/scripts/explorer-zoom.js')
  return import(`file:///${file.replace(/\\/g, '/')}`)
}

async function main() {
  const zoom = await loadZoom()
  const { nextZoomState, TILE_SIZES } = zoom

  console.log('\n[A] Ctrl+滾輪的級距')
  {
    const up = nextZoomState({ view: 'list', tile: 96 }, -100)
    ok('清單往上滾＝跳進最小的方格', up.view === 'grid' && up.tile === TILE_SIZES[0], JSON.stringify(up))

    const down = nextZoomState({ view: 'grid', tile: TILE_SIZES[0] }, 100)
    ok('最小的方格往下滾＝掉回清單', down.view === 'list', JSON.stringify(down))

    // 一級一級走，不可以一次跳兩級
    let state = { view: 'grid', tile: TILE_SIZES[0] }
    for (let i = 1; i < TILE_SIZES.length; i += 1) {
      state = nextZoomState(state, -100)
      if (state.tile !== TILE_SIZES[i]) break
    }
    ok('往上滾一次只跳一級', state.view === 'grid' && state.tile === TILE_SIZES[TILE_SIZES.length - 1], JSON.stringify(state))

    const top = nextZoomState({ view: 'grid', tile: TILE_SIZES[TILE_SIZES.length - 1] }, -100)
    ok('最大之後再滾還是最大', top.tile === TILE_SIZES[TILE_SIZES.length - 1], JSON.stringify(top))

    const bottom = nextZoomState({ view: 'list', tile: 96 }, 100)
    ok('清單再往下滾仍是清單', bottom.view === 'list', JSON.stringify(bottom))

    const idle = nextZoomState({ view: 'grid', tile: 96 }, 0)
    ok('沒滾就不動', idle.view === 'grid' && idle.tile === 96)
  }

  console.log('\n[B] tile 的消毒（explorer.json）')
  {
    ok('級距內的值照收', store.sanitizeTile(128) === 128)
    ok('缺值回預設', store.sanitizeTile(undefined) === store.DEFAULT_TILE)
    ok('字串也回預設', store.sanitizeTile('大') === store.DEFAULT_TILE)
    ok('怪值靠回最近的一級', store.sanitizeTile(200) === 180, String(store.sanitizeTile(200)))
    ok('超大值夾在最大級', store.sanitizeTile(99999) === 256, String(store.sanitizeTile(99999)))
    ok('負數也夾得住', store.sanitizeTile(-5) === 48, String(store.sanitizeTile(-5)))
  }

  console.log('\n[C] 兩邊的級距要一樣')
  {
    ok('renderer 與 main 的 TILE_SIZES 相同',
      JSON.stringify(TILE_SIZES) === JSON.stringify(store.TILE_SIZES),
      `${JSON.stringify(TILE_SIZES)} vs ${JSON.stringify(store.TILE_SIZES)}`)
    ok('預設值也一樣', zoom.DEFAULT_TILE === store.DEFAULT_TILE)
  }

  console.log('\n[D] 剪貼簿截圖的落檔資料夾')
  {
    const userData = tempDir('voiceink-clipimg-')
    clipboardImage.configure(userData)
    const dir = path.join(userData, 'clipboard-images')
    fs.mkdirSync(dir, { recursive: true })
    // 一張很舊的（超過保留時間）＋ 一張剛剛的
    const old = path.join(dir, 'clip-20200101-000000-000.png')
    const fresh = path.join(dir, 'clip-20990101-000000-000.png')
    fs.writeFileSync(old, 'x')
    fs.writeFileSync(fresh, 'x')
    const longAgo = new Date(Date.now() - clipboardImage.KEEP_MS - 60000)
    fs.utimesSync(old, longAgo, longAgo)
    // 不是我們產的檔案不准碰
    const other = path.join(dir, 'keep-me.txt')
    fs.writeFileSync(other, 'x')
    await clipboardImage.sweep()
    ok('過期的截圖被清掉', !fs.existsSync(old))
    ok('剛貼的那張留著', fs.existsSync(fresh))
    ok('不是截圖的檔案不動它', fs.existsSync(other))

    // 超過張數上限就從最舊的刪起
    for (let i = 0; i < clipboardImage.KEEP_FILES + 5; i += 1) {
      const file = path.join(dir, `clip-20990101-0000${String(i).padStart(2, '0')}-000.png`)
      fs.writeFileSync(file, 'x')
      const at = new Date(Date.now() - (clipboardImage.KEEP_FILES + 5 - i) * 1000)
      fs.utimesSync(file, at, at)
    }
    await clipboardImage.sweep()
    const left = fs.readdirSync(dir).filter((name) => name.startsWith('clip-'))
    ok('張數夾在上限', left.length <= clipboardImage.KEEP_FILES, `剩下 ${left.length} 張`)

    const name = clipboardImage.fileNameAt(new Date(2026, 8, 21, 13, 45, 1, 7))
    ok('檔名看得懂也排得動', name === 'clip-20260921-134501-007.png', name)
    removeTree(userData)
  }

  console.log('\n[E] 大預覽的網址')
  {
    const full = 'D:\\相簿\\1920-1080 狂三 01.png'
    const url = media.localUrlFor(full)
    const parsed = new URL(url)
    const [id, ...rest] = parsed.pathname.slice(1).split('/').map(decodeURIComponent)
    ok('走 vi-media 協定', parsed.protocol === `${media.SCHEME}:`, parsed.protocol)
    ok('走 ~local 那條路線', id === media.LOCAL_ID, id)
    ok('反斜線、空白、中文都原樣解得回來', rest.join('/') === full, rest.join('/'))
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
