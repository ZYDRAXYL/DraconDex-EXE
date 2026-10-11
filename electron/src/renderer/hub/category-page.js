'use strict';
// ═══ Categories (Procress 16 part 5, the Fandom / Wikipedia kind) ═══════
// Every label (#tag) is a category: a page in the builder — `category:<name>`
// beside `folder:` — listing the pages that carry it, its subcategories (a
// label named "place/city" sits under "place") and its parent. The empty
// name is the index of every top-level category. The Labels rail button
// opens the index; a label chip on a page opens its category; the
// core.categories block (page/components/wiki-more.js) puts a page's
// categories at its foot.

let _catIndex = null; // { nx, rows: [{moduleId, tag}], tags: [{tag_name, color_code}] }

async function loadCategoryIndex() {
  if (!S.nexus) return;
  const nx = S.nexus.id;
  const [rows, tags] = await Promise.all([api.module.tagIndex(nx), api.hashtag.getAll()]);
  _catIndex = { nx, rows: rows || [], tags: tags || [] };
}

function openCategoryPage(name = '') {
  S.categoryPage = String(name);
  S.activeModuleNode = null; S.activeItemNode = null; S.filePreview = null; S.sageHut = null; S.folderPage = null;
  if (typeof builderNavigate === 'function') builderNavigate({ kind: 'category', name: S.categoryPage });
  loadCategoryIndex().then(() => renderNexusHome()).catch(() => {});
  renderNexusHome();
}

// a label's members and its children, case-insensitive like the labels themselves
function categoryOf(name) {
  const n = name.toLowerCase();
  const all = [...new Set(_catIndex.tags.map((tg) => tg.tag_name))];
  const members = _catIndex.rows.filter((r) => r.tag.toLowerCase() === n).map((r) => findModuleNode(r.moduleId)).filter(Boolean);
  const under = (tag) => _catIndex.rows.filter((r) => r.tag.toLowerCase() === tag.toLowerCase() || r.tag.toLowerCase().startsWith(`${tag.toLowerCase()}/`)).length;
  const subs = all.filter((tg) => (n ? tg.toLowerCase().startsWith(`${n}/`) && !tg.slice(n.length + 1).includes('/') : !tg.includes('/')));
  return { members, subs: subs.map((tg) => ({ name: tg, count: under(tg) })).sort((a, b) => a.name.localeCompare(b.name)) };
}

const categoryLinkHtml = (name, count = null) => `<a class="pc-cat" role="link" tabindex="0" onclick="openCategoryPage(${xj(name)})"
  onkeydown="if(event.key==='Enter'){openCategoryPage(${xj(name)})}" data-no-i18n>#${x(name)}${count != null ? ` <span class="cnt">${count}</span>` : ''}</a>`;

function buildCategoryPageHtml() {
  const name = S.categoryPage || '';
  if (!_catIndex || _catIndex.nx !== S.nexus?.id) { loadCategoryIndex().then(() => renderNexusHome()).catch(() => {}); return '<div class="pb-loading"></div>'; }
  const { members, subs } = categoryOf(name);
  const parent = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : null;
  const title = name ? `#${name}` : t('catTitle');
  const head = pageHeadHtml({ color: 'var(--accent)', icon: I.hashtag, title: `<span data-no-i18n>${x(title)}</span>`, titleText: title,
    addr: { label: title }, acts: `<button class="btn btn-s btn-sm" onclick="loadModule('src/renderer/hashtag.js').then(() => openHashtagModal())">${I.plus} ${t('hashtag')}</button>` });
  // Procress 21: both lists are the shared list (core/list.js). Labels sort
  // by how much they hold, then by name; the pages take a filter and a sort.
  const row = (m) => listRowHtml({ icon: moduleIconHtml(m), title: m.name, meta: kindLabel(m.kind), cls: 'cat-member wikilink',
    attrs: `data-key="module_${m.id}" data-no-i18n` });
  if (!name && !subs.length) return `<div class="module-page cat-page">${head}${emptyStateHtml({ icon: I.hashtag, text: t('catEmpty') })}</div>`;
  const subRow = (c) => listRowHtml({ icon: I.hashtag, title: `#${c.name}`, count: c.count, onclick: `openCategoryPage(${xj(c.name)})`, attrs: 'data-no-i18n' });
  const subsBody = () => { const v = listView('cat-subs', [...subs].sort((p2, q2) => q2.count - p2.count || p2.name.localeCompare(q2.name)), { name: (c) => c.name });
    return v.length ? v.map(subRow).join('') : emptyStateHtml({ icon: I.search, text: t('listNoMatch') }); };
  const memBody = () => { const v = listView('cat-members', [...members].sort((p2, q2) => p2.name.localeCompare(q2.name)), { name: (m) => m.name, kind: (m) => kindLabel(m.kind) });
    return v.length ? listRowsHtml('cat-members', v, row) : emptyStateHtml({ icon: I.search, text: t('listNoMatch') }); };
  listRegister('cat-subs', subsBody); listRegister('cat-members', memBody, { sort: 'name' });
  const subsHtml = subsBody(), memHtml = memBody();
  return `<div class="module-page cat-page">${head}
    ${parent != null ? `<p class="cat-up">${categoryLinkHtml(parent)} ›</p>` : ''}
    ${subs.length ? `<section class="cat-sec"><h3>${name ? t('catSub') : t('catTitle')}</h3>${listHtml({ list: 'cat-subs', aria: name ? t('catSub') : t('catTitle'),
      head: subs.length > 8 ? listHeadHtml({ list: 'cat-subs', count: listState('cat-subs').shownCount }) : '', body: subsHtml })}</section>` : ''}
    ${name ? `<section class="cat-sec"><h3>${t('catPages')}</h3>
      ${members.length ? listHtml({ list: 'cat-members', aria: t('catPages'), body: memHtml,
        head: listHeadHtml({ list: 'cat-members', count: listState('cat-members').shownCount, sorts: ['name', 'kind'] }) })
        : emptyStateHtml({ icon: I.hashtag, text: t('catNone') })}</section>` : ''}
  </div>`;
}
