// Hide the mouse pointer while typing, the way Word or a code editor does:
// the first keystroke that types into an editable spot hides it; the next real
// mouse movement brings it back. Only keys that type — not shortcuts, arrows
// or modifiers — so Ctrl+P, Tab-to-move or selecting with Shift+arrows never
// makes the pointer vanish.
// html.typing-hide-cursor in css/base.css does the hiding.

const TYPING_CLASS = 'typing-hide-cursor';

// Does this keydown put text into an editable field?
function isTypingKey(e, target) {
  if (!e || e.ctrlKey || e.metaKey || e.altKey) return false;
  const k = e.key || '';
  const types = k.length === 1 || k === 'Backspace' || k === 'Delete' || k === 'Enter' || k === 'Process'; // 'Process' = an IME (Thai/Japanese…) composing
  if (!types) return false;
  return isEditable(target);
}

function isEditable(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA') return !el.readOnly && !el.disabled;
  if (tag !== 'INPUT') return false;
  const type = String(el.type || 'text').toLowerCase();
  return !el.readOnly && !el.disabled && !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image'].includes(type);
}

// Chromium also sends mousemove when the page scrolls or reflows under a
// pointer that has not moved (and once when a window first gets the pointer),
// which would undo the hiding at once — so only a change of screen position
// counts. The first event only sets where the pointer is; a real move sends
// many, so the pointer still comes back at once.
function movedFrom(last, e) {
  return !!last && (last.x !== e.screenX || last.y !== e.screenY);
}

function bindHideCursorWhileTyping(doc = document) {
  const root = doc.documentElement;
  let last = null;
  const show = () => root.classList.remove(TYPING_CLASS);
  doc.addEventListener('keydown', (e) => {
    if (isTypingKey(e, e.target)) root.classList.add(TYPING_CLASS);
  }, true);
  doc.addEventListener('mousemove', (e) => {
    if (movedFrom(last, e)) show();
    last = { x: e.screenX, y: e.screenY };
  }, true);
  doc.addEventListener('mousedown', show, true);
  window.addEventListener('blur', show); // never leave it hidden for another window
}
