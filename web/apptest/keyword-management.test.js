'use strict';
// Covers the standalone "Manage keywords" view: reachable from either the
// start screen or the tagging form (returning to whichever one it was
// opened from), listing every known keyword with Rename/Delete actions.
//
// Delete (internal/server/session.go's DeleteKeyword, via DELETE
// /api/keywords) moved here from the keyword pill's old inline × button --
// see keywords.test.js for what the pills themselves still cover. Rename
// (RenameKeyword, via POST /api/keywords/rename) is new: it changes a
// keyword's text everywhere, prompting for the new name rather than an
// inline editable field, matching this app's existing alert()/confirm()
// interaction style. Edit location sets or clears a keyword's saved
// Location (making it a located keyword, or a plain one again) from a small
// map of its own, via POST/DELETE /api/keywords/location.
//
// Run with: node --test web/apptest/keyword-management.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  flushMicrotasks, click, clickManageRename, clickManageDelete, clickManageEditLocation,
  toKeywordObjs, startSessionWithKeywords, loadApp,
} = require('./testutil');

test('"Manage keywords…" from the start screen fetches keywords and opens the manage view', async () => {
  const { elements, fetchMock } = loadApp();

  click(elements['manage-keywords-start-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords', toKeywordObjs(['beach', 'family']));
  await flushMicrotasks();

  assert.equal(elements['manage-view'].hidden, false);
  assert.equal(elements['start-view'].hidden, true);
  const html = elements['manage-keywords-list'].innerHTML;
  assert.match(html, /beach/);
  assert.match(html, /family/);
});

test('the back button returns to the start screen when opened from there', async () => {
  const { elements, fetchMock } = loadApp();

  click(elements['manage-keywords-start-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords', toKeywordObjs([]));
  await flushMicrotasks();

  click(elements['manage-back-button']);

  assert.equal(elements['start-view'].hidden, false);
  assert.equal(elements['manage-view'].hidden, true);
});

test('"Manage keywords…" from the tagging form opens the manage view, and the back button returns to it', async () => {
  const { elements, fetchMock } = await startSessionWithKeywords(['beach']);

  click(elements['manage-keywords-tag-button']);
  await flushMicrotasks();
  // Opening the manage view re-fetches /api/keywords for a fresh list.
  fetchMock.resolveMatching('/api/keywords', toKeywordObjs(['beach']));
  await flushMicrotasks();

  assert.equal(elements['manage-view'].hidden, false);
  assert.equal(elements['tag-view'].hidden, true);

  click(elements['manage-back-button']);

  assert.equal(elements['tag-view'].hidden, false);
  assert.equal(elements['manage-view'].hidden, true);
});

test('each known keyword renders a Rename and a Delete button', async () => {
  const { elements, fetchMock } = loadApp();

  click(elements['manage-keywords-start-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords', toKeywordObjs(['beach']));
  await flushMicrotasks();

  const html = elements['manage-keywords-list'].innerHTML;
  assert.match(html, /class="manage-keyword-rename" data-keyword="beach"/);
  assert.match(html, /class="manage-keyword-delete" data-keyword="beach"/);
});

// ---- Delete ----

test('deleting from the manage view asks for confirmation, then calls DELETE /api/keywords and drops it from the list', async () => {
  const { elements, fetchMock, confirms } = await startSessionWithKeywords(['beach', 'family'], { keywords: ['beach'] });
  assert.equal(elements['keywords-input'].value, 'beach');

  click(elements['manage-keywords-tag-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords', toKeywordObjs(['beach', 'family']));
  await flushMicrotasks();

  clickManageDelete(elements, 'beach');
  await flushMicrotasks();

  assert.equal(confirms.length, 1, 'expected a confirm() prompt before deleting');
  assert.match(confirms[0], /Delete "beach"/);

  const del = fetchMock.log.find((e) => e.method === 'DELETE' && e.url.includes('/api/keywords'));
  assert.ok(del, 'expected a DELETE /api/keywords request');
  assert.deepEqual(del.body, { keyword: 'beach' });

  fetchMock.resolveMatching('/api/keywords', toKeywordObjs(['family']));
  await flushMicrotasks();

  assert.equal(elements['keywords-input'].value, '', 'deleted keyword must be dropped from the current field too');
  assert.doesNotMatch(elements['manage-keywords-list'].innerHTML, /data-keyword="beach"/);
  assert.match(elements['manage-keywords-list'].innerHTML, /data-keyword="family"/);
  assert.doesNotMatch(elements['keyword-pills'].innerHTML, /data-keyword="beach"/);
});

test('canceling the delete confirmation makes no request and leaves the row in place', async () => {
  const { elements, fetchMock, confirmState } = loadApp();
  confirmState.result = false;

  click(elements['manage-keywords-start-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords', toKeywordObjs(['beach']));
  await flushMicrotasks();

  clickManageDelete(elements, 'beach');
  await flushMicrotasks();

  assert.equal(fetchMock.countPending('/api/keywords'), 0, 'must not call the server when the user cancels');
  assert.match(elements['manage-keywords-list'].innerHTML, /data-keyword="beach"/);
});

test('a failed delete surfaces an alert and leaves the row in place', async () => {
  const { elements, fetchMock, alerts } = loadApp();

  click(elements['manage-keywords-start-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords', toKeywordObjs(['beach']));
  await flushMicrotasks();

  clickManageDelete(elements, 'beach');
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords', { error: 'boom' }, { ok: false });
  await flushMicrotasks();

  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /boom/);
  assert.match(elements['manage-keywords-list'].innerHTML, /data-keyword="beach"/);
});

// ---- Rename ----

test('renaming from the manage view prompts for the new name, then calls POST /api/keywords/rename and updates the list and pills', async () => {
  const { elements, fetchMock, prompts, promptState } = await startSessionWithKeywords(['beach'], { keywords: ['beach'] });
  promptState.result = 'seaside';

  click(elements['manage-keywords-tag-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords', toKeywordObjs(['beach']));
  await flushMicrotasks();

  clickManageRename(elements, 'beach');
  await flushMicrotasks();

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Rename "beach"/);

  const req = fetchMock.log.find((e) => e.method === 'POST' && e.url.includes('/api/keywords/rename'));
  assert.ok(req, 'expected a POST /api/keywords/rename request');
  assert.deepEqual(req.body, { oldKeyword: 'beach', newKeyword: 'seaside' });

  fetchMock.resolveMatching('/api/keywords/rename', toKeywordObjs(['seaside']));
  await flushMicrotasks();

  assert.match(elements['manage-keywords-list'].innerHTML, /data-keyword="seaside"/);
  assert.doesNotMatch(elements['manage-keywords-list'].innerHTML, /data-keyword="beach"/);
  assert.match(elements['keyword-pills'].innerHTML, /data-keyword="seaside"/);
  assert.equal(elements['keywords-input'].value, 'seaside', 'the queued-but-unapplied keyword should follow the rename');
});

test('canceling the rename prompt makes no request', async () => {
  const { elements, fetchMock, promptState } = loadApp();
  promptState.result = null; // prompt()'s "Cancel" return value

  click(elements['manage-keywords-start-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords', toKeywordObjs(['beach']));
  await flushMicrotasks();

  clickManageRename(elements, 'beach');
  await flushMicrotasks();

  assert.equal(fetchMock.countPending('/api/keywords/rename'), 0);
  assert.match(elements['manage-keywords-list'].innerHTML, /data-keyword="beach"/);
});

test('leaving the prompt unchanged or blank makes no request', async () => {
  const { elements, fetchMock, promptState } = loadApp();

  click(elements['manage-keywords-start-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords', toKeywordObjs(['beach']));
  await flushMicrotasks();

  promptState.result = 'beach'; // unchanged
  clickManageRename(elements, 'beach');
  await flushMicrotasks();

  promptState.result = '   '; // blank after trimming
  clickManageRename(elements, 'beach');
  await flushMicrotasks();

  assert.equal(fetchMock.countPending('/api/keywords/rename'), 0);
});

test('a failed rename surfaces an alert and leaves the row in place', async () => {
  const { elements, fetchMock, alerts, promptState } = loadApp();
  promptState.result = 'family';

  click(elements['manage-keywords-start-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords', toKeywordObjs(['beach', 'family']));
  await flushMicrotasks();

  clickManageRename(elements, 'beach');
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords/rename', { error: 'keyword "family" already exists' }, { ok: false });
  await flushMicrotasks();

  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /already exists/);
  assert.match(elements['manage-keywords-list'].innerHTML, /data-keyword="beach"/);
});

// ---- Edit location ----

const CONCERT = { name: 'concert', location: { lat: 40.7128, lon: -74.006, alt: 10 } };

async function openManageFromStart(keywords) {
  const app = loadApp();
  click(app.elements['manage-keywords-start-button']);
  await flushMicrotasks();
  app.fetchMock.resolveMatching('/api/keywords', toKeywordObjs(keywords));
  await flushMicrotasks();
  return app;
}

function manageMap(created) {
  return created.maps.find((m) => m.containerId === 'manage-location-map');
}

function manageMarker(created) {
  const map = manageMap(created);
  return created.markers.filter((m) => m.map === map).pop();
}

test('each row shows its location status and an Edit location button', async () => {
  const { elements } = await openManageFromStart([CONCERT, 'beach']);

  const html = elements['manage-keywords-list'].innerHTML;
  assert.match(html, /concert[\s\S]*📍 40\.7128, -74\.0060[\s\S]*class="manage-keyword-location" data-keyword="concert">Edit location</);
  assert.match(html, /beach[\s\S]*no location[\s\S]*class="manage-keyword-location" data-keyword="beach"/);
});

test('Edit location on a located keyword opens a map pinned at its Location, and Save keeps it', async () => {
  const { elements, fetchMock, created } = await openManageFromStart([CONCERT]);

  clickManageEditLocation(elements, 'concert');

  assert.equal(elements['manage-location-editor'].hidden, false);
  assert.equal(elements['manage-location-keyword'].textContent, 'concert');
  assert.equal(elements['manage-location-clear-button'].disabled, false);
  assert.deepEqual(manageMarker(created).getLatLng(), { lat: 40.7128, lng: -74.006 });

  click(elements['manage-location-save-button']);
  await flushMicrotasks();
  assert.equal(fetchMock.countPending('/api/elevation'), 0, 'an unmoved pin keeps its saved altitude');
  const req = fetchMock.log.find((e) => e.method === 'POST' && e.url.includes('/api/keywords/location'));
  assert.deepEqual(req.body, { keyword: 'concert', lat: 40.7128, lon: -74.006, alt: 10 });

  fetchMock.resolveMatching('/api/keywords/location', [CONCERT]);
  await flushMicrotasks();
  assert.equal(elements['manage-location-editor'].hidden, true);
});

test('Edit location on a plain keyword from the start screen starts with no pin; Save needs one', async () => {
  const { elements, fetchMock, alerts, created } = await openManageFromStart(['beach']);

  clickManageEditLocation(elements, 'beach');
  assert.equal(manageMarker(created), undefined);
  assert.equal(elements['manage-location-clear-button'].disabled, true);

  click(elements['manage-location-save-button']);
  await flushMicrotasks();
  assert.match(alerts[0], /pin/);
  assert.equal(fetchMock.countPending('/api/keywords/location'), 0);
});

test('a pin placed on the manage map is saved with its looked-up altitude, and the row updates', async () => {
  const { elements, fetchMock, created } = await openManageFromStart(['beach']);

  clickManageEditLocation(elements, 'beach');
  manageMap(created)._simulateClick(50.5, -5.5);
  click(elements['manage-location-save-button']);
  await flushMicrotasks();

  const elev = fetchMock.log.find((e) => e.url.includes('/api/elevation'));
  assert.deepEqual(elev.body, { lat: 50.5, lon: -5.5 });
  fetchMock.resolveMatching('/api/elevation', { ok: true, alt: 42 });
  await flushMicrotasks();

  const req = fetchMock.log.find((e) => e.method === 'POST' && e.url.includes('/api/keywords/location'));
  assert.deepEqual(req.body, { keyword: 'beach', lat: 50.5, lon: -5.5, alt: 42 });
  fetchMock.resolveMatching('/api/keywords/location', [{ name: 'beach', location: { lat: 50.5, lon: -5.5, alt: 42 } }]);
  await flushMicrotasks();

  assert.match(elements['manage-keywords-list'].innerHTML, /beach[\s\S]*📍 50\.5000, -5\.5000/);
});

test('a failed altitude lookup saves the manage pin with altitude 0 rather than not at all', async () => {
  const { elements, fetchMock, created } = await openManageFromStart(['beach']);

  clickManageEditLocation(elements, 'beach');
  manageMap(created)._simulateClick(50.5, -5.5);
  click(elements['manage-location-save-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/elevation', { ok: false });
  await flushMicrotasks();

  const req = fetchMock.log.find((e) => e.method === 'POST' && e.url.includes('/api/keywords/location'));
  assert.equal(req.body.alt, 0);
});

test('Edit location opened from the tagging form starts a plain keyword at the form\'s pin and altitude', async () => {
  const { elements, fetchMock, created } = await startSessionWithKeywords(['beach']);
  created.maps[0]._simulateClick(1, 2);
  fetchMock.resolveMatching('/api/elevation', { ok: true, alt: 3 });
  await flushMicrotasks();

  click(elements['manage-keywords-tag-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords', toKeywordObjs(['beach']));
  await flushMicrotasks();
  clickManageEditLocation(elements, 'beach');

  assert.deepEqual(manageMarker(created).getLatLng(), { lat: 1, lng: 2 });
  click(elements['manage-location-save-button']);
  await flushMicrotasks();
  const req = fetchMock.log.find((e) => e.method === 'POST' && e.url.includes('/api/keywords/location'));
  assert.deepEqual(req.body, { keyword: 'beach', lat: 1, lon: 2, alt: 3 });
});

test('Clear removes the Location, and the keyword moves back to the plain pills', async () => {
  const { elements, fetchMock } = await startSessionWithKeywords([CONCERT]);
  click(elements['manage-keywords-tag-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords', [CONCERT]);
  await flushMicrotasks();

  clickManageEditLocation(elements, 'concert');
  click(elements['manage-location-clear-button']);
  await flushMicrotasks();
  const req = fetchMock.log.find((e) => e.method === 'DELETE' && e.url.includes('/api/keywords/location'));
  assert.deepEqual(req.body, { keyword: 'concert' });
  fetchMock.resolveMatching('/api/keywords/location', [{ name: 'concert', location: null }]);
  await flushMicrotasks();

  assert.equal(elements['manage-location-editor'].hidden, true);
  assert.match(elements['manage-keywords-list'].innerHTML, /concert[\s\S]*no location/);
  click(elements['manage-back-button']);
  assert.match(elements['keyword-pills'].innerHTML, /data-keyword="concert">concert</);
  assert.doesNotMatch(elements['located-keyword-pills'].innerHTML, /concert/);
});

test('Cancel closes the editor without a request; editing another keyword switches the editor to it', async () => {
  const { elements, fetchMock, created } = await openManageFromStart([CONCERT, 'beach']);

  clickManageEditLocation(elements, 'concert');
  clickManageEditLocation(elements, 'beach');
  assert.equal(elements['manage-location-keyword'].textContent, 'beach');
  assert.equal(manageMarker(created), undefined, 'the previous keyword\'s pin must not carry over');

  click(elements['manage-location-cancel-button']);
  assert.equal(elements['manage-location-editor'].hidden, true);
  assert.equal(fetchMock.countPending('/api/keywords/location'), 0);
});

test('deleting or renaming the keyword being edited closes the editor, so Save can\'t recreate the old name', async () => {
  const { elements, fetchMock, promptState } = await openManageFromStart([CONCERT, 'beach']);

  clickManageEditLocation(elements, 'concert');
  clickManageDelete(elements, 'concert');
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords', toKeywordObjs(['beach']));
  await flushMicrotasks();
  assert.equal(elements['manage-location-editor'].hidden, true);

  clickManageEditLocation(elements, 'beach');
  promptState.result = 'seaside';
  clickManageRename(elements, 'beach');
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords/rename', toKeywordObjs(['seaside']));
  await flushMicrotasks();
  assert.equal(elements['manage-location-editor'].hidden, true);
});
