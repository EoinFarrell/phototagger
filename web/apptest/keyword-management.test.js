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
// interaction style.
//
// Run with: node --test web/apptest/keyword-management.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  flushMicrotasks, click, clickManageRename, clickManageDelete,
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
