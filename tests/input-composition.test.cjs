const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');

// Load the actual handler without bootstrapping the chat UI and its DOM imports.
const source = readFileSync('client/js/ui.js', 'utf8');
const handler = source.slice(source.indexOf('export function preventSpaceInput('), source.indexOf('// Login form submit handler')).replace('export ', '');
const setup = runInNewContext(`${handler}\npreventSpaceInput`);
function field() {
  const listeners = {};
  let value = '';
  const input = {
    writes: 0, selectionStart: 0, selectionEnd: 0, selectionDirection: 'none',
    get value() { return value; },
    set value(next) { value = next; this.writes++; },
    addEventListener(type, fn) { listeners[type] = fn; },
    setSelectionRange(start, end, direction) { Object.assign(this, { selectionStart: start, selectionEnd: end, selectionDirection: direction }); },
    type(text, caret = text.length) { value = text; this.setSelectionRange(caret, caret, 'none'); },
    fire(type, properties = {}) {
      const event = { prevented: false, preventDefault() { this.prevented = true; }, ...properties };
      listeners[type](event);
      return event;
    },
  };
  setup(input);
  return input;
}
test('Chinese composition keeps preedit untouched and allows candidate selection', () => {
  const input = field();
  input.fire('compositionstart');
  for (const text of ['n', 'ni ', 'ni hao']) {
    input.type(text);
    input.fire('input'); // Also cover browsers without isComposing.
    assert.equal(input.value, text);
    assert.equal(input.writes, 0);
  }
  assert.equal(input.fire('keydown', { key: ' ' }).prevented, false);
  input.type('你好');
  input.fire('compositionend');
  input.fire('input', { isComposing: false });
  assert.equal(input.value, '你好');
  assert.equal(input.writes, 0);
});
test('isComposing and legacy IME key events are respected', () => {
  const input = field();
  input.type('ni ');
  input.fire('input', { isComposing: true });
  assert.equal(input.writes, 0);
  assert.equal(input.fire('keydown', { key: ' ', isComposing: true }).prevented, false);
  assert.equal(input.fire('keydown', { key: ' ', keyCode: 229 }).prevented, false);
});
test('committed input is cleaned once with selection preserved', () => {
  const input = field();
  input.fire('compositionstart');
  input.type('你 好！朋友', 4);
  input.fire('input', { isComposing: true });
  input.fire('compositionend');
  input.fire('input');
  assert.equal(input.value, '你好朋友');
  assert.equal(input.selectionStart, 2);
  assert.equal(input.writes, 1);
});
test('paste filtering and apostrophes retain existing behavior', () => {
  const input = field();
  input.type("a b!🙂c'd");
  input.fire('input');
  assert.equal(input.value, "abc'd");
  assert.equal(input.fire('keydown', { key: ' ' }).prevented, true);
  assert.equal(input.fire('keydown', { key: "'" }).prevented, false);
});
