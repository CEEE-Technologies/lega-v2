const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');

function boot({ preference, path = '/', blocked = false, body = true } = {}) {
  const classes = () => {
    const values = new Set();
    return {
      add: (name) => values.add(name),
      remove: (name) => values.delete(name),
      contains: (name) => values.has(name),
      toggle: (name, on) => (on ? values.add(name) : values.delete(name)),
    };
  };
  const document = {
    documentElement: { classList: classes() },
    body: body ? { classList: classes() } : null,
  };
  let stored = preference;
  const localStorage = {
    getItem: () => {
      if (blocked) throw new Error('blocked');
      return stored;
    },
    setItem: (_, value) => {
      if (blocked) throw new Error('blocked');
      stored = value;
    },
  };
  const window = {
    location: { pathname: path },
    matchMedia: () => ({ matches: true }),
  };
  const context = { window, document, localStorage };
  vm.runInNewContext(
    readFileSync(resolve(__dirname, '../public/preload-theme.js'), 'utf8'),
    context,
  );
  return { window, document, stored: () => stored };
}

test('a new visitor starts light even when the OS prefers dark', () => {
  const { document } = boot();
  assert.equal(document.documentElement.classList.contains('bp4-dark'), false);
  assert.equal(document.body.classList.contains('bp4-dark'), false);
});

test('an invalid saved preference falls back to light', () => {
  const { document } = boot({ preference: 'system' });
  assert.equal(document.documentElement.classList.contains('bp4-dark'), false);
});

test('a saved dark preference applies to both html and body', () => {
  const { document } = boot({ preference: 'dark' });
  assert.equal(document.documentElement.classList.contains('bp4-dark'), true);
  assert.equal(document.body.classList.contains('bp4-dark'), true);
});

test('changing themes persists the choice and clears both dark classes', () => {
  const { window, document, stored } = boot({ preference: 'dark' });
  window.legaTheme.set('light');
  assert.equal(stored(), 'light');
  assert.equal(document.documentElement.classList.contains('bp4-dark'), false);
  assert.equal(document.body.classList.contains('bp4-dark'), false);
  window.legaTheme.set('dark');
  assert.equal(stored(), 'dark');
  assert.equal(document.body.classList.contains('bp4-dark'), true);
});

test('payment routes stay light without overwriting the saved dark choice', () => {
  const { window, document, stored } = boot({
    preference: 'dark',
    path: '/payment/invoice-id',
  });
  assert.equal(document.body.classList.contains('bp4-dark'), false);
  assert.equal(stored(), 'dark');
  window.location.pathname = '/';
  window.legaTheme.apply();
  assert.equal(document.body.classList.contains('bp4-dark'), true);
});

test('blocked storage does not prevent boot or in-session theme switching', () => {
  const { window, document } = boot({ blocked: true });
  window.legaTheme.set('dark');
  assert.equal(document.body.classList.contains('bp4-dark'), true);
});

test('early head bootstrap supports a body that has not been parsed yet', () => {
  const { window, document } = boot({ preference: 'dark', body: false });
  assert.equal(document.documentElement.classList.contains('bp4-dark'), true);
  document.body = {
    classList: { toggle: (_, dark) => assert.equal(dark, true) },
  };
  window.legaTheme.apply();
});
