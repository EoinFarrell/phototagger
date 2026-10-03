'use strict';
// Covers the "previously used keywords" pills: clicking a pill toggles that
// keyword in the keywords field instead of making the user retype and
// remember it, a pill already present in the field renders .active (and
// clicking it again removes it), a keyword just Applied becomes available
// as a pill immediately (optimistic local mirror of the keywords.json the
// server persists in internal/server/session.go's Apply) without waiting on
// a fresh /api/keywords round trip, and each pill's × button deletes that
// keyword everywhere via DELETE /api/keywords (internal/server/session.go's
// DeleteKeyword), after a confirm() prompt. Also covers the per-keyword
// saved Location: a pill carrying one shows a pin marker and snaps the map
// to it when clicked to add the keyword (never when clicked to remove it),
// and the "Manage keyword locations" section's set/clear actions against
// POST/DELETE /api/keywords/location (internal/server/session.go's
// SetKeywordLocation/ClearKeywordLocation).
//
// Run with: node --test web/apptest/keywords.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  flushMicrotasks, click, clickKeywordPill, clickKeywordDeletePill,
  clickKeywordLocationSet, clickKeywordLocationClear, photoResponse, loadApp,
} = require('./testutil');

// GET /api/keywords (and the set/clear-location responses that echo the
// same shape) return [{name, location}, ...]; most tests here don't care
// about Location, so this lets them keep passing plain name strings.
function toKeywordObjs(keywords) {
  return keywords.map((k) => (typeof k === 'string' ? { name: k, location: null } : k));
}

// Drives the app through the start screen with a given set of already-known
// keywords, mirroring startSession() in testutil.js but letting the test
// control the /api/keywords response and, optionally, the first photo's
// existing fields (e.g. keywords already in that photo's EXIF).
async function startSessionWithKeywords(keywords, existing) {
  const app = loadApp();
  const { fetchMock } = app;

  click(app.elements['start-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/start', { ok: true });
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/favourites', []);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords', toKeywordObjs(keywords));
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/photo/current', photoResponse(0, existing));
  await flushMicrotasks();

  return app;
}

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

test('each pill renders a paired delete button', async () => {
  const { elements } = await startSessionWithKeywords(['beach']);

  assert.match(elements['keyword-pills'].innerHTML, /class="keyword-pill-delete" data-keyword="beach"/);
});

test('deleting a pill asks for confirmation, then calls DELETE /api/keywords and drops it from the field and pill list', async () => {
  const { elements, fetchMock, confirms } = await startSessionWithKeywords(['beach', 'family'], { keywords: ['beach'] });
  assert.equal(elements['keywords-input'].value, 'beach');

  clickKeywordDeletePill(elements, 'beach');
  await flushMicrotasks();

  assert.equal(confirms.length, 1, 'expected a confirm() prompt before deleting');
  assert.match(confirms[0], /Delete "beach"/);

  const del = fetchMock.log.find((e) => e.method === 'DELETE' && e.url.includes('/api/keywords'));
  assert.ok(del, 'expected a DELETE /api/keywords request');
  assert.deepEqual(del.body, { keyword: 'beach' });

  fetchMock.resolveMatching('/api/keywords', toKeywordObjs(['family']));
  await flushMicrotasks();

  assert.equal(elements['keywords-input'].value, '', 'deleted keyword must be dropped from the current field too');
  assert.doesNotMatch(elements['keyword-pills'].innerHTML, /data-keyword="beach"/);
  assert.match(elements['keyword-pills'].innerHTML, /data-keyword="family"/);
});

test('deleting a pill does not drop other keywords merged only from the current photo\'s EXIF', async () => {
  // 'family' arrives solely via mergeKnownKeywords reading this photo's
  // existing EXIF (see app.js) -- nothing has been Applied yet, so the
  // server's keywords.json has never heard of it. Deleting 'beach' must not
  // wipe it out by replacing knownKeywords with the server's (incomplete)
  // list.
  const { elements, fetchMock } = await startSessionWithKeywords(['beach'], { keywords: ['beach', 'family'] });
  assert.match(elements['keyword-pills'].innerHTML, /data-keyword="family"/);

  clickKeywordDeletePill(elements, 'beach');
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords', toKeywordObjs([]));
  await flushMicrotasks();

  assert.doesNotMatch(elements['keyword-pills'].innerHTML, /data-keyword="beach"/);
  assert.match(elements['keyword-pills'].innerHTML, /data-keyword="family"/, 'optimistically-merged keyword must survive an unrelated delete');
});

test('canceling the delete confirmation makes no request and leaves the pill in place', async () => {
  const { elements, fetchMock, confirmState } = await startSessionWithKeywords(['beach']);
  confirmState.result = false;

  clickKeywordDeletePill(elements, 'beach');
  await flushMicrotasks();

  assert.equal(fetchMock.countPending('/api/keywords'), 0, 'must not call the server when the user cancels');
  assert.match(elements['keyword-pills'].innerHTML, /data-keyword="beach"/);
});

test('a failed delete surfaces an alert and leaves the pill in place', async () => {
  const { elements, fetchMock, alerts } = await startSessionWithKeywords(['beach']);

  clickKeywordDeletePill(elements, 'beach');
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords', { error: 'boom' }, { ok: false });
  await flushMicrotasks();

  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /boom/);
  assert.match(elements['keyword-pills'].innerHTML, /data-keyword="beach"/);
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
