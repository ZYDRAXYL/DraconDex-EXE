'use strict';
// ═══ CSV → Classifier (v5 Part 7, APP docs/V5.md §11.10) ════════════════
// For the user whose characters or items already live in Excel. The first
// row is the field names, the first column the object names, every other
// row an object. This file only reads: decode, parse, guess each column's
// type. The renderer shows a preview where every guess can be changed, and
// the Classifier is then made in one transaction by db/bundle.js.
//
// Encoding (the user's pick of the §11.10 proposal): a CSV Excel saves on
// Thai Windows is NOT UTF-8 but the system code page, windows-874 — read as
// UTF-8 every Thai name turns to mojibake, and that is the first thing the
// target user meets. So: a BOM decides; else strict UTF-8; else windows-874.
const fs = require('fs');

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 5000;

function decodeCsvBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8' };
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le' };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be' };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' }; } catch (_) {}
  return { text: new TextDecoder('windows-874').decode(buf), encoding: 'windows-874' };
}

// RFC 4180, plus the delimiter Excel uses where a comma is the decimal mark
// (';') and tab-separated text. Quotes may hold delimiters, newlines and "".
function parseCsv(text) {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const count = (ch) => (firstLine.match(new RegExp(ch === '\t' ? '\\t' : `\\${ch}`, 'g')) || []).length;
  const delim = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += c;
    } else if (c === '"' && field === '') inQ = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
      if (rows.length > MAX_ROWS) break;
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((v) => v !== '')) rows.push(row); }
  return { rows, delimiter: delim };
}

const BOOL_RE = /^(true|false|yes|no|y|n|จริง|เท็จ|ใช่|ไม่ใช่|✓|✗)$/i;
const DATE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

// A column's type from its non-empty values: all numbers → number, all
// true/false words → checkbox, all ISO dates → date, else text (a long
// value makes it textarea). An empty column is text.
function guessColumnType(values) {
  const vs = values.map((v) => String(v ?? '').trim()).filter(Boolean);
  if (!vs.length) return 'text';
  if (vs.every((v) => /^-?\d+(\.\d+)?$/.test(v.replace(/,/g, '')))) return 'number';
  if (vs.every((v) => BOOL_RE.test(v))) return 'checkbox';
  if (vs.every((v) => DATE_RE.test(v))) return 'date';
  return vs.some((v) => v.length > 80 || v.includes('\n')) ? 'textarea' : 'text';
}

// The whole read: { ok, encoding, header, rows, types, truncated }.
function readCsvFile(filePath) {
  const st = fs.statSync(filePath);
  if (st.size > MAX_BYTES) return { ok: false, code: 'too_large' };
  const { text, encoding } = decodeCsvBuffer(fs.readFileSync(filePath));
  const { rows } = parseCsv(text);
  if (rows.length < 2) return { ok: false, code: 'empty' };
  const width = Math.max(...rows.map((r) => r.length));
  const header = Array.from({ length: width }, (_, i) => String(rows[0][i] ?? '').trim() || `#${i + 1}`);
  const body = rows.slice(1, MAX_ROWS + 1).map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''));
  const types = header.map((_, i) => (i === 0 ? 'name' : guessColumnType(body.map((r) => r[i]))));
  return { ok: true, encoding, header, rows: body, types, truncated: rows.length - 1 > MAX_ROWS };
}

module.exports = { decodeCsvBuffer, parseCsv, guessColumnType, readCsvFile };
