'use strict';
// ═══ A view as a picture (Procress 14, APP docs/EXPORT-DECOR.md E6) ════
// The renderer draws the open view into a file's worth of SVG (graphs,
// timelines, boards — vector, editable in Inkscape, Figma, Illustrator) or
// PNG (Konva maps and scenes, the Sketcher canvas). Here it is checked
// before it is written: the SVG is markup the renderer produced from page
// content, and an .svg opened in a browser runs its scripts. So: no
// <script>, no <foreignObject>, no on* handlers, no reference that is not
// inside the file itself (#id) or a data: image.

const MAX_SVG = 30 * 1024 * 1024;
const MAX_PNG = 60 * 1024 * 1024;

function sanitizeSvg(svg) {
  let s = String(svg ?? '');
  if (!/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(s) || s.length > MAX_SVG) return null;
  s = s.replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '').replace(/<script\b[^>]*\/>/gi, '')
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, '').replace(/<foreignObject\b[^>]*\/>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(xlink:href|href)\s*=\s*("([^"]*)"|'([^']*)')/gi, (all, _a, _v, d, q) => {
      const v = (d ?? q ?? '').trim();
      return v.startsWith('#') || /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]*$/i.test(v) ? all : '';
    })
    .replace(/url\(\s*(['"]?)(?!#)[^)]*\1\s*\)/gi, 'none');
  return /<script|javascript:/i.test(s) ? null : s;
}

// A PNG the canvas made: its signature, and under the cap.
function pngBytes(base64) {
  const buf = Buffer.from(String(base64 || '').replace(/^data:image\/png;base64,/, ''), 'base64');
  if (buf.length < 8 || buf.length > MAX_PNG || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  return buf;
}

module.exports = { sanitizeSvg, pngBytes };
