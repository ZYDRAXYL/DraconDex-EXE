'use strict';
// ═══ Tables out: CSV / XLSX (Procress 14, APP docs/EXPORT-DECOR.md E4) ═══
// A Classifier is a table already — one row per element, one column per
// field — and a Chronicler's events are one. Everything here is read from
// the vault in main; the renderer only names the module.
//
// CSV is written so that CSV import (db/csv-import.js) reads it back into
// the same Classifier: the name first, a UTF-8 BOM (Excel on Thai Windows
// otherwise reads it as windows-874), true/false for a checkbox, ISO dates.
// XLSX is the smallest SpreadsheetML Excel, Sheets and Numbers all open —
// written through zip.js, so no new dependency (EXE ships one).
const { getDB } = require('./core');
const classifier = require('./classifier');
const timeline = require('./timeline');
const { writeZip } = require('./zip');

// ── Reading ───────────────────────────────────────────────────────────
// A stored date is d-m-y (or d/m/y) with an optional h:mi. A four-digit
// year becomes ISO so import reads it as a date again; a story's own
// year 12 stays as it was — a date nothing outside the app can hold.
function isoDate(v) {
  const m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{1,6})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(String(v || '').trim());
  if (!m || m[3].length !== 4) return String(v || '');
  const p = (n) => String(n).padStart(2, '0');
  return `${m[3]}-${p(m[2])}-${p(m[1])}`;
}

function cellOf(type, raw) {
  const v = raw == null ? '' : String(raw);
  if (type === 'checkbox') return v === '1' || v === 'true' ? 'true' : v === '' ? '' : 'false';
  if (type === 'date') return isoDate(v);
  if (type === 'multi') {
    try { const a = JSON.parse(v); return Array.isArray(a) ? a.join(', ') : v; } catch (_) { return v; }
  }
  return v;
}

// → { name, columns: [{ name, type }], rows: [[…]], skipped: [field names] }
// A formula is computed by the renderer from the other fields, and import
// cannot take one back — it is left out and named, not written empty.
function classifierTable(moduleId) {
  const d = getDB();
  const mod = d.prepare(`SELECT name FROM module WHERE id=?`).get(moduleId);
  if (!mod) return null;
  const { objects, templates } = classifier.getObjectsFull(moduleId);
  const fields = templates.filter((tp) => tp.attribute_type !== 'formula');
  const relTo = d.prepare(`SELECT er.to_key FROM entity_relation er WHERE er.from_key=? AND er.rel_type=? ORDER BY er.id`);
  const names = new Map();
  const nameOf = (key) => {
    if (!names.has(key)) {
      const m = /^cobj_(\d+)$/.exec(key);
      names.set(key, m ? d.prepare(`SELECT name FROM classifier_object WHERE id=?`).get(Number(m[1]))?.name ?? key : key);
    }
    return names.get(key);
  };
  const rows = objects.map((o) => [o.name, ...fields.map((tp) => (tp.attribute_type === 'relation'
    ? relTo.all(`cobj_${o.id}`, `ctpl_${tp.id}`).map((r) => nameOf(r.to_key)).join('; ')
    : cellOf(tp.attribute_type, o.attrMap?.[tp.id])))]);
  return {
    name: mod.name,
    columns: [{ name: 'name', type: 'text' }, ...fields.map((tp) => ({ name: tp.description, type: tp.attribute_type }))],
    rows,
    skipped: templates.filter((tp) => tp.attribute_type === 'formula').map((tp) => tp.description),
  };
}

const stamp = (e, p) => {
  if (e[`${p}_years`] == null) return '';
  const two = (n) => String(n ?? 0).padStart(2, '0');
  const time = e[`${p}_hour`] || e[`${p}_minute`] ? ` ${two(e[`${p}_hour`])}:${two(e[`${p}_minute`])}` : '';
  return `${e[`${p}_years`]}.${two(e[`${p}_month`])}.${two(e[`${p}_day`])}${time}`;
};

// One table per timeline — each its own XLSX sheet. A CSV holds one table,
// so a CSV of a Chronicler is its first timeline and says how many more.
function chroniclerTables(moduleId) {
  return timeline.getModuleTimelines(moduleId).map((tl) => ({
    name: tl.line_name,
    columns: ['event', 'start', 'end', 'story', 'color'].map((name) => ({ name, type: 'text' })),
    rows: timeline.getEvents(tl.id).map((e) => [e.event_name, stamp(e, 's'), stamp(e, 'e'), e.story || '', e.color_code || '']),
    skipped: [],
  }));
}

function tablesFor(moduleId) {
  const kind = getDB().prepare(`SELECT kind FROM module WHERE id=?`).get(moduleId)?.kind;
  if (kind === 'classifier') { const tb = classifierTable(moduleId); return tb ? [tb] : []; }
  if (kind === 'chronicler') return chroniclerTables(moduleId);
  return [];
}

// ── CSV ───────────────────────────────────────────────────────────────
// RFC 4180 + CRLF + BOM. A text cell a spreadsheet would run as a formula
// (= + - @, or a leading tab/CR) gets a ' in front — OWASP's CSV-injection
// advice. A number column is exempt, or -5 would stop being a number.
const RISKY = /^[=+\-@\t\r]/;
function csvCell(v, type) {
  let s = String(v ?? '');
  if (type !== 'number' && RISKY.test(s)) s = `'${s}`;
  return /[",\r\n;]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(table) {
  const lines = [table.columns.map((c) => csvCell(c.name, 'text')).join(',')];
  for (const r of table.rows) lines.push(r.map((v, i) => csvCell(v, table.columns[i]?.type)).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

// ── XLSX ──────────────────────────────────────────────────────────────
const xml = (s) => String(s ?? '')
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const colName = (i) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

// Excel refuses a sheet name over 31 characters, with []:*?/\ in it, or a
// repeat of another sheet's (case-insensitively).
function sheetNames(tables) {
  const used = new Set();
  return tables.map((tb, i) => {
    const base = (String(tb.name || '').replace(/[[\]:*?/\\]/g, ' ').trim() || `Sheet${i + 1}`).slice(0, 31);
    let name = base;
    for (let k = 2; used.has(name.toLowerCase()); k++) name = `${base.slice(0, 31 - String(k).length - 1)} ${k}`;
    used.add(name.toLowerCase());
    return name;
  });
}

const NUM = /^-?\d+(\.\d+)?$/;
function sheetXml(table) {
  const row = (cells, r, head) => `<row r="${r}">${cells.map((v, i) => {
    const ref = `${colName(i)}${r}`;
    const s = String(v ?? '');
    if (!head && table.columns[i]?.type === 'number' && NUM.test(s)) return `<c r="${ref}"><v>${s}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${head ? ' s="1"' : ''}><is><t xml:space="preserve">${xml(s)}</t></is></c>`;
  }).join('')}</row>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetData>${row(table.columns.map((c) => c.name), 1, true)}${table.rows.map((r, i) => row(r, i + 2, false)).join('')}</sheetData>
</worksheet>`;
}

function xlsxEntries(tables) {
  const names = sheetNames(tables);
  const sheets = tables.map((_, i) => i + 1);
  return [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((n) => `<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((n) => `<sheet name="${xml(names[n - 1])}" sheetId="${n}" r:id="rId${n}"/>`).join('')}</sheets>
</workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((n) => `<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/>`).join('\n')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>` },
    { name: 'xl/styles.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>` },
    ...tables.map((tb, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(tb) })),
  ];
}

// ── The export ────────────────────────────────────────────────────────
function exportTable(moduleId, format, outPath, fs = require('fs')) {
  const tables = tablesFor(moduleId);
  if (!tables.length) return { ok: false, code: 'not_table' };
  const rows = tables.reduce((n, tb) => n + tb.rows.length, 0);
  const skipped = tables.flatMap((tb) => tb.skipped);
  if (format === 'csv') {
    fs.writeFileSync(outPath, toCsv(tables[0]), 'utf8');
    return { ok: true, rows: tables[0].rows.length, sheets: 1, more: tables.length - 1, skipped };
  }
  if (format === 'xlsx') {
    const r = writeZip(outPath, xlsxEntries(tables));
    return r.ok ? { ok: true, rows, sheets: tables.length, more: 0, skipped } : r;
  }
  return { ok: false, code: 'bad_format' };
}

module.exports = { classifierTable, chroniclerTables, tablesFor, toCsv, xlsxEntries, sheetNames, exportTable, isoDate };
