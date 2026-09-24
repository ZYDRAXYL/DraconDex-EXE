'use strict';
// ═══ Detail "Inspector" (progress.md Phase 6) ══════════════════════════
// A small note field — reuses the shared markdown editor component
// (src/renderer/mdeditor.js, the same one Scribe/Director notes use) on
// the module's `description` field. Its built-in edit/preview toggle
// (Ctrl+E) satisfies this kind's "2 views: Note · Preview" on its own, so
// no separate view switcher is needed here.

function buildDetailMainHtml(m) {
  return `<div id="detail-editor" class="scribe-editor" style="height:calc(100vh - 220px)"></div>`;
}

function mountDetailEditor(m) {
  const el = q('#detail-editor');
  if (!el) return;
  createMarkdownEditor(el, {
    title: m.name,
    content: m.description || '',
    srcKey: `module_${m.id}`,
    save: async (content) => {
      await api.module.updateDescription(m.id, content);
      const node = findModuleNode(m.id);
      if (node) node.description = content;
      // The page's links follow the text: refresh Properties and Related in
      // place (page/page.js) without tearing down this editor mid-edit.
      await refreshPageProps(m.id);
    },
  });
}
