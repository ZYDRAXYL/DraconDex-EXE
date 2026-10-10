// Procress 17 — the measuring script behind Plan.md's "ตัวเลขที่วัดได้" table.
// Builds the stress vault the table was measured on (520 modules + a
// Classifier with 3,000 objects / 5,000 values) in the real app and prints
// each number next to its target. Re-run after every part-2/3 change: a row
// that does not move is not done (Plan.md Procress 17 "การตรวจ").
//
//   node electron/test/perf.driver.mjs
//
// A tool, not a CI test (it prints, it does not assert) — no test glob runs it.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { launchWithVault } from './ui-app.mjs';

// Procress 19 F8: i18n.js was ~45 % of the JS every window parses (1.9 MB,
// 18 languages). Now a window parses i18n.js + en.js + its own language —
// measured for the default, Thai. In this Node (same V8 as the renderer, no
// window needed): compile + run, best of 5. Each pass gets a distinct trailing
// comment, or V8's in-isolate compilation cache answers passes 2–5 and the
// number means nothing.
{
  const files = ['i18n.js', 'i18n/en.js', 'i18n/th.js'].map((f) => readFileSync(new URL(`../src/renderer/${f}`, import.meta.url), 'utf8'));
  const stub = { localStorage: { getItem: () => '{}' }, document: { write() {} } };
  let best = Infinity;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const ctx = vm.createContext({ ...stub });
    // one realm, like the page: i18n.js's top-level const/function stay visible to the language files
    for (const src of files) new vm.Script(`${src}\n// pass ${i}`).runInContext(ctx);
    best = Math.min(best, performance.now() - t0);
  }
  const mb = files.reduce((n, s) => n + s.length, 0) / 1e6;
  console.log(`${'i18n parse + run (i18n.js + en + th)'.padEnd(46)} ${`${Math.round(best)} ms · ${mb.toFixed(2)} MB`.padEnd(18)} (Procress 19 F8)`);
}

const ui = await launchWithVault('Perf');
const { win } = ui;
const rows = [];
const row = (what, value, target) => { rows.push({ what, value, target }); console.log(`${what.padEnd(46)} ${String(value).padEnd(18)} ${target}`); };

try {
  // per-kind open time on the sample vault (before it grows)
  const kinds = await win.evaluate(async () => {
    const out = [];
    const w = (ns) => ns.forEach((m) => { if (m.kind !== 'collector') out.push(m); w(m.children || []); });
    w(S.moduleTree);
    const res = [];
    for (const m of out) { const t0 = performance.now(); await openModuleNode(m.id); res.push([m.kind, performance.now() - t0]); }
    return res;
  });
  const drafter = kinds.find(([k]) => k === 'drafter');
  const slowest = kinds.sort((a, b) => b[1] - a[1])[0];
  row('open each kind (sample vault), slowest', `${Math.round(slowest[1])} ms (${slowest[0]})`, '< 200 ms');
  if (drafter) row('Drafter: first open in a window', `${Math.round(drafter[1])} ms`, '< 200 ms (F10)');

  // Procress 19 F9: a second window on the same vault, open → Nest drawn.
  // Measured from the window's own navigation start, so process launch is out.
  {
    const next = ui.app.waitForEvent('window');
    await win.evaluate(() => api.window.openNexus(S.nexus.id));
    const w2 = await next;
    await w2.waitForSelector('#hub-body', { timeout: 20000 });
    const t = await w2.evaluate(() => ({ dcl: performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd, ready: performance.now() }));
    await w2.close();
    row('second vault window: parsed / ready', `${Math.round(t.dcl)} / ${Math.round(t.ready)} ms`, '(F9)');
  }

  // the stress vault — built with the batch APIs (B1)
  const seed = await win.evaluate(async () => {
    const nx = S.nexus.id;
    let t0 = performance.now();
    const folders = await api.module.createMany(Array.from({ length: 20 }, (_, i) => ({ nexus_ref: nx, name: `Folder ${i}`, kind: 'collector' })));
    await api.module.createMany(Array.from({ length: 500 }, (_, i) => ({ nexus_ref: nx, parent_id: folders[i % 20], name: `Doc ${i}`, kind: 'drafter' })));
    const modules = performance.now() - t0;
    const cls = await api.module.create({ nexus_ref: nx, parent_id: null, name: 'Big category', kind: 'classifier', cat_type: 'object' });
    const t1 = await api.classifier.createTemplate(cls, 'Age', 'text', false, false, null);
    const t2 = await api.classifier.createTemplate(cls, 'Role', 'text', false, false, null);
    t0 = performance.now();
    const ids = await api.classifier.createObjects(cls, Array.from({ length: 3000 }, (_, i) => ({ name: `Object ${i}` })));
    await api.classifier.upsertAttrs(ids.flatMap((id, i) => (i < 2000 ? [{ objectId: id, templateId: t1, value: String(i) }, { objectId: id, templateId: t2, value: 'r' }] : [{ objectId: id, templateId: t1, value: String(i) }])));
    return { cls, modules, objects: performance.now() - t0 };
  });
  row('write 520 modules (batch IPC)', `${Math.round(seed.modules)} ms`, '—');
  row('write 3,000 objects + 5,000 values (batch IPC)', `${Math.round(seed.objects)} ms`, '< 1,000 ms');

  // one write over IPC
  const perWrite = await win.evaluate(async (cls) => {
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) await api.classifier.createObject(cls, `Single ${i}`, null, null);
    return (performance.now() - t0) / 200;
  }, seed.cls);
  row('one write over IPC', `${perWrite.toFixed(2)} ms`, '(was 4.7 ms)');

  // Nest tree at 520 modules + 3,000 elements
  const nest = await win.evaluate(async () => {
    S.settings.nestShowItems = true;
    let t0 = performance.now();
    await reloadModuleTree();
    const reload = performance.now() - t0;
    const dom = document.querySelectorAll('#left-panel-inner *').length;
    t0 = performance.now();
    setNestFilter('Doc 4');
    const filter = performance.now() - t0;
    setNestFilter('');
    return { reload, dom, filter };
  });
  row('Nest: reloadModuleTree', `${Math.round(nest.reload)} ms`, '< 50 ms');
  row('Nest: elements in DOM', nest.dom, '< 1,500');
  row('Nest: one filter keystroke', `${Math.round(nest.filter)} ms`, '< 50 ms');

  // the 3,000-object Classifier, each view
  for (const view of ['table', 'listDetail', 'grid', 'relationCat']) {
    const r = await win.evaluate(async ([cls, v]) => {
      // the view lives on the page block (config.preset) — switch it the way the view bar does
      await openModuleNode(cls);
      const iid = document.querySelector('[onclick*="setClassifierView"]')?.getAttribute('onclick').match(/setClassifierView\(["']([^"']+)["']/)?.[1];
      if (iid) await setClassifierView(iid, v);
      await builderOpenPage(null);
      const t0 = performance.now();
      await openModuleNode(cls);
      await new Promise((res) => requestAnimationFrame(() => res()));
      return { ms: performance.now() - t0, dom: document.querySelectorAll('#main-inner *').length };
    }, [seed.cls, view]);
    row(`Classifier 3,000: ${view}`, `${Math.round(r.ms)} ms · ${r.dom} nodes`, '< 300 ms · < 3,000');
  }

  // Home of the big vault, and search
  const home = await win.evaluate(async () => { const t0 = performance.now(); await builderOpenPage(null); return performance.now() - t0; });
  row('Home of the big vault', `${Math.round(home)} ms`, '< 150 ms');
  const search = await win.evaluate(async () => {
    const nx = S.nexus.id;
    await api.classifier.createObject((S.moduleTree.find((m) => m.kind === 'classifier') || {}).id, 'x', null, null).catch(() => {});
    let t0 = performance.now(); await api.search.rebuild(nx); const rebuild = performance.now() - t0;
    t0 = performance.now(); await api.search.query(nx, 'Object 12'); const query = performance.now() - t0;
    return { rebuild, query };
  });
  row('search: rebuild / query', `${Math.round(search.rebuild)} / ${Math.round(search.query)} ms`, '(146 / 10 ms)');
  // Last, because it leaves 50k nodes behind that every later number would pay
  // to tear down. F10: lazyRows grows and never recycles — scroll the table to its end and
  // count what the DOM holds then.
  const scrolled = await win.evaluate(async (cls) => {
    await openModuleNode(cls);
    const iid = document.querySelector('[onclick*="setClassifierView"]')?.getAttribute('onclick').match(/setClassifierView\(["']([^"']+)["']/)?.[1];
    if (iid) await setClassifierView(iid, 'table');
    await openModuleNode(cls);
    const before = document.querySelectorAll('#main-inner *').length;
    const frame = () => new Promise((res) => requestAnimationFrame(() => res()));
    const t0 = performance.now();
    let worst = 0;
    for (let i = 0; i < 200 && document.querySelector('[data-lazy]'); i++) {
      const s = performance.now();
      document.querySelector('[data-lazy]').scrollIntoView();
      await frame(); await frame();
      worst = Math.max(worst, performance.now() - s);
    }
    return { ms: performance.now() - t0, worst, before, dom: document.querySelectorAll('#main-inner *').length };
  }, seed.cls);
  row('Classifier 3,000: table scrolled to the end', `${scrolled.before} → ${scrolled.dom} nodes · ${Math.round(scrolled.ms)} ms`, '< 3,000 nodes (F10)');
  row('  worst step while scrolling', `${Math.round(scrolled.worst)} ms`, '< 32 ms');

  const mem = await ui.app.evaluate(() => process.memoryUsage().rss / 1e6);
  row('RAM main process', `${Math.round(mem)} MB`, '(237–260 MB)');
} finally {
  await ui.close();
}
