'use strict'

const assert = require('assert/strict')
const fs = require('fs')
const vm = require('vm')

const filter = require('../src/main/explorer/search-filter')
const store = require('../src/main/explorer/store')
const source = fs.readFileSync('src/renderer/scripts/explorer-browse.js', 'utf8')
  .replace(/^export /gm, '')
const context = { module: { exports: {} }, console }
vm.createContext(context)
vm.runInContext(`${source}\nmodule.exports = { normalizeBrowseState, normalizeBrowseTab, normalizeBrowsePage, mergeBrowsePage, visibleBrowseRange, pageOffsetsForRange, browseEntryId, selectedLoadedIds, selectBrowseRange }`, context)
const browse = context.module.exports

function ok(label, condition) {
  assert.equal(Boolean(condition), true, label)
}

const tab = store.sanitizeTab({
  id: 'bad id',
  cwd: 'C:\\missing-folder',
  history: ['C:\\missing-folder', 'thispc', 'bad'],
  histIndex: 99,
  state: {
    view: 'grid', sort: 'size', sortDesc: true, search: '  photo  ',
    selected: ['C:\\missing-folder\\a.txt'], scrollTop: 1234
  }
}, 't9')
ok('per-tab state keeps missing path without probing it', tab.cwd === 'C:\\missing-folder')
ok('invalid tab id falls back', tab.id === 't9')
ok('history is bounded and valid virtual path survives', tab.history.includes('thispc') && tab.histIndex === 1)
ok('selection and scroll survive sanitization', tab.selected.length === 1 && tab.scrollTop === 1234)

const state = browse.normalizeBrowseState({ view: 'grid', search: '  abc  ', selected: ['a'], scrollTop: 40 })
ok('renderer state preserves per-tab fields', state.view === 'grid' && state.search === 'abc' && state.selected[0] === 'a')
const page0 = browse.normalizeBrowsePage({ entries: [{ path: 'a' }, { path: 'b' }], offset: 0, total: 50002 })
const page1 = browse.mergeBrowsePage([], page0)
const page2 = browse.mergeBrowsePage(page1.entries, {
  entries: [{ path: 'x' }, { path: 'y' }], offset: 50000, total: 50002
})
ok('pages merge without dropping earlier selection range', page2.entries[0].path === 'a' && page2.entries[50000].path === 'x')
ok('50k range is virtualized', browse.visibleBrowseRange({ total: 50002, scrollTop: 36 * 49990, viewportHeight: 720 }).start < 49990)
assert.equal(JSON.stringify(browse.pageOffsetsForRange(49990, 50002, 500)), '[49500,50000]')
assert.equal(JSON.stringify(browse.selectedLoadedIds(['a', 'x', 'not-loaded'], page2.entries)), '["a","x"]')
assert.equal(JSON.stringify(browse.selectBrowseRange([{ path: 'a' }, { path: 'b' }, { path: 'c' }], 'a', 'c')), '["a","b","c"]')
ok('filter type and size', filter.matchesSearchFilters(
  { path: 'C:\\data\\a.png', name: 'a.png', size: 100, mtimeMs: 10, dir: false },
  { type: 'image', minSize: 50 }
))
ok('generic file filter keeps files', filter.matchesSearchFilters(
  { path: 'C:\\data\\a.bin', name: 'a.bin', size: 100, dir: false },
  { type: 'file' }
))
ok('filter location boundary', !filter.matchesSearchFilters(
  { path: 'C:\\database\\a.png', name: 'a.png', size: 100, dir: false },
  { type: 'image', location: 'C:\\data' }
))
assert.equal(filter.sanitizeSearchFilters({ minSize: 500, maxSize: 100, from: '2026-01-02', to: '2026-01-01' }).minSize, 100)
assert.equal(filter.classifySearchType({ name: 'a.zip' }), 'archive')
console.log('PASS: explorer browse state, page merge, virtualization, cross-page selection, UFFS filters')
