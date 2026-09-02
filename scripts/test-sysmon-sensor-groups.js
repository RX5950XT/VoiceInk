'use strict'
/**
 * 感測器分組的純函式測試。
 *
 * sysmon-page.js 是 renderer 的 ESM，載入時會碰 `document`／`localStorage` 與 `./app.js`，
 * 所以這裡把原始碼的 import／export 剝掉再用 `new Function` 跑一次——不必為了測四個
 * 純函式把它們拆成另一個檔案，也不會因為 renderer 那邊改了排版就對不上。
 * 檔案語法壞掉時這支會第一個紅。
 *
 * 用法：node scripts/test-sysmon-sensor-groups.js
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'src/renderer/scripts/sysmon-page.js')

let failed = 0
function ok(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

function loadHelpers() {
  const src = fs.readFileSync(SRC, 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '')
  const fn = new Function('document', 'localStorage', 'electronAPI',
    'initCustomSelects', 'syncCustomSelects',
    `${src}\nreturn { sensorGroups, sensorRow, sensorHwLabel, sensorValueText }`)
  const noop = () => {}
  return fn(
    { getElementById: () => null, createElement: () => ({ append: noop, appendChild: noop }) },
    { getItem: () => null, setItem: noop },
    {}, noop, noop
  )
}

/** 2026-09 在 Ryzen 5700X ＋ 四條 DIMM 上實際抓到的形狀（值已裁短） */
const SAMPLE = {
  available: true,
  groups: [
    { n: 'ITE IT8688E', t: 'SuperIO', s: [{ n: 'Temperature #1', t: 'Temperature', v: 34 }, { n: 'Fan #1', t: 'Fan', v: 1080 }] },
    { n: 'ITE IT8791E/IT8792E/IT8795E', t: 'SuperIO', s: [{ n: 'Temperature #1', t: 'Temperature', v: 41 }, { n: 'Fan #1', t: 'Fan', v: 720 }] },
    { n: 'AMD Ryzen 7 5700X', t: 'Cpu', s: [{ n: 'Core (Tctl/Tdie)', t: 'Temperature', v: 52.34 }] },
    { n: 'Total Memory', t: 'Memory', s: [{ n: 'Memory Used', t: 'Data', v: 28.377 }] },
    { n: 'Virtual Memory', t: 'Memory', s: [{ n: 'Memory Used', t: 'Data', v: 35.977 }] },
    {
      n: ' -  (#0)',
      t: 'Memory',
      s: [
        { n: 'tCKAVGmin (Minimum Cycle Time)', t: 'Timing', v: 0.75 },
        { n: 'tAA (CAS Latency Time)', t: 'Timing', v: 13.75 },
        { n: 'tRFC1 (Refresh Recovery Delay Time)', t: 'Timing', v: 350 },
        { n: 'tWR (Write Recovery Time)', t: 'Timing', v: 0 }
      ]
    },
    {
      n: 'Samsung - 32G3200CL22 (#2)',
      t: 'Memory',
      s: [
        { n: 'tCKAVGmin (Minimum Cycle Time)', t: 'Timing', v: 0.625 },
        { n: 'tAA (CAS Latency Time)', t: 'Timing', v: 13.75 },
        { n: 'tRRD_S (Activate to Activate Delay Time)', t: 'Timing', v: 2.5 }
      ]
    }
  ]
}

const h = loadHelpers()

console.log('[A] 時序數值')
ok('小數不被進位掉（0.625 ns 不是 1 ns）',
  h.sensorValueText({ t: 'Timing', v: 0.625 }) === '0.625 ns',
  h.sensorValueText({ t: 'Timing', v: 0.625 }))
ok('整數時序不長出小數點', h.sensorValueText({ t: 'Timing', v: 350 }) === '350 ns',
  h.sensorValueText({ t: 'Timing', v: 350 }))
ok('時脈仍是整數', h.sensorValueText({ t: 'Clock', v: 3593.7 }) === '3594 MHz',
  h.sensorValueText({ t: 'Clock', v: 3593.7 }))
ok('溫度仍保留一位小數', h.sensorValueText({ t: 'Temperature', v: 52.34 }) === '52.3 °C',
  h.sensorValueText({ t: 'Temperature', v: 52.34 }))

console.log('[B] 列標籤：縮寫當標籤、全名跟著值')
{
  const [label, value] = h.sensorRow({ n: 'tAA (CAS Latency Time)', t: 'Timing', v: 13.75 })
  ok('標籤只留縮寫', label === 'tAA', label)
  ok('全名沒被丟掉', value === '13.75 ns · CAS Latency Time', value)
}
{
  const [label, value] = h.sensorRow({ n: 'Core (Tctl/Tdie)', t: 'Temperature', v: 52.34 })
  ok('非時序不動原本的名字', label === 'Core (Tctl/Tdie)' && value === '52.3 °C', `${label} / ${value}`)
}

console.log('[C] 硬體名稱')
ok('空廠商的 SPD 退回槽號', h.sensorHwLabel(' -  (#0)') === '插槽 #0', h.sensorHwLabel(' -  (#0)'))
ok('破折號收成空白', h.sensorHwLabel('Samsung - 32G3200CL22 (#2)') === 'Samsung 32G3200CL22 (#2)',
  h.sensorHwLabel('Samsung - 32G3200CL22 (#2)'))

console.log('[D] 同一種讀數散在多個硬體上要分開')
{
  const groups = h.sensorGroups(SAMPLE, 'Memory', '記憶體')
  const timing = groups.filter((g) => g.title.startsWith('記憶體時序'))
  ok('每條記憶體各一組時序，不是全部倒進同一張表', timing.length === 2,
    JSON.stringify(timing.map((g) => g.title)))
  ok('標題點名是哪一條', timing.some((g) => g.title === '記憶體時序 · 插槽 #0')
    && timing.some((g) => g.title === '記憶體時序 · Samsung 32G3200CL22 (#2)'),
    JSON.stringify(timing.map((g) => g.title)))
  const first = timing.find((g) => g.title.includes('插槽 #0')) || { rows: [] }
  ok('tAA 在自己那組只出現一次', first.rows.filter(([k]) => k === 'tAA').length === 1)
  ok('讀不到的 0 仍然被丟掉（tWR）', first.rows.length > 0 && !first.rows.some(([k]) => k === 'tWR'),
    JSON.stringify(first.rows.map(([k]) => k)))
  const data = groups.filter((g) => g.title.includes('累計資料量'))
  ok('Total／Virtual Memory 也各自成組，不再撞名', data.length === 2,
    JSON.stringify(data.map((g) => g.title)))
}
{
  const groups = h.sensorGroups(SAMPLE, (t) => t === 'SuperIO', '主機板')
  ok('兩顆 ITE 晶片的 Temperature #1 不互相蓋掉',
    groups.filter((g) => g.title.startsWith('主機板溫度')).length === 2,
    JSON.stringify(groups.map((g) => g.title)))
}
{
  const groups = h.sensorGroups(SAMPLE, 'Cpu', 'CPU ')
  ok('只有一個硬體時標題不加後綴', groups.length === 1 && groups[0].title === 'CPU 溫度',
    JSON.stringify(groups.map((g) => g.title)))
}

console.log(failed ? `\n${failed} 項失敗` : '\n全部通過')
process.exit(failed ? 1 : 0)
