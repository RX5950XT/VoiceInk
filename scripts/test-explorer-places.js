'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { tempDir, removeTree } = require('./lib/test-temp')
const Module = require('node:module')
const drives = require('../src/main/explorer/drives')

const root = tempDir('voiceink-places-test-')
const originalLoad = Module._load
const originalHome = os.homedir
const folders = ['Desktop', 'Downloads', 'Documents', 'Pictures', 'Music', 'Videos']
let electron = true
try {
  for (const folder of folders) {
    fs.mkdirSync(path.join(root, folder))
    fs.mkdirSync(path.join(root, 'moved-' + folder.toLowerCase()))
  }
  os.homedir = () => root
  Module._load = function (request, ...args) {
    if (request === 'electron') return electron ? {
      app: { getPath: id => path.join(root, 'moved-' + id) }
    } : {}
    return originalLoad.call(this, request, ...args)
  }
  const moved = drives.listPlaces()
  for (const folder of folders) {
    const id = folder.toLowerCase()
    assert.equal(moved.find(item => item.id === id)?.path, path.join(root, 'moved-' + id))
  }
  electron = false
  const fallback = drives.listPlaces()
  for (const folder of folders) {
    assert.equal(fallback.find(item => item.id === folder.toLowerCase())?.path, path.join(root, folder))
  }
  console.log('PASS: 六個 Windows 資料夾使用系統位置；Node 保留家目錄退路')
} finally {
  Module._load = originalLoad
  os.homedir = originalHome
  removeTree(root)
}
