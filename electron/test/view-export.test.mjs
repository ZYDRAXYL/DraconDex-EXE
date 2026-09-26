// Procress 14 (APP docs/EXPORT-DECOR.md E6) — a view as a picture. The SVG
// the renderer made from page content is checked before it becomes a file
// a browser would run: no script, no foreignObject, no handler, no outside
// reference; a PNG must be one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sanitizeSvg, pngBytes } = require('../src/db/view-export.js');

test('an SVG keeps its drawing and loses anything that runs or reaches out', () => {
  const svg = sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><defs><marker id="a"/></defs>
<script>alert(2)</script><foreignObject><div>x</div></foreignObject>
<path d="M0 0L9 9" marker-end="url(#a)" style="stroke:red;fill:url(https://evil/x)"/>
<a href="https://evil"><text onclick="x()">Arin</text></a><use href="#a"/><image href="data:image/png;base64,iVBORw0KGgo="/><image xlink:href="file:///etc/passwd"/></svg>`);
  assert.ok(svg);
  assert.ok(!/onload|onclick|<script|foreignObject|evil|file:/.test(svg), svg);
  assert.match(svg, /marker-end="url\(#a\)"/);
  assert.match(svg, /<use href="#a"\/>/);
  assert.match(svg, /href="data:image\/png;base64,/);
  assert.match(svg, />Arin<\/text>/);
  assert.equal(sanitizeSvg('<html><svg/></html>'), null, 'not an SVG document');
  assert.equal(sanitizeSvg('<svg><a href="javascript:alert(1)">x</a></svg>').includes('javascript'), false);
});

test('a PNG is checked by its signature', () => {
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(8)]);
  assert.deepEqual(pngBytes(`data:image/png;base64,${png.toString('base64')}`), png);
  assert.equal(pngBytes(Buffer.from('GIF89a....').toString('base64')), null);
  assert.equal(pngBytes(''), null);
});
