#!/usr/bin/env node
/**
 * 實機效能調整 probe：GPU 核心 +15 MHz，測完還原。
 * sidecar 有要求系統管理員，所以會跳一次 UAC。不碰風扇、不改電壓、功耗牆維持原樣。
 *
 * 用法：node scripts/probe-sysmon-oc.js
 */
'use strict'

const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const EXE = path.join(__dirname, '..', 'resources', 'sensors', 'VoiceInkSensors.exe')
const LOG = path.join(os.tmpdir(), 'voiceink-oc-probe.jsonl')

function smi() {
  const raw = execFileSync('nvidia-smi', [
    '--query-gpu=name,clocks.gr,clocks.max.gr,power.limit,power.default_limit,power.draw',
    '--format=csv,noheader,nounits'
  ], { encoding: 'utf8', windowsHide: true }).trim()
  const p = raw.split(',').map((s) => s.trim())
  return { name: p[0], gr: Number(p[1]), maxGr: Number(p[2]), powerLimit: Number(p[3]), powerDefault: Number(p[4]), powerDraw: Number(p[5]) }
}

function parseLog() {
  if (!fs.existsSync(LOG)) return []
  return fs.readFileSync(LOG, 'utf8').split(/\r?\n/).map((line) => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean)
}

function parseSmiField(raw, index) {
  const parts = String(raw || '').split(',').map((s) => s.trim())
  const n = Number(parts[index])
  return Number.isFinite(n) ? n : null
}

function main() {
  if (!fs.existsSync(EXE)) {
    console.error('找不到 VoiceInkSensors.exe')
    process.exitCode = 1
    return
  }
  try { fs.unlinkSync(LOG) } catch { /* 沒有舊檔 */ }

  const before = smi()
  console.log('套用前（本行程 nvidia-smi）')
  console.log(`  ${before.name}  核心 ${before.gr}/${before.maxGr} MHz  功耗牆 ${before.powerLimit} W  目前 ${before.powerDraw} W`)
  console.log('\n請在 UAC 按「是」。只加 15 MHz，跑完會還原。\n')

  const ps = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `Start-Process -FilePath '${EXE.replace(/'/g, "''")}' -ArgumentList '--oc-probe' -Verb RunAs -Wait -WindowStyle Hidden`
  ]
  execFileSync('powershell.exe', ps, { stdio: 'inherit', windowsHide: true })

  const after = smi()
  const events = parseLog()
  console.log('\nprobe 紀錄')
  for (const event of events) console.log(' ', JSON.stringify(event))

  const base = events.find((e) => e.step === 'baseline') || {}
  const app = events.find((e) => e.step === 'applied') || {}
  const rest = events.find((e) => e.step === 'restored') || {}
  const nvapiDelta = Number(app.co) - Number(base.co)
  const smiMaxMid = parseSmiField(app.smi, 1)
  const smiMaxBefore = parseSmiField(base.smi, 1)
  const smiMaxAfter = parseSmiField(rest.smi, 1)
  const smiPowerBefore = parseSmiField(base.smi, 2)
  const smiPowerMid = parseSmiField(app.smi, 2)
  const smiPowerAfter = parseSmiField(rest.smi, 2)

  console.log('\n還原後（本行程 nvidia-smi）')
  console.log(`  核心 ${after.gr}/${after.maxGr} MHz  功耗牆 ${after.powerLimit} W  目前 ${after.powerDraw} W`)
  console.log('\n判定')
  console.log(`  NVAPI 偏移 ${base.co} → ${app.co} → ${rest.co}  delta=${nvapiDelta}`)
  console.log(`  nvidia-smi 最大核心 ${smiMaxBefore} → ${smiMaxMid} → ${smiMaxAfter}`)
  console.log(`  nvidia-smi 功耗牆 ${smiPowerBefore} → ${smiPowerMid} → ${smiPowerAfter}`)
  console.log(`  結束後功耗牆 ${after.powerLimit}（應維持 ${before.powerLimit}）`)

  const restored = Number(rest.co) === Number(base.co) && after.powerLimit === before.powerLimit
  const wrote = app.ok === true && (nvapiDelta === 15 || Number(app.co) === Number(base.co) + 15)
  if (wrote && restored) {
    console.log(smiMaxMid === (smiMaxBefore + 15)
      ? '\nPASS  nvidia-smi 最大核心 +15，且已還原'
      : '\nPASS  NVAPI 讀回 +15 且已還原（此卡 nvidia-smi 最大時脈不跟偏移走）')
    return
  }
  console.log('\nFAIL')
  process.exitCode = 1
}

main()
