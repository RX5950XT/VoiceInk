#!/usr/bin/env node
/**
 * VoiceInk — 機器上真的有 UFFS 才打真搜尋（可選）。
 *
 * 沒裝就跳過（exit 0）。不改磁碟、不停 daemon。
 * 沒提權時搜尋必須丟 `UFFS_BROKER`（不准默默回空清單）。
 */

'use strict'

const fs = require('fs')
const path = require('path')
const uffs = require(path.join(__dirname, '..', 'src/main/explorer/uffs.js'))

function extraHome() {
  const home = process.env.UFFS_HOME
  if (!home) return
  const exe = path.join(home, 'uffs.exe')
  if (fs.existsSync(exe)) {
    process.env.PATH = `${home}${path.delimiter}${process.env.PATH || ''}`
  }
}

async function main() {
  extraHome()
  const exe = uffs.findUffs()
  if (!exe) {
    console.log('SKIP 這台機器沒有 uffs.exe')
    return
  }
  console.log(`found ${exe}`)
  const st = await uffs.status()
  console.log(JSON.stringify({
    installed: st.installed,
    version: st.version,
    daemon: st.daemon,
    broker: st.broker
  }))
  try {
    const result = await uffs.search('*.txt')
    if (!Array.isArray(result.hits)) throw new Error('hits 不是陣列')
    console.log(`hits=${result.hits.length} truncated=${result.truncated} warming=${result.warming}`)
    if (result.hits[0]) {
      const hit = result.hits[0]
      if (!hit.path || !hit.name) throw new Error('命中缺欄位')
      if (hit.path.includes('\0')) throw new Error('路徑含 NUL')
    }
    console.log('PASS 真搜尋回得了結構化命中')
  } catch (error) {
    if (error && error.code === 'UFFS_BROKER' && error.userMessage === '需要授權讀取磁碟') {
      console.log('PASS 未提權時明確要求授權，不回空清單')
      return
    }
    throw error
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
