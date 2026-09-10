'use strict';
// HTML sanitizer for the one place in the app that renders STORED raw HTML
// rather than escaped text: the Author module's rich-text chapter body
// (mod/author.js). Everything else builds markup from x()-escaped values or
// goes through markdown.js, which escapes on the way in.
//
// Why this exists: Author treats any chapter_content starting with `<` as
// real HTML and assigns it straight to innerHTML, then saves innerHTML back.
// That content is not necessarily something the local user typed — it also
// arrives from an imported .db (src/db/import-merge.js) and from a pulled
// sync vault (src/db/sync.js). Without a filter that made it the only XSS
// sink in the app that fires with no click, and a payload persisted across
// the load/save round-trip.
//
// No external library: the app runs offline with no bundler, so this uses
// DOMParser, which parses into an inert document — no network fetches, no
// script execution, no side effects from the parse itself.

// Tags the Author editor can actually produce (document.execCommand output)
// plus what mdRender emits, since both feed the same view.
const SANITIZE_ALLOWED_TAGS = new Set([
  'P', 'BR', 'DIV', 'SPAN', 'HR',
  'STRONG', 'B', 'EM', 'I', 'U', 'S', 'STRIKE', 'DEL', 'MARK', 'SUB', 'SUP', 'SMALL',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE',
  'A', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'CAPTION',
]);

// Dropped along with their contents. Everything NOT in ALLOWED but also not
// here is unwrapped instead (its text is kept) — but for these, the text IS
// the payload, so it must go too.
const SANITIZE_DROP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'APPLET',
  'LINK', 'META', 'BASE', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'OPTION', 'TEXTAREA',
  'SVG', 'MATH', 'TEMPLATE', 'NOSCRIPT', 'AUDIO', 'VIDEO', 'SOURCE', 'TRACK',
  'CANVAS', 'PORTAL', 'WEBVIEW',
]);

const SANITIZE_ALLOWED_ATTRS = new Set(['class', 'colspan', 'rowspan', 'align', 'title']);

// `style` is deliberately NOT allowed: it is an injection surface of its own
// (url(), and historically expression()), and the Author toolbar's alignment
// commands are covered by the `align` attribute above.

function sanitizeUrlAttr(value) {
  // Relative URLs resolve against the file:// document, so only absolute
  // http(s) survives. This is what blocks javascript: / data: / vbscript:,
  // including whitespace- and entity-obfuscated spellings, because the URL
  // parser normalises before we look at the protocol.
  try {
    const u = new URL(String(value), document.baseURI);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
  } catch (_) { return null; }
}

function sanitizeElement(el) {
  for (const attr of [...el.attributes]) {
    const name = attr.name.toLowerCase();
    if (name === 'href' && el.tagName === 'A') {
      const safe = sanitizeUrlAttr(attr.value);
      if (safe) { el.setAttribute('href', safe); continue; }
      el.removeAttribute(attr.name);
      continue;
    }
    // Covers every on* handler in one rule rather than an allowlist of known
    // event names — new events get added to the platform, this doesn't need
    // updating for them.
    if (!SANITIZE_ALLOWED_ATTRS.has(name)) el.removeAttribute(attr.name);
  }
  // A link that survived sanitising still must not navigate this window; the
  // app has no in-page browser. Matches how markdown.js renders md-link.
  if (el.tagName === 'A' && el.hasAttribute('href')) {
    el.setAttribute('target', '_blank');
    el.setAttribute('rel', 'noopener noreferrer');
  }
}

// Returns a sanitized HTML string. Input that is already safe comes back
// essentially unchanged, so this is safe to run on every render.
function sanitizeHtml(html) {
  const src = String(html ?? '');
  if (!src) return '';
  const doc = new DOMParser().parseFromString(`<body>${src}</body>`, 'text/html');

  // Walk a static list rather than the live tree: unwrapping mutates
  // childNodes mid-iteration, and a TreeWalker over a mutating tree skips
  // nodes. Deepest-first so an unwrapped parent cannot re-expose a child
  // that was already cleaned.
  const all = [...doc.body.querySelectorAll('*')].reverse();
  for (const el of all) {
    // HTML elements report an uppercase tagName, but SVG/MathML are foreign
    // content and report their literal case — `<svg><script>` is tagName
    // 'script', not 'SCRIPT'. Normalising here is what makes those hit the
    // drop-set instead of falling through to the unwrap branch below.
    const tag = el.tagName.toUpperCase();
    if (SANITIZE_DROP_TAGS.has(tag)) { el.remove(); continue; }
    if (!SANITIZE_ALLOWED_TAGS.has(tag)) {
      // Unknown-but-harmless wrapper (or a custom element): keep the text,
      // drop the element itself.
      el.replaceWith(...el.childNodes);
      continue;
    }
    sanitizeElement(el);
  }
  return doc.body.innerHTML;
}
