'use strict'

/**
 * CSV 組字。Excel 要 UTF-8 BOM，逗號與換行要加引號。
 */

/** @param {unknown} value */
function csvCell(value) {
  const s = value == null ? '' : String(value)
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/**
 * @param {string[]} headers
 * @param {unknown[][]} rows
 */
function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')]
  for (const row of rows) lines.push(row.map(csvCell).join(','))
  return `${lines.join('\r\n')}\r\n`
}

module.exports = { csvCell, toCsv }
