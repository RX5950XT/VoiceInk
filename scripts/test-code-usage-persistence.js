#!/usr/bin/env node
/**
 * 確認 codeusage.sync 只用一次 electron-store.set 寫完整份狀態。
 *
 * 這裡用假的 store 和空的來源，不碰使用者的 code-usage.json；--baseline
 * 會載入 HEAD 版本，預期故意失敗，證明這條回歸真的抓得到舊行為。
 */

'use strict'

const childProcess = require('child_process')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.join(__dirname, '..')
const SOURCE = path.join(ROOT, 'src/main/codeusage/index.js')
const isBaseline = process.argv.includes('--baseline')

class FakeStore {
  constructor() {
    this.values = {
      rulesVersion: 1,
      buckets: [],
      cursors: {},
      dbCursors: {}
    }
    this.writes = []
    activeStore = this
  }

  get(key, fallback) {
    return Object.prototype.hasOwnProperty.call(this.values, key)
      ? this.values[key]
      : fallback
  }

  set(keyOrPatch, value) {
    this.writes.push({ keyOrPatch, value })
    if (typeof keyOrPatch === 'string') this.values[keyOrPatch] = value
    else Object.assign(this.values, keyOrPatch)
  }
}

let activeStore = null

function loadSource() {
  if (!isBaseline) return fs.readFileSync(SOURCE, 'utf8')
  return childProcess.execFileSync(
    'git',
    ['show', 'HEAD:src/main/codeusage/index.js'],
    { cwd: ROOT, encoding: 'utf8' }
  )
}

function makeRequire() {
  const pricing = {
    RULES_VERSION: 1,
    needsFullRescan: () => false,
    normalizeModel: (model) => model || 'unknown',
    isJunkModel: () => false
  }
  const parsers = {
    parseClaudeLine: () => null,
    parseCodexLine: () => null,
    parseGrokLine: () => null,
    newState: () => ({})
  }
  const scan = {
    SCAN_WINDOW_DAYS: 90,
    scanSource: async () => ({ files: 0, scannedBytes: 0 }),
    pruneCursors: () => {}
  }
  const dbSources = {
    readOpencode: () => [],
    readAntigravity: () => []
  }

  return (request) => {
    if (request === 'os') return { homedir: () => 'C:/fake' }
    if (request === 'path') return path
    if (request === './pricing') return pricing
    if (request === './parsers') return parsers
    if (request === './scan') return scan
    if (request === './db-sources') return dbSources
    throw new Error(`Unexpected require: ${request}`)
  }
}

async function run() {
  let code = loadSource()
  const fakeStore = new FakeStore()
  code += '\ngetStore = async () => fakeStore\nmodule.exports.__runSync = runSync\n'

  const context = {
    Buffer,
    FakeStore,
    console,
    fakeStore,
    module: { exports: {} },
    process,
    require: makeRequire(),
    setTimeout,
    clearTimeout
  }
  vm.runInNewContext(code, context, { filename: SOURCE })
  const codeusage = context.module.exports
  codeusage.configure({ userDataPath: 'C:/fake', homeDir: 'C:/fake' })
  await codeusage.__runSync({})

  const expectedWrites = 1
  const actualWrites = activeStore?.writes.length || 0
  if (actualWrites !== expectedWrites) {
    console.error(`${isBaseline ? 'BASELINE' : 'CURRENT'} FAIL: expected ${expectedWrites} store write, got ${actualWrites}`)
    process.exitCode = 1
    return
  }
  console.log(`${isBaseline ? 'BASELINE' : 'CURRENT'} PASS: one store write`)
}

run().catch((error) => {
  console.error(`${isBaseline ? 'BASELINE' : 'CURRENT'} ERROR: ${error.message}`)
  process.exitCode = 1
})
