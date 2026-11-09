// core/typing-cursor.js: the pointer hides while typing into an editable spot
// and comes back on a real mouse move. Pure logic here; the classes on a fake
// document are what css/base.css acts on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/renderer/core/typing-cursor.js', import.meta.url), 'utf8');

function fakeDoc() {
  const classes = new Set();
  const handlers = {};
  return {
    classes, handlers,
    documentElement: { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } },
    addEventListener: (type, fn) => { handlers[type] = fn; },
  };
}
const win = { addEventListener: (type, fn) => { win[`on${type}`] = fn; } };
const C = vm.runInContext(`${src}\n;({ isTypingKey, isEditable, movedFrom, bindHideCursorWhileTyping, TYPING_CLASS })`, vm.createContext({ window: win, document: {} }));

const textarea = { tagName: 'TEXTAREA' };
const input = (type = 'text', more = {}) => ({ tagName: 'INPUT', type, ...more });
const editor = { tagName: 'DIV', isContentEditable: true };
const button = { tagName: 'BUTTON' };

test('typing keys into editable fields count', () => {
  for (const key of ['a', 'ก', ' ', 'Backspace', 'Delete', 'Enter', 'Process']) assert.equal(C.isTypingKey({ key }, textarea), true, key);
  assert.equal(C.isTypingKey({ key: 'x' }, input()), true);
  assert.equal(C.isTypingKey({ key: 'x' }, input('search')), true);
  assert.equal(C.isTypingKey({ key: 'x' }, editor), true);
});

test('shortcuts, navigation and non-text targets do not hide the pointer', () => {
  assert.equal(C.isTypingKey({ key: 'p', ctrlKey: true }, textarea), false, 'Ctrl+P');
  assert.equal(C.isTypingKey({ key: 'a', altKey: true }, textarea), false);
  for (const key of ['ArrowLeft', 'Tab', 'Shift', 'Escape', 'F2', 'PageDown']) assert.equal(C.isTypingKey({ key }, textarea), false, key);
  assert.equal(C.isTypingKey({ key: 'a' }, button), false);
  assert.equal(C.isTypingKey({ key: 'a' }, input('checkbox')), false);
  assert.equal(C.isTypingKey({ key: 'a' }, input('text', { readOnly: true })), false);
  assert.equal(C.isTypingKey({ key: 'a' }, { tagName: 'TEXTAREA', disabled: true }), false);
  assert.equal(C.isTypingKey({ key: 'a' }, null), false);
});

test('hidden on typing, shown again only when the mouse really moves', () => {
  const doc = fakeDoc();
  C.bindHideCursorWhileTyping(doc);
  const hidden = () => doc.classes.has(C.TYPING_CLASS);
  doc.handlers.keydown({ key: 'h', target: textarea });
  assert.equal(hidden(), true);
  doc.handlers.mousemove({ screenX: 10, screenY: 10 }); // the window's first mousemove: only where the pointer is
  assert.equal(hidden(), true, 'the first mousemove of a window is not a move');
  doc.handlers.mousemove({ screenX: 10, screenY: 10 }); // a reflow under a still pointer
  assert.equal(hidden(), true, 'a mousemove without movement keeps it hidden');
  doc.handlers.mousemove({ screenX: 12, screenY: 10 });
  assert.equal(hidden(), false);
  doc.handlers.keydown({ key: 'p', ctrlKey: true, target: textarea });
  assert.equal(hidden(), false, 'a shortcut does not hide it');
  doc.handlers.keydown({ key: 'i', target: textarea });
  doc.handlers.mousedown();
  assert.equal(hidden(), false, 'a click shows it');
  doc.handlers.keydown({ key: 'i', target: textarea });
  win.onblur();
  assert.equal(hidden(), false, 'switching windows shows it');
});
