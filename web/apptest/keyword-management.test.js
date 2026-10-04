'use strict';
// Covers the standalone "Manage keywords" view: reachable from either the
// start screen or the tagging form (returning to whichever one it was
// opened from), listing every known keyword with Rename/Delete actions.
//
// Delete (internal/server/session.go's DeleteKeyword, via DELETE
// /api/keywords) moved here from the old keyword pills' inline × button --
// see keywords.test.js for the tagging form's tag input. Rename
// (RenameKeyword, via POST /api/keywords/rename) is new: it changes a
// keyword's text everywhere. Both ask first in the shared in-page
// dialog (#ask-dialog, issue #18), which also shows their errors and,
// while they run, a busy state (issue #21). Edit
// location sets or clears a keyword's saved Location (making it a located
// keyword, or a plain one again) from a small map of its own, via
// POST/DELETE /api/keywords/location.
//
// Run with: node --test web/apptest/keyword-management.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  flushMicrotasks, click, clickManageRename, clickManageDelete, clickManageEditLocation,
  toKeywordObjs, startSessionWithKeywords, loadApp,
  chipKeywords, suggestionKeywords, openKeywordSuggestions,
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

test('each known keyword renders a Rename and a red Delete button', async () => {
  const { elements, fetchMock } = loadApp();

  click(elements['manage-keywords-start-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords', toKeywordObjs(['beach']));
  await flushMicrotasks();

  const html = elements['manage-keywords-list'].innerHTML;
  assert.match(html, /class="manage-keyword-rename[^"]*" data-keyword="beach"/);
  assert.match(html, /class="manage-keyword-delete[^"]*\bdanger\b[^"]*" data-keyword="beach"/);
});

// ---- Delete ----

test('deleting from the manage view asks in the dialog, then calls DELETE /api/keywords and drops it from the list', async () => {
  const { elements, fetchMock } = await startSessionWithKeywords(['beach', 'family'], { keywords: ['beach'] });
  assert.deepEqual(chipKeywords(elements), ['beach']);

  click(elements['manage-keywords-tag-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords', toKeywordObjs(['beach', 'family']));
  await flushMicrotasks();

  clickManageDelete(elements, 'beach');
  await flushMicrotasks();

  assert.equal(elements['ask-dialog'].open, true, 'expected the confirmation dialog');
  assert.match(elements['ask-title'].textContent, /Delete "beach"/);
  assert.equal(elements['ask-input'].hidden, true, 'a confirmation has no text field');
  assert.equal(fetchMock.countPending('/api/keywords'), 0, 'nothing is deleted before confirming');

  click(elements['ask-confirm-button']);
  await flushMicrotasks();
  const del = fetchMock.log.find((e) => e.method === 'DELETE' && e.url.includes('/api/keywords'));
  assert.ok(del, 'expected a DELETE /api/keywords request');
  assert.deepEqual(del.body, { keyword: 'beach' });

  fetchMock.resolveMatching('/api/keywords', toKeywordObjs(['family']));
  await flushMicrotasks();

  assert.equal(elements['ask-dialog'].open, false);
  assert.deepEqual(chipKeywords(elements), [], 'deleted keyword must be dropped from the current photo too');
  assert.doesNotMatch(elements['manage-keywords-list'].innerHTML, /data-keyword="beach"/);
  assert.match(elements['manage-keywords-list'].innerHTML, /data-keyword="family"/);
  openKeywordSuggestions(elements);
  assert.deepEqual(suggestionKeywords(elements), ['family']);
  click(elements['manage-back-button']);
  click(elements['apply-button']);
  await flushMicrotasks();
  const applied = fetchMock.log.find((e) => e.url.includes('/api/photo/apply')).body;
  assert.equal(applied.keywordsTouched, false, 'a delete everywhere isn\'t an edit to this photo');
});

test('cancelling the delete dialog makes no request and leaves the row in place', async () => {
  const { elements, fetchMock } = await openManageFromStart(['beach']);

  clickManageDelete(elements, 'beach');
  await flushMicrotasks();
  click(elements['ask-cancel-button']);
  await flushMicrotasks();

  assert.equal(elements['ask-dialog'].open, false);
  assert.equal(fetchMock.countPending('/api/keywords'), 0, 'must not call the server when the user cancels');
  assert.match(elements['manage-keywords-list'].innerHTML, /data-keyword="beach"/);
});

test('closing the delete dialog with Escape makes no request', async () => {
  const { elements, fetchMock } = await openManageFromStart(['beach']);

  clickManageDelete(elements, 'beach');
  await flushMicrotasks();
  // Escape closes a <dialog> natively and fires its close event.
  elements['ask-dialog'].close();
  elements['ask-dialog'].dispatchEvent({ type: 'close' });
  await flushMicrotasks();

  click(elements['ask-confirm-button']); // a stale click after closing does nothing
  await flushMicrotasks();
  assert.equal(fetchMock.countPending('/api/keywords'), 0);
});

test('a failed delete shows the error in the dialog, keeps it open, and leaves the row in place', async () => {
  const { elements, fetchMock } = await openManageFromStart(['beach']);

  clickManageDelete(elements, 'beach');
  await flushMicrotasks();
  click(elements['ask-confirm-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords', { error: 'boom' }, { ok: false });
  await flushMicrotasks();

  assert.equal(elements['ask-dialog'].open, true);
  assert.equal(elements['ask-error'].hidden, false);
  assert.match(elements['ask-error'].textContent, /boom/);
  assert.match(elements['manage-keywords-list'].innerHTML, /data-keyword="beach"/);
});

test('a network error during delete shows in the dialog instead of leaving it stuck', async () => {
  const { elements, fetchMock } = await openManageFromStart(['beach']);

  clickManageDelete(elements, 'beach');
  await flushMicrotasks();
  click(elements['ask-confirm-button']);
  await flushMicrotasks();
  const entry = fetchMock.pending.find((e) => e.method === 'DELETE');
  entry.settled = true;
  entry.resolve(Promise.reject(new Error('network down')));
  await flushMicrotasks();

  assert.equal(elements['ask-dialog'].open, true);
  assert.match(elements['ask-error'].textContent, /network down/);
  assert.equal(elements['ask-confirm-button'].disabled, false, 'the user can retry');
});

test('Escape is ignored while a delete is in flight, so its result is still shown', async () => {
  const { elements, fetchMock } = await openManageFromStart(['beach']);

  clickManageDelete(elements, 'beach');
  await flushMicrotasks();
  click(elements['ask-confirm-button']);
  await flushMicrotasks();

  let prevented = false;
  elements['ask-dialog'].dispatchEvent({ type: 'cancel', preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(elements['ask-cancel-button'].disabled, true, 'Cancel waits too');

  fetchMock.resolveMatching('/api/keywords', { error: 'boom' }, { ok: false });
  await flushMicrotasks();
  assert.match(elements['ask-error'].textContent, /boom/);
});

test('while a delete runs, the confirm button shows a spinner and the dialog says what it\'s doing; both clear on success', async () => {
  const { elements, fetchMock } = await openManageFromStart(['beach']);

  clickManageDelete(elements, 'beach');
  await flushMicrotasks();
  assert.equal(elements['ask-confirm-button'].getAttribute('aria-busy'), null);
  assert.equal(elements['ask-working'].hidden, true);

  click(elements['ask-confirm-button']);
  await flushMicrotasks();
  assert.equal(elements['ask-confirm-button'].getAttribute('aria-busy'), 'true');
  assert.equal(elements['ask-working'].hidden, false);
  assert.match(elements['ask-working'].textContent, /Removing "beach" from every photo/);

  fetchMock.resolveMatching('/api/keywords', []);
  await flushMicrotasks();
  assert.equal(elements['ask-confirm-button'].getAttribute('aria-busy'), null);
  assert.equal(elements['ask-working'].hidden, true);
});

test('the busy state clears when a delete fails, leaving only the error', async () => {
  const { elements, fetchMock } = await openManageFromStart(['beach']);

  clickManageDelete(elements, 'beach');
  await flushMicrotasks();
  click(elements['ask-confirm-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords', { error: 'boom' }, { ok: false });
  await flushMicrotasks();

  assert.equal(elements['ask-confirm-button'].getAttribute('aria-busy'), null);
  assert.equal(elements['ask-working'].hidden, true);
  assert.equal(elements['ask-error'].hidden, false);
});

test('retrying hides the previous attempt\'s error while the new one runs', async () => {
  const { elements, fetchMock } = await openManageFromStart(['beach']);

  clickManageDelete(elements, 'beach');
  await flushMicrotasks();
  click(elements['ask-confirm-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords', { error: 'boom' }, { ok: false });
  await flushMicrotasks();

  click(elements['ask-confirm-button']);
  await flushMicrotasks();
  assert.equal(elements['ask-error'].hidden, true);
  assert.equal(elements['ask-working'].hidden, false);
});

// ---- Rename ----

test('renaming from the manage view asks for the new name in the dialog, then calls POST /api/keywords/rename and updates the list and the photo\'s keywords', async () => {
  const { elements, fetchMock } = await startSessionWithKeywords(['beach'], { keywords: ['beach'] });

  click(elements['manage-keywords-tag-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords', toKeywordObjs(['beach']));
  await flushMicrotasks();

  clickManageRename(elements, 'beach');
  await flushMicrotasks();

  assert.equal(elements['ask-dialog'].open, true);
  assert.match(elements['ask-title'].textContent, /Rename "beach"/);
  assert.equal(elements['ask-input'].hidden, false);
  assert.equal(elements['ask-input'].value, 'beach', 'the field starts with the current name');

  elements['ask-input'].value = '  seaside ';
  click(elements['ask-confirm-button']);
  await flushMicrotasks();
  // The counts haven't arrived, so the confirmation can't say how many.
  assert.match(elements['ask-message'].textContent, /This will edit every photo that has it\. Continue\?/);
  click(elements['ask-confirm-button']);
  await flushMicrotasks();

  const req = fetchMock.log.find((e) => e.method === 'POST' && e.url.includes('/api/keywords/rename'));
  assert.ok(req, 'expected a POST /api/keywords/rename request');
  assert.deepEqual(req.body, { oldKeyword: 'beach', newKeyword: 'seaside' });

  fetchMock.resolveMatching('/api/keywords/rename', toKeywordObjs(['seaside']));
  await flushMicrotasks();

  assert.equal(elements['ask-dialog'].open, false);
  assert.match(elements['manage-keywords-list'].innerHTML, /data-keyword="seaside"/);
  assert.doesNotMatch(elements['manage-keywords-list'].innerHTML, /data-keyword="beach"/);
  assert.deepEqual(chipKeywords(elements), ['seaside'], 'the queued-but-unapplied keyword should follow the rename');
  click(elements['manage-back-button']);
  click(elements['apply-button']);
  await flushMicrotasks();
  const applied = fetchMock.log.find((e) => e.url.includes('/api/photo/apply')).body;
  assert.equal(applied.keywordsTouched, false, 'a rename everywhere isn\'t an edit to this photo');
  assert.deepEqual(applied.keywords, ['seaside']);
});

test('Enter in the rename field confirms', async () => {
  const { elements, fetchMock } = await openManageFromStart(['beach'], { beach: 1 });

  clickManageRename(elements, 'beach');
  await flushMicrotasks();
  elements['ask-input'].value = 'seaside';
  elements['ask-input'].dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {} });
  await flushMicrotasks();
  click(elements['ask-confirm-button']);
  await flushMicrotasks();

  assert.equal(fetchMock.countPending('/api/keywords/rename'), 1);
});

test("the delete dialog's confirm button is red; the rename dialog's is not", async () => {
  const { elements } = await openManageFromStart(['beach']);

  clickManageDelete(elements, 'beach');
  await flushMicrotasks();
  assert.equal(elements['ask-confirm-button'].classList.contains('danger'), true);
  click(elements['ask-cancel-button']);

  clickManageRename(elements, 'beach');
  await flushMicrotasks();
  assert.equal(elements['ask-confirm-button'].classList.contains('danger'), false);
});

test('while a rename runs, the dialog shows a spinner and a renaming message; both clear when it fails', async () => {
  const { elements, fetchMock } = await openManageFromStart(['beach'], { beach: 0 });

  clickManageRename(elements, 'beach');
  await flushMicrotasks();
  elements['ask-input'].value = 'seaside';
  click(elements['ask-confirm-button']);
  await flushMicrotasks();
  assert.equal(elements['ask-confirm-button'].getAttribute('aria-busy'), 'true');
  assert.match(elements['ask-working'].textContent, /Renaming "beach" in every photo/);

  fetchMock.resolveMatching('/api/keywords/rename', { error: 'boom' }, { ok: false });
  await flushMicrotasks();
  assert.equal(elements['ask-confirm-button'].getAttribute('aria-busy'), null);
  assert.equal(elements['ask-working'].hidden, true);
});

test('cancelling the rename dialog makes no request', async () => {
  const { elements, fetchMock } = await openManageFromStart(['beach']);

  clickManageRename(elements, 'beach');
  await flushMicrotasks();
  elements['ask-input'].value = 'seaside';
  click(elements['ask-cancel-button']);
  await flushMicrotasks();

  assert.equal(fetchMock.countPending('/api/keywords/rename'), 0);
  assert.match(elements['manage-keywords-list'].innerHTML, /data-keyword="beach"/);
});

test('a blank new name is refused inline, keeping the dialog open', async () => {
  const { elements, fetchMock } = await openManageFromStart(['beach']);

  clickManageRename(elements, 'beach');
  await flushMicrotasks();
  elements['ask-input'].value = '   ';
  click(elements['ask-confirm-button']);
  await flushMicrotasks();

  assert.equal(elements['ask-dialog'].open, true);
  assert.equal(elements['ask-error'].hidden, false);
  assert.match(elements['ask-error'].textContent, /name/i);
  assert.equal(fetchMock.countPending('/api/keywords/rename'), 0);
});

test('an unchanged name closes the dialog without a request', async () => {
  const { elements, fetchMock } = await openManageFromStart(['beach']);

  clickManageRename(elements, 'beach');
  await flushMicrotasks();
  click(elements['ask-confirm-button']);
  await flushMicrotasks();

  assert.equal(elements['ask-dialog'].open, false);
  assert.equal(fetchMock.countPending('/api/keywords/rename'), 0);
});

test('a failed rename shows the error in the dialog and leaves the row in place', async () => {
  const { elements, fetchMock } = await openManageFromStart(['beach', 'family'], { beach: 3, family: 1 });

  clickManageRename(elements, 'beach');
  await flushMicrotasks();
  elements['ask-input'].value = 'family';
  click(elements['ask-confirm-button']);
  await flushMicrotasks();
  click(elements['ask-confirm-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords/rename', { error: 'keyword "family" already exists' }, { ok: false });
  await flushMicrotasks();

  assert.equal(elements['ask-dialog'].open, true);
  assert.match(elements['ask-error'].textContent, /already exists/);
  assert.match(elements['manage-keywords-list'].innerHTML, /data-keyword="beach"/);
});

test('a new dialog starts without the previous one\'s error', async () => {
  const { elements, fetchMock } = await openManageFromStart(['beach']);

  clickManageDelete(elements, 'beach');
  await flushMicrotasks();
  click(elements['ask-confirm-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords', { error: 'boom' }, { ok: false });
  await flushMicrotasks();
  click(elements['ask-cancel-button']);
  await flushMicrotasks();

  clickManageRename(elements, 'beach');
  await flushMicrotasks();
  assert.equal(elements['ask-error'].hidden, true);
});

// ---- Photo counts ----

test('each row shows how many photos carry the keyword once the counts arrive', async () => {
  const { elements, fetchMock } = await openManageFromStart(['beach', 'family']);
  assert.match(elements['manage-keywords-list'].innerHTML, /<span class="manage-keyword-count">counting…<\/span>/);

  fetchMock.resolveMatching('/api/keyword-usage', { beach: 12, family: 1 });
  await flushMicrotasks();

  const html = elements['manage-keywords-list'].innerHTML;
  assert.match(html, /beach<\/span><span class="manage-keyword-count">12 photos<\/span>/);
  assert.match(html, /family<\/span><span class="manage-keyword-count">1 photo<\/span>/);
});

test('a keyword no photo carries shows 0 photos; a failed count shows nothing', async () => {
  const { elements, fetchMock } = await openManageFromStart(['beach'], {});
  assert.match(elements['manage-keywords-list'].innerHTML, /0 photos/);

  click(elements['manage-back-button']);
  click(elements['manage-keywords-start-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords', toKeywordObjs(['beach']));
  fetchMock.resolveMatching('/api/keyword-usage', { error: 'boom' }, { ok: false });
  await flushMicrotasks();
  assert.match(elements['manage-keywords-list'].innerHTML, /<span class="manage-keyword-count"><\/span>/);
});

test('renaming a keyword on photos asks "This will edit N photos" before sending, and Cancel there sends nothing', async () => {
  const { elements, fetchMock } = await openManageFromStart(['beach'], { beach: 12 });

  clickManageRename(elements, 'beach');
  await flushMicrotasks();
  elements['ask-input'].value = 'seaside';
  click(elements['ask-confirm-button']);
  await flushMicrotasks();

  assert.equal(elements['ask-dialog'].open, true);
  assert.equal(elements['ask-title'].textContent, 'Rename "beach" to "seaside"?');
  assert.equal(elements['ask-message'].textContent, 'This will edit 12 photos. Continue?');
  assert.equal(elements['ask-input'].hidden, true);
  assert.equal(fetchMock.countPending('/api/keywords/rename'), 0);

  click(elements['ask-cancel-button']);
  await flushMicrotasks();
  assert.equal(elements['ask-dialog'].open, false);
  assert.equal(fetchMock.countPending('/api/keywords/rename'), 0);
});

test('confirming the photo count renames, and the count follows the new name', async () => {
  const { elements, fetchMock } = await openManageFromStart(['beach'], { beach: 12 });

  clickManageRename(elements, 'beach');
  await flushMicrotasks();
  elements['ask-input'].value = 'seaside';
  click(elements['ask-confirm-button']);
  await flushMicrotasks();
  click(elements['ask-confirm-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords/rename', toKeywordObjs(['seaside']));
  await flushMicrotasks();

  assert.equal(elements['ask-dialog'].open, false);
  assert.match(elements['manage-keywords-list'].innerHTML, /seaside<\/span><span class="manage-keyword-count">12 photos<\/span>/);
});

test('renaming a keyword no photo carries skips the photo-count confirmation', async () => {
  const { elements, fetchMock } = await openManageFromStart(['beach'], { family: 3 });

  clickManageRename(elements, 'beach');
  await flushMicrotasks();
  elements['ask-input'].value = 'seaside';
  click(elements['ask-confirm-button']);
  await flushMicrotasks();

  assert.equal(fetchMock.countPending('/api/keywords/rename'), 1);
});

test('the delete confirmation says how many photos it will edit', async () => {
  const { elements } = await openManageFromStart(['beach', 'family'], { beach: 12 });

  clickManageDelete(elements, 'beach');
  await flushMicrotasks();
  assert.match(elements['ask-message'].textContent, /removes it from 12 photos in this folder/);
  click(elements['ask-cancel-button']);

  clickManageDelete(elements, 'family');
  await flushMicrotasks();
  assert.match(elements['ask-message'].textContent, /No photos in this folder have it/);
});

// ---- Edit location ----

const CONCERT = { name: 'concert', location: { lat: 40.7128, lon: -74.006, alt: 10 } };

// usage, if given, resolves GET /api/keyword-usage ({name: photo count});
// left out, the counts stay loading.
async function openManageFromStart(keywords, usage) {
  const app = loadApp();
  click(app.elements['manage-keywords-start-button']);
  await flushMicrotasks();
  app.fetchMock.resolveMatching('/api/keywords', toKeywordObjs(keywords));
  await flushMicrotasks();
  if (usage) {
    app.fetchMock.resolveMatching('/api/keyword-usage', usage);
    await flushMicrotasks();
  }
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
  assert.match(html, /concert[\s\S]*📍 40\.7128, -74\.0060[\s\S]*class="manage-keyword-location[^"]*" data-keyword="concert">Edit location</);
  assert.match(html, /beach[\s\S]*no location[\s\S]*class="manage-keyword-location[^"]*" data-keyword="beach"/);
});

test('Edit location on a located keyword opens a map pinned at its Location, and Save keeps it', async () => {
  const { elements, fetchMock, created } = await openManageFromStart([CONCERT]);

  clickManageEditLocation(elements, 'concert');

  assert.equal(elements['manage-location-editor'].open, true);
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
  assert.equal(elements['manage-location-editor'].open, false);
});

test('Edit location on a plain keyword from the start screen starts with no pin; Save needs one', async () => {
  const { elements, fetchMock, created } = await openManageFromStart(['beach']);

  clickManageEditLocation(elements, 'beach');
  assert.equal(manageMarker(created), undefined);
  assert.equal(elements['manage-location-clear-button'].disabled, true);

  click(elements['manage-location-save-button']);
  await flushMicrotasks();
  assert.equal(elements['manage-location-error'].hidden, false);
  assert.match(elements['manage-location-error'].textContent, /pin/);
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

test('Clear removes the Location, and the keyword is suggested as a plain one again', async () => {
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

  assert.equal(elements['manage-location-editor'].open, false);
  assert.match(elements['manage-keywords-list'].innerHTML, /concert[\s\S]*no location/);
  click(elements['manage-back-button']);
  openKeywordSuggestions(elements);
  assert.match(elements['keyword-suggestions'].innerHTML, /data-keyword="concert">concert</);
});

test('Cancel closes the editor without a request; editing another keyword switches the editor to it', async () => {
  const { elements, fetchMock, created } = await openManageFromStart([CONCERT, 'beach']);

  clickManageEditLocation(elements, 'concert');
  clickManageEditLocation(elements, 'beach');
  assert.equal(elements['manage-location-keyword'].textContent, 'beach');
  assert.equal(manageMarker(created), undefined, 'the previous keyword\'s pin must not carry over');

  click(elements['manage-location-cancel-button']);
  assert.equal(elements['manage-location-editor'].open, false);
  assert.equal(fetchMock.countPending('/api/keywords/location'), 0);
});

test('deleting or renaming the keyword being edited closes the editor, so Save can\'t recreate the old name', async () => {
  const { elements, fetchMock } = await openManageFromStart([CONCERT, 'beach'], {});

  clickManageEditLocation(elements, 'concert');
  clickManageDelete(elements, 'concert');
  await flushMicrotasks();
  click(elements['ask-confirm-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords', toKeywordObjs(['beach']));
  await flushMicrotasks();
  assert.equal(elements['manage-location-editor'].open, false);

  clickManageEditLocation(elements, 'beach');
  clickManageRename(elements, 'beach');
  await flushMicrotasks();
  elements['ask-input'].value = 'seaside';
  click(elements['ask-confirm-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords/rename', toKeywordObjs(['seaside']));
  await flushMicrotasks();
  assert.equal(elements['manage-location-editor'].open, false);
});
