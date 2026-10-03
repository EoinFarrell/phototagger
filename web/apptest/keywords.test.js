'use strict';
// Covers the "previously used keywords" pills: clicking a pill toggles that
// keyword in the keywords field instead of making the user retype and
// remember it, a pill already present in the field renders .active (and
// clicking it again removes it), and a keyword just Applied becomes
// available as a pill immediately (optimistic local mirror of the
// keywords.json the server persists in internal/server/session.go's Apply)
// without waiting on a fresh /api/keywords round trip. Also covers the
// per-keyword saved Location: a pill carrying one shows a pin marker and
// snaps the map to it when clicked to add the keyword (never when clicked
// to remove it), and the "Manage keyword locations" section's set/clear
// actions against POST/DELETE /api/keywords/location
// (internal/server/session.go's SetKeywordLocation/ClearKeywordLocation).
// Deleting and renaming a keyword live on the separate manage-view instead
// of on the pill itself -- see keyword-management.test.js.
//
// Run with: node --test web/apptest/keywords.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  flushMicrotasks, click, clickKeywordPill,
  clickKeywordLocationSet, clickKeywordLocationClear,
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

// ---- Keyword-location association ----

test('a pill with a saved location shows a pin marker', async () => {
  const { elements } = await startSessionWithKeywords([
    { name: 'concert', location: { lat: 40.7128, lon: -74.006, alt: 10 } },
    { name: 'beach', location: null },
  ]);

  const html = elements['keyword-pills'].innerHTML;
  assert.match(html, /data-keyword="concert">📍 concert</);
  assert.match(html, /data-keyword="beach">beach</);
});

test('clicking an inactive pill with a saved location snaps the map to it and touches location', async () => {
  const { elements, fetchMock } = await startSessionWithKeywords([
    { name: 'concert', location: { lat: 40.7128, lon: -74.006, alt: 10 } },
  ]);

  clickKeywordPill(elements, 'concert');

  click(elements['apply-button']);
  await flushMicrotasks();
  const body = fetchMock.log.find((e) => e.url.includes('/api/photo/apply')).body;
  assert.equal(body.locationTouched, true, 'adding a keyword with a saved location must touch location');
  assert.equal(body.lat, 40.7128);
  assert.equal(body.lon, -74.006);
  assert.equal(body.alt, 10);
});

test('clicking an active pill to remove it leaves the pin where the earlier add click put it', async () => {
  const { elements, fetchMock } = await startSessionWithKeywords([
    { name: 'concert', location: { lat: 40.7128, lon: -74.006, alt: 10 } },
  ]);

  clickKeywordPill(elements, 'concert'); // add: snaps the map to concert's location
  clickKeywordPill(elements, 'concert'); // remove: must not touch the map again

  click(elements['apply-button']);
  await flushMicrotasks();
  const body = fetchMock.log.find((e) => e.url.includes('/api/photo/apply')).body;
  assert.equal(elements['keywords-input'].value, '', 'the keyword itself should be removed');
  assert.equal(body.lat, 40.7128, 'pin should remain where the earlier add click left it');
  assert.equal(body.lon, -74.006);
});

test('manage-keyword-locations lists each known keyword with its location status', async () => {
  const { elements } = await startSessionWithKeywords([
    { name: 'beach', location: null },
    { name: 'concert', location: { lat: 40.7128, lon: -74.006, alt: 10 } },
  ]);

  const html = elements['keyword-locations-list'].innerHTML;
  assert.match(html, /beach[\s\S]*no location/);
  assert.match(html, /concert[\s\S]*40\.7128, -74\.0060/);
});

test('"Set to current pin" requires a pin to be placed first', async () => {
  const { elements, fetchMock, alerts } = await startSessionWithKeywords([{ name: 'beach', location: null }]);

  clickKeywordLocationSet(elements, 'beach');
  await flushMicrotasks();

  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /Drop a pin/);
  assert.equal(fetchMock.countPending('/api/keywords/location'), 0);
});

test('"Set to current pin" posts the current marker\'s coordinates and refreshes the pill', async () => {
  const { elements, fetchMock, created } = await startSessionWithKeywords([{ name: 'beach', location: null }]);

  created.maps[0]._simulateClick(40.7128, -74.006);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/elevation', { ok: true, alt: 10 });
  await flushMicrotasks();

  clickKeywordLocationSet(elements, 'beach');
  await flushMicrotasks();

  const req = fetchMock.log.find((e) => e.method === 'POST' && e.url.includes('/api/keywords/location'));
  assert.ok(req, 'expected a POST /api/keywords/location request');
  assert.deepEqual(req.body, { keyword: 'beach', lat: 40.7128, lon: -74.006, alt: 10 });

  fetchMock.resolveMatching('/api/keywords/location', [{ name: 'beach', location: { lat: 40.7128, lon: -74.006, alt: 10 } }]);
  await flushMicrotasks();

  assert.match(elements['keyword-pills'].innerHTML, /📍 beach/, 'pill should now show the pin marker');
});

test('"Clear" removes a keyword\'s saved location', async () => {
  const { elements, fetchMock } = await startSessionWithKeywords([
    { name: 'concert', location: { lat: 40.7128, lon: -74.006, alt: 10 } },
  ]);

  clickKeywordLocationClear(elements, 'concert');
  await flushMicrotasks();

  const req = fetchMock.log.find((e) => e.method === 'DELETE' && e.url.includes('/api/keywords/location'));
  assert.ok(req, 'expected a DELETE /api/keywords/location request');
  assert.deepEqual(req.body, { keyword: 'concert' });

  fetchMock.resolveMatching('/api/keywords/location', [{ name: 'concert', location: null }]);
  await flushMicrotasks();

  assert.doesNotMatch(elements['keyword-pills'].innerHTML, /📍/);
});
