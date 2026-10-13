// Procress 20 part 1 — what a Locate sync costs on the stress vault (520
// modules + a Classifier with 3,000 objects, the same vault perf.driver.mjs
// builds through the batch APIs). Prints each number next to its target.
//
//   xvfb-run -a node electron/test/locate-perf.driver.mjs
//
// A tool, not a CI test (it prints, it does not assert) — no test glob runs it.
// "written" counts module files (.ddata/.dpage); "+ manifest" when the
// folder's .dracondex-mirror.json was rewritten too.
import { launchWithVault } from './ui-app.mjs';

const ui = await launchWithVault('LocatePerf');
const { win } = ui;
const row = (what, value, target) => console.log(`${what.padEnd(44)} ${String(value).padEnd(30)} ${target}`);
const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const files = (r) => `${r.written ?? 0} written${r.manifestWritten ? ' + manifest' : ''}`;

try {
  const seed = await win.evaluate(async () => {
    const nx = S.nexus.id;
    const folders = await api.module.createMany(Array.from({ length: 20 }, (_, i) => ({ nexus_ref: nx, name: `Folder ${i}`, kind: 'collector' })));
    const docs = await api.module.createMany(Array.from({ length: 500 }, (_, i) => ({ nexus_ref: nx, parent_id: folders[i % 20], name: `Doc ${i}`, kind: 'drafter' })));
    const cls = await api.module.create({ nexus_ref: nx, parent_id: null, name: 'Big category', kind: 'classifier', cat_type: 'object' });
    const t1 = await api.classifier.createTemplate(cls, 'Age', 'text', false, false, null);
    const ids = await api.classifier.createObjects(cls, Array.from({ length: 3000 }, (_, i) => ({ name: `Object ${i}` })));
    await api.classifier.upsertAttrs(ids.map((id, i) => ({ objectId: id, templateId: t1, value: String(i) })));
    return { nx, doc: docs[7] };
  });
  await win.waitForTimeout(2600); // let main's own after-write mirror (2 s debounce) run first

  // what the Nexus opening runs: walk the folder, check every module
  const first = await win.evaluate(async (nx) => {
    const t0 = performance.now();
    const r = await api.nexus.locateSync(nx, { reason: 'open' });
    return { ms: performance.now() - t0, r, dir: (await api.nexus.get(nx)).locate_dir };
  }, seed.nx);
  row('open sync (520 modules, full check)', `${Math.round(first.ms)} ms · ${files(first.r)}`, '(background, after first paint)');

  const still = await win.evaluate(async (nx) => {
    const out = [];
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      const r = await api.nexus.locateSync(nx, { reason: 'tree' });
      out.push({ ms: performance.now() - t0, r });
    }
    return out;
  }, seed.nx);
  row('sync with nothing changed (median of 7)', `${median(still.map((s) => s.ms)).toFixed(1)} ms · ${Math.max(...still.map((s) => s.r.written ?? 0))} written${still.some((s) => s.r.manifestWritten) ? ' + manifest' : ''}`, '< 20 ms · 0 written');

  const edit = await win.evaluate(async ([nx, id]) => {
    await api.module.updateDescription(id, `edited ${Date.now()}`);
    const t0 = performance.now();
    const r = await api.nexus.locateSync(nx, { reason: 'tree' });
    return { ms: performance.now() - t0, r };
  }, [seed.nx, seed.doc]);
  row('sync after one module edit', `${Math.round(edit.ms)} ms · ${files(edit.r)} · ${edit.r.serialized} serialized`, '≤ 2 files');

  // What the window's focus listener runs (core/nexus-locate.js).
  const focus = await win.evaluate(async (nx) => {
    const out = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      await api.nexus.locateSync(nx, { reason: 'focus' });
      out.push(performance.now() - t0);
    }
    return out;
  }, seed.nx);
  row('window focus (median of 5)', `${median(focus).toFixed(1)} ms`, '< 20 ms');

  // main's own mirror after a write: no call from the renderer at all
  const after = await win.evaluate(async ([nx, id]) => {
    await api.module.updateDescription(id, `again ${Date.now()}`);
    await new Promise((res) => setTimeout(res, 2600));
    return api.nexus.locateSync(nx, { reason: 'tree' });
  }, [seed.nx, seed.doc]);
  row('edit, then 2.6 s: left for the next sync', `${files(after)}`, '0 written (main mirrored it)');

  const rss = await ui.app.evaluate(() => process.memoryUsage().rss / 1e6);
  row('RAM main process', `${Math.round(rss)} MB`, '—');
  row('folder', first.dir, '(under the data dir in a test run)');
} finally {
  await ui.close();
}
