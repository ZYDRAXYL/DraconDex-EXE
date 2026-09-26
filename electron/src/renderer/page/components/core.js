'use strict';
// ═══ Core page components (Procress 14, APP docs/TEMPLATES.md §2.1, §7.3) ══
// The ones any page may hold: an infobox of the element's fields, a callout,
// a row of numbers, the page's contents, and "see also". Each keeps to the
// page it sits on (kind 'core'); config comes from the template or the
// arrange bar.

// Infobox: the element's fields, the ones config.fields names (by key) or
// all of them — docked right / left / full, as a table or stacked.
registerFilled('core.infobox', { kind: 'core', labelKey: 'pcInfobox', once: true }, async (c) => {
  const dock = ['left', 'full'].includes(c.config.dock) ? c.config.dock : 'right';
  const layout = c.config.layout === 'stacked' ? 'stacked' : 'table';
  const oid = pcObjectId(c.itemKey);
  let rows = [];
  if (oid) {
    const [templates, attrs] = await Promise.all([api.classifier.getTemplates(c.page.moduleId), api.classifier.getAttrs(oid)]);
    const byTpl = new Map((attrs || []).map((a) => [a.template_ref, a.attribute_value]));
    const want = Array.isArray(c.config.fields) && c.config.fields.length
      ? c.config.fields.map((k) => pcFindField(templates, k)).filter(Boolean)
      : (templates || []).filter((tp) => tp.attribute_type !== 'relation');
    rows = want.map((tp) => ({ label: tp.description, value: byTpl.get(tp.id) ?? '' }));
  } else {
    rows = (c.page.props?.props || []).map((p) => ({ label: p.prop_name, value: p.content ?? '' }));
  }
  const title = c.itemKey ? (S.activeItemNode?.item?.name || '') : (c.source?.name || '');
  const body = rows.length
    ? rows.map((r) => (layout === 'table'
      ? `<div class="pc-ib-row"><span class="pc-ib-k">${x(r.label)}</span><span class="pc-ib-v">${r.value === '' ? '<span class="ghost">—</span>' : x(r.value)}</span></div>`
      : `<div class="pc-ib-stack"><div class="pc-ib-k">${x(r.label)}</div><div class="pc-ib-v">${r.value === '' ? '<span class="ghost">—</span>' : x(r.value)}</div></div>`)).join('')
    : pcEmpty(t('pcInfoboxEmpty'));
  return `<aside class="pc-infobox" data-dock="${dock}">${title ? `<div class="pc-ib-title">${x(title)}</div>` : ''}${body}</aside>`;
});

// Callout: a note in a tone, written right on the page (block.content).
const PC_TONES = ['note', 'tip', 'warning', 'quote', 'secret'];
registerComponent('core.callout', {
  kind: 'core', labelKey: 'pcCallout',
  render: (c) => {
    const tone = PC_TONES.includes(c.config.tone) ? c.config.tone : 'note';
    return `<div class="pc-callout" data-tone="${tone}">
      <div class="pc-callout-body" contenteditable="true" data-ph="${x(t('pcCalloutPh'))}"
        onblur="pcCalloutSave(${xj(c.iid)},this)">${x(c.block.content || '')}</div>
    </div>`;
  },
});
async function pcCalloutSave(iid, el) {
  const i = pbInst(iid);
  const b = i && pageOf(i.moduleId, i.itemKey)?.blocks.find((bb) => bb.id === i.blockId);
  if (!b) return;
  const text = el.innerText.trim();
  if (text === (b.content || '')) return;
  await api.block.update(b.id, { content: text });
  b.content = text;
}

// Hatnote: one italic line at the top — "Main article: …", "Not to be
// confused with …". Written right on the page, like a callout; the §7 link
// model (typed links, config.kind) replaces the free text when it lands.
registerComponent('core.hatnote', {
  kind: 'core', labelKey: 'pcHatnote', once: true,
  render: (c) => `<div class="pc-hatnote" contenteditable="true" data-ph="${x(t('pcHatnotePh'))}"
    onblur="pcCalloutSave(${xj(c.iid)},this)">${x(c.block.content || '')}</div>`,
});

// Stats: a row of numbers — an element's own fields (config.tiles: [{field}]),
// or, on a module page, how much the module holds.
registerFilled('core.stats', { kind: 'core', labelKey: 'pcStats' }, async (c) => {
  const tiles = [];
  const oid = pcObjectId(c.itemKey);
  const want = Array.isArray(c.config.tiles) ? c.config.tiles.slice(0, 6) : [];
  if (oid && want.length) {
    const [templates, attrs] = await Promise.all([api.classifier.getTemplates(c.page.moduleId), api.classifier.getAttrs(oid)]);
    const byTpl = new Map((attrs || []).map((a) => [a.template_ref, a.attribute_value]));
    for (const tile of want) {
      const tp = pcFindField(templates, tile.field);
      if (tp) tiles.push({ name: tile.label || tp.description, value: byTpl.get(tp.id) ?? '—' });
    }
  } else {
    const src = c.source;
    const items = S.nestItems?.get(src.id);
    tiles.push({ name: t('pcStatItems'), value: Array.isArray(items) ? items.length : 0 });
    const kids = findModuleNode(src.id)?.children?.length || 0;
    if (kids) tiles.push({ name: t('pcStatModules'), value: kids });
    const links = c.page.props?.links;
    if (links) tiles.push({ name: t('backlinks'), value: (links.backlinks || []).length });
  }
  if (!tiles.length) return pcEmpty(t('pcStatsEmpty'));
  return `<div class="pc-stats">${tiles.map((s) => `<div class="pc-stat"><div class="pc-stat-v">${x(String(s.value))}</div><div class="pc-stat-k">${x(s.name)}</div></div>`).join('')}</div>`;
});

// Contents: the page's own headings.
registerComponent('core.toc', {
  kind: 'core', labelKey: 'pcToc', once: true,
  render: (c) => {
    const hs = (c.page.blocks || []).filter((b) => b.block_type === 'heading' && (b.content || '').trim());
    if (!hs.length) return `<div class="pc">${pcEmpty(t('pcTocEmpty'))}</div>`;
    return `<nav class="pc pc-toc"><div class="pc-head">${t('pcToc')}</div>${hs.map((b) =>
      `<a class="pc-toc-row" onclick="document.querySelector('.pblock[data-iid$=&quot;.${b.id}&quot;]')?.scrollIntoView({behavior:'smooth',block:'start'})">${x(b.content)}</a>`).join('')}</nav>`;
  },
});

// See also: where this page links to.
registerComponent('core.seealso', {
  kind: 'core', labelKey: 'pcSeeAlso', once: true,
  render: (c) => {
    const out = (c.page.props?.links?.outgoing || []).filter((l) => l.key);
    return `<div class="pc pc-seealso"><div class="pc-head">${t('pcSeeAlso')}</div>${out.length
      ? `<ul>${out.map((l) => `<li><a ${pcOpen(l.key)}>${x(l.name)}</a></li>`).join('')}</ul>`
      : pcEmpty(t('pcSeeAlsoEmpty'))}</div>`;
  },
});
