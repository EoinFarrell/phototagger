'use strict';
// Covers the "previously used keywords" pills: clicking a pill toggles that
// keyword in the keywords field instead of making the user retype and
// remember it, a pill already present in the field renders .active (and
// clicking it again removes it), and a keyword just Applied becomes
// available as a pill immediately (optimistic local mirror of the
// keywords.json the server persists in internal/server/session.go's Apply)
// without waiting on a fresh /api/keywords round trip. Located keywords
// (those carrying a saved Location) render in the Location section instead
// -- see located-keywords.test.js. Deleting, renaming and editing a
// keyword's location a keyword live on the separate manage-view instead
// of on the pill itself -- see keyword-management.test.js.
//
// Run with: node --test web/apptest/keywords.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  flushMicrotasks, click, clickKeywordPill,
  photoResponse, startSessionWithKeywords,
} = require('./testutil');

test('known keywords render as clickable pills', async () => {
  const { elements } = await startSessionWithKeywords(['beach', 'family']);

  const html = elements['keyword-pills'].innerHTML;
  assert.match(html, /class="keyword-pill" data-keyword="beach">beach</);
  assert.match(html, /class="keyword-pill" data-keyword="family">family</);
});

test('clicking a pill appends it to the keywords field and touches the group', async () => {
  const { elements, fetchMock } = await startSessionWithKeywords(['beach', 'family']);

  clickKeywordPill(elements, 'beach');
  assert.equal(elements['keywords-input'].value, 'beach');

  click(elements['apply-button']);
  await flushMicrotasks();
  const body = fetchMock.log.find((e) => e.url.includes('/api/photo/apply')).body;
  assert.equal(body.keywordsTouched, true, 'clicking a pill must mark keywords as touched, like typing does');
  assert.deepEqual(body.keywords, ['beach']);
});

test('clicking an active pill removes it from the keywords field', async () => {
  const { elements } = await startSessionWithKeywords(['beach']);

  clickKeywordPill(elements, 'beach');
  clickKeywordPill(elements, 'beach');

  assert.equal(elements['keywords-input'].value, '');
});

test('a pill already present in the field renders as active', async () => {
  const { elements } = await startSessionWithKeywords(['beach', 'family']);

  elements['keywords-input'].value = 'beach';
  elements['keywords-input'].dispatchEvent({ type: 'input', target: elements['keywords-input'] });

  const html = elements['keyword-pills'].innerHTML;
  assert.match(html, /class="keyword-pill active" data-keyword="beach">beach</);
  assert.match(html, /class="keyword-pill" data-keyword="family">family</);
});

test('a brand-new keyword just Applied becomes a pill immediately, without waiting for a fresh /api/keywords fetch', async () => {
  const { elements, fetchMock } = await startSessionWithKeywords([]);

  elements['keywords-input'].value = 'sunset';
  elements['keywords-input'].dispatchEvent({ type: 'input', target: elements['keywords-input'] });

  click(elements['apply-button']);
  await flushMicrotasks();
  assert.equal(fetchMock.countPending('/api/keywords'), 0, 'applying must not itself trigger a keywords refetch');

  fetchMock.resolveMatching('/api/photo/apply', photoResponse(1));
  await flushMicrotasks();

  assert.match(elements['keyword-pills'].innerHTML, /data-keyword="sunset">sunset</);
});

test('a keyword already on the photo (e.g. tagged outside this tool) becomes a pill as soon as the photo loads', async () => {
  const { elements } = await startSessionWithKeywords([], { keywords: ['archive'] });

  assert.match(elements['keyword-pills'].innerHTML, /class="keyword-pill active" data-keyword="archive">archive</);
});
