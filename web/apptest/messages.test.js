'use strict';
// Covers issue #18's inline messages, which replaced alert(): a dismissible
// error banner on the tagging screen for failed navigation, the
// located-keyword row's own validation/error line, and the manage-view
// location editor's error line. (The shared confirm/rename dialog is covered
// in keyword-management.test.js.) Loads and drives the real
// web/static/app.js (via Node's vm module against stubbed DOM/fetch).
//
// Run with: node --test web/apptest/messages.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  flushMicrotasks, click, photoResponse, startSession, loadApp,
  clickManageEditLocation, toKeywordObjs,
} = require('./testutil');

test('a failed Apply shows its error in the tagging screen banner', async () => {
  const { elements, fetchMock } = await startSession();

  click(elements['apply-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/photo/apply', { error: 'dateTime is required' }, { ok: false });
  await flushMicrotasks();

  assert.equal(elements['tag-error'].hidden, false);
  assert.equal(elements['tag-error-message'].textContent, 'Could not apply: dateTime is required');
});

test('the banner can be dismissed, and the next successful navigation clears it', async () => {
  const { elements, fetchMock } = await startSession();
  const failSkip = async () => {
    click(elements['skip-button']);
    await flushMicrotasks();
    fetchMock.resolveMatching('/api/photo/skip', { error: 'boom' }, { ok: false });
    await flushMicrotasks();
  };

  await failSkip();
  click(elements['tag-error-dismiss']);
  assert.equal(elements['tag-error'].hidden, true);

  await failSkip();
  click(elements['skip-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/photo/skip', photoResponse(1));
  await flushMicrotasks();
  assert.equal(elements['tag-error'].hidden, true);
});

test('a failed save of a located keyword shows the error on its row; a later success clears it', async () => {
  const { elements, fetchMock, created } = await startSession();
  created.maps[0]._simulateClick(43.19, 6.47);
  fetchMock.resolveMatching('/api/elevation', { ok: true, alt: 65 });
  await flushMicrotasks();

  elements['located-keyword-name-input'].value = 'Pachacaid';
  click(elements['save-located-keyword-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords/location', { error: 'disk full' }, { ok: false });
  await flushMicrotasks();
  assert.equal(elements['located-keyword-error'].hidden, false);
  assert.match(elements['located-keyword-error'].textContent, /disk full/);
  assert.equal(elements['located-keyword-name-input'].value, 'Pachacaid', 'the typed name survives a failure');

  click(elements['save-located-keyword-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords/location', toKeywordObjs([{ name: 'Pachacaid', location: { lat: 43.19, lon: 6.47, alt: 65 } }]));
  await flushMicrotasks();
  assert.equal(elements['located-keyword-error'].hidden, true);
});

test('moving to the next photo clears the located-keyword row\'s message', async () => {
  const { elements, fetchMock } = await startSession();
  click(elements['save-located-keyword-button']); // no pin yet
  await flushMicrotasks();
  assert.equal(elements['located-keyword-error'].hidden, false);

  click(elements['skip-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/photo/skip', photoResponse(1));
  await flushMicrotasks();
  assert.equal(elements['located-keyword-error'].hidden, true);
});

test('cancelling and reopening the located-keyword row clears its message', async () => {
  const { elements } = await startSession();
  elements['save-located-keyword-row'].hidden = true;
  click(elements['save-located-keyword-toggle']);
  click(elements['save-located-keyword-button']); // no pin yet
  await flushMicrotasks();

  click(elements['save-located-keyword-cancel']);
  click(elements['save-located-keyword-toggle']);
  assert.equal(elements['located-keyword-error'].hidden, true);
});

async function openEditor(keywords, kw) {
  const app = loadApp();
  click(app.elements['manage-keywords-start-button']);
  await flushMicrotasks();
  app.fetchMock.resolveMatching('/api/keywords', toKeywordObjs(keywords));
  await flushMicrotasks();
  clickManageEditLocation(app.elements, kw);
  return app;
}

const CONCERT = { name: 'concert', location: { lat: 40.7128, lon: -74.006, alt: 10 } };

test('a failed Save or Clear in the location editor shows the error there and keeps it open', async () => {
  const { elements, fetchMock } = await openEditor([CONCERT], 'concert');

  click(elements['manage-location-save-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords/location', { error: 'disk full' }, { ok: false });
  await flushMicrotasks();
  assert.equal(elements['manage-location-editor'].open, true);
  assert.match(elements['manage-location-error'].textContent, /disk full/);

  click(elements['manage-location-clear-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords/location', { error: 'locked' }, { ok: false });
  await flushMicrotasks();
  assert.equal(elements['manage-location-editor'].open, true);
  assert.match(elements['manage-location-error'].textContent, /locked/);
});

test('reopening the location editor starts without the previous error', async () => {
  const { elements } = await openEditor(['beach'], 'beach');
  click(elements['manage-location-save-button']); // no pin
  await flushMicrotasks();
  assert.equal(elements['manage-location-error'].hidden, false);

  click(elements['manage-location-cancel-button']);
  clickManageEditLocation(elements, 'beach');
  assert.equal(elements['manage-location-error'].hidden, true);
});
