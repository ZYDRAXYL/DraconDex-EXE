// Minimal self-contained markdown renderer for DraconDex (no external lib —
// the app runs offline with no bundler). Supports the Obsidian-flavored
// subset used across Scribe notes, object notes and Writer previews:
//   blocks : # h1..h6, ---, > quote, ``` fenced code, -/*/1. lists, - [ ] task
//   inline : **bold** *italic* ~~strike~~ `code` ==highlight==
//            [text](url) [[Wikilink]] [[Wikilink|alias]]
// Every piece of user text is HTML-escaped; formatting markers are applied on
// the escaped text, so no raw user HTML ever reaches innerHTML.

const _mdEsc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Canonical wikilink pattern — keep in sync with WIKILINK_RE in src/db/wiki.js.
const MD_WIKILINK_RE = /\[\[([^\[\]|]+?)(?:\|([^\[\]]+?))?\]\]/g;

// → [{name, alias, start, end}] for every [[...]] in raw text.
function mdExtractWikilinks(text) {
  const out = [];
  if (!text) return out;
  MD_WIKILINK_RE.lastIndex = 0;
  let m;
  while ((m = MD_WIKILINK_RE.exec(text)) !== null) {
    out.push({ name: m[1].trim(), alias: m[2]?.trim() || null, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

// Inline pass. Protects code spans / links / wikilinks behind \x00n\x00
// placeholders, escapes everything else, then applies the marker regexes.
function _mdInline(text, resolveLink) {
  const slots = [];
  const stash = (html) => `\x00${slots.push(html) - 1}\x00`;

  let s = String(text);
  s = s.replace(/`([^`\n]+)`/g, (_, code) => stash(`<code>${_mdEsc(code)}</code>`));
  s = s.replace(MD_WIKILINK_RE, (_, name, alias) => {
    const nm = name.trim();
    const key = resolveLink ? (resolveLink(nm) || '') : '';
    const cls = key ? 'wikilink' : 'wikilink wikilink-unresolved';
    return stash(`<a class="${cls}" data-name="${_mdEsc(nm)}" data-key="${_mdEsc(key)}">${_mdEsc(alias?.trim() || nm)}</a>`);
  });
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) =>
    stash(`<a class="md-link" href="${_mdEsc(url)}" title="${_mdEsc(url)}" onclick="return false">${_mdEsc(label)}</a>`));

  s = _mdEsc(s);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  s = s.replace(/==([^=\n]+)==/g, '<mark class="md-hl">$1</mark>');

  return s.replace(/\x00(\d+)\x00/g, (_, i) => slots[Number(i)]);
}

// Full block-level render. opts.resolveLink: (name) => entity key | null.
function mdRender(text, opts = {}) {
  const resolveLink = opts.resolveLink || null;
  const lines = String(text ?? '').split('\n');
  const out = [];
  let i = 0;

  const listItem = (line) => {
    const task = line.match(/^(\s*)[-*] \[([ xX])\] (.*)$/);
    if (task) return { indent: task[1].length, html: `<li class="md-task"><input type="checkbox" disabled ${task[2] !== ' ' ? 'checked' : ''}> ${_mdInline(task[3], resolveLink)}</li>`, ordered: false };
    const ul = line.match(/^(\s*)[-*] (.*)$/);
    if (ul) return { indent: ul[1].length, html: `<li>${_mdInline(ul[2], resolveLink)}</li>`, ordered: false };
    const ol = line.match(/^(\s*)\d+\. (.*)$/);
    if (ol) return { indent: ol[1].length, html: `<li>${_mdInline(ol[2], resolveLink)}</li>`, ordered: true };
    return null;
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {                                   // fenced code
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence (or EOF)
      out.push(`<pre><code>${_mdEsc(buf.join('\n'))}</code></pre>`);
      continue;
    }

    const h = line.match(/^(#{1,6}) (.*)$/);                   // heading
    if (h) { out.push(`<h${h[1].length}>${_mdInline(h[2], resolveLink)}</h${h[1].length}>`); i++; continue; }

    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    if (/^> ?/.test(line)) {                                   // blockquote
      const buf = [];
      while (i < lines.length && /^> ?/.test(lines[i])) buf.push(lines[i++].replace(/^> ?/, ''));
      out.push(`<blockquote>${buf.map(l => _mdInline(l, resolveLink)).join('<br>')}</blockquote>`);
      continue;
    }

    if (listItem(line)) {                                      // list (2-space nesting)
      const stack = []; // [{ordered, indentLevel}]
      let html = '';
      while (i < lines.length) {
        const it = listItem(lines[i]);
        if (!it) break;
        const level = Math.floor(it.indent / 2);
        while (stack.length - 1 > level) html += stack.pop().ordered ? '</ol>' : '</ul>';
        if (stack.length - 1 === level && stack.length && stack[stack.length - 1].ordered !== it.ordered) {
          html += stack.pop().ordered ? '</ol>' : '</ul>';
        }
        while (stack.length - 1 < level || stack.length === 0) {
          stack.push({ ordered: it.ordered });
          html += it.ordered ? '<ol>' : '<ul>';
        }
        html += it.html;
        i++;
      }
      while (stack.length) html += stack.pop().ordered ? '</ol>' : '</ul>';
      out.push(html);
      continue;
    }

    if (line.trim() === '') { i++; continue; }

    const buf = [];                                            // paragraph
    while (i < lines.length && lines[i].trim() !== '' &&
           !/^(#{1,6} |> ?|```|\s*[-*] |\s*\d+\. |\s*(---+|\*\*\*+|___+)\s*$)/.test(lines[i])) {
      buf.push(lines[i++]);
    }
    out.push(`<p>${buf.map(l => _mdInline(l, resolveLink)).join('<br>')}</p>`);
  }

  return out.join('\n');
}
