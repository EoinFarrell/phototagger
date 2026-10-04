'use strict';
// Covers issue #17: after Apply, a toast names the file the photo was
// renamed to, using the apply response's appliedAs. Skip, Prev and
// leaving the screen hide it. Loads and drives the real web/static/app.js (via Node's vm
// module against stubbed DOM/fetch).
//
// Run with: node --test web/apptest/toast.test.js

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { flushMicrotasks, click, photoResponse, startSession } = require('./testutil');

async function apply(app, response) {
  click(app.elements['apply-button']);
  await flushMicrotasks();
  app.fetchMock.resolveMatching('/api/photo/apply', response);
  await flushMicrotasks();
}

test('Apply shows a toast with the new filename', async () => {
  const app = await startSession();

  await apply(app, { ...photoResponse(1), appliedAs: 'sub/20250614-102100_eiffel-tower.jpg' });

  assert.equal(app.elements.toast.classList.contains('visible'), true);
  assert.equal(app.elements.toast.textContent, 'Saved as sub/20250614-102100_eiffel-tower.jpg');
});

test('the last Apply, leading to the Done screen, still shows the toast', async () => {
  const app = await startSession();

  await apply(app, { done: true, total: 3, applied: 3, appliedAs: '20250614-102100.jpg' });

  assert.equal(app.elements['done-view'].hidden, false);
  assert.equal(app.elements.toast.textContent, 'Saved as 20250614-102100.jpg');
  assert.equal(app.elements.toast.classList.contains('visible'), true);
});

for (const [action, button, url] of [['Skip', 'skip-button', '/api/photo/skip'], ['Prev', 'prev-button', '/api/photo/prev']]) {
  test(`${action} shows no toast, and hides one still showing from an earlier Apply`, async () => {
    const app = await startSession();
    await apply(app, { ...photoResponse(1), appliedAs: 'first.jpg' });

    click(app.elements[button]);
    await flushMicrotasks();
    app.fetchMock.resolveMatching(url, photoResponse(0));
    await flushMicrotasks();

    assert.equal(app.elements.toast.classList.contains('visible'), false);
  });
}

test('leaving the Done screen hides the toast', async () => {
  const app = await startSession();
  await apply(app, { done: true, total: 3, applied: 3, appliedAs: 'last.jpg' });

  click(app.elements['done-back-button']);
  await flushMicrotasks();

  assert.equal(app.elements.toast.classList.contains('visible'), false);
});

test('the toast hides itself after a few seconds, and a second Apply replaces it and restarts the clock', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const app = await startSession();

  await apply(app, { ...photoResponse(1), appliedAs: 'first.jpg' });
  mock.timers.tick(3000);
  await apply(app, { ...photoResponse(2), appliedAs: 'second.jpg' });
  assert.equal(app.elements.toast.textContent, 'Saved as second.jpg');

  mock.timers.tick(3000);
  assert.equal(app.elements.toast.classList.contains('visible'), true, 'the first toast\'s timer must not hide the second');

  mock.timers.tick(1500);
  assert.equal(app.elements.toast.classList.contains('visible'), false);
});
