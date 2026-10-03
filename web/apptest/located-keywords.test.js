'use strict';
// Covers located keywords (a keyword carrying a saved Location -- see
// CONTEXT.md) in the tagging form: they render as pills in the Location
// section rather than with the plain keyword pills, picking one snaps the
// map to its Location, adds the keyword to the photo and names the renamed
// file after it (the Apply payload's locatedKeyword), and "Save pin as
// located keyword" captures the current pin under a new or existing
// keyword via POST /api/keywords/location. Editing a located keyword's
// Location from the manage-view is covered in keyword-management.test.js.
//
// Run with: node --test web/apptest/located-keywords.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  flushMicrotasks, click, clickLocatedKeywordPill,
  photoResponse, startSessionWithKeywords,
} = require('./testutil');

const CONCERT = { name: 'concert', location: { lat: 40.7128, lon: -74.006, alt: 10 } };

async function applyBody(elements, fetchMock) {
  click(elements['apply-button']);
  await flushMicrotasks();
  return fetchMock.log.find((e) => e.url.includes('/api/photo/apply')).body;
}

test('located keywords render in the Location section, plain keywords in the Keywords section', async () => {
  const { elements } = await startSessionWithKeywords([CONCERT, { name: 'beach', location: null }]);

  const located = elements['located-keyword-pills'].innerHTML;
  const plain = elements['keyword-pills'].innerHTML;
  assert.match(located, /data-keyword="concert">📍 concert</);
  assert.doesNotMatch(located, /beach/);
  assert.match(plain, /data-keyword="beach">beach</);
  assert.doesNotMatch(plain, /concert/);
});

test('picking a located keyword snaps the pin, adds the keyword, and names the file after it', async () => {
  const { elements, fetchMock } = await startSessionWithKeywords([CONCERT]);

  clickLocatedKeywordPill(elements, 'concert');
  assert.equal(elements['keywords-input'].value, 'concert');
  assert.match(elements['located-keyword-pills'].innerHTML, /class="keyword-pill active" data-keyword="concert"/);

  const body = await applyBody(elements, fetchMock);
  assert.equal(body.locationTouched, true);
  assert.equal(body.keywordsTouched, true);
  assert.equal(body.lat, 40.7128);
  assert.equal(body.lon, -74.006);
  assert.equal(body.alt, 10);
  assert.equal(body.locatedKeyword, 'concert');
  assert.equal('favouriteName' in body, false);
});

test('clicking an active located keyword removes it but leaves the pin and the file name alone', async () => {
  const { elements, fetchMock } = await startSessionWithKeywords([CONCERT]);

  clickLocatedKeywordPill(elements, 'concert');
  clickLocatedKeywordPill(elements, 'concert');

  assert.equal(elements['keywords-input'].value, '');
  const body = await applyBody(elements, fetchMock);
  assert.equal(body.lat, 40.7128);
  assert.equal(body.locatedKeyword, 'concert', 'only moving the pin changes the file name');
});

test('moving the pin by hand after picking a located keyword falls back to the reverse-geocoded file name', async () => {
  const { elements, fetchMock, created } = await startSessionWithKeywords([CONCERT]);

  clickLocatedKeywordPill(elements, 'concert');
  created.maps[0]._simulateClick(41, -73);

  const body = await applyBody(elements, fetchMock);
  assert.equal(body.lat, 41);
  assert.equal(body.locatedKeyword, '');
  assert.equal(elements['keywords-input'].value, 'concert', 'the keyword itself stays on the photo');
});

test('the last-picked located keyword names the file when several are picked', async () => {
  const dublin = { name: 'Dublin', location: { lat: 53.35, lon: -6.26, alt: 5 } };
  const { elements, fetchMock } = await startSessionWithKeywords([CONCERT, dublin]);

  clickLocatedKeywordPill(elements, 'concert');
  clickLocatedKeywordPill(elements, 'Dublin');

  assert.equal(elements['keywords-input'].value, 'concert, Dublin');
  const body = await applyBody(elements, fetchMock);
  assert.equal(body.lat, 53.35);
  assert.equal(body.locatedKeyword, 'Dublin');
});

test('a new photo starts with no located keyword naming its file', async () => {
  const { elements, fetchMock } = await startSessionWithKeywords([CONCERT]);

  clickLocatedKeywordPill(elements, 'concert');
  click(elements['skip-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/photo/skip', photoResponse(1));
  await flushMicrotasks();

  const body = await applyBody(elements, fetchMock);
  assert.equal(body.locatedKeyword, '');
});

test('"Save pin as located keyword" requires a pin and a name', async () => {
  const { elements, fetchMock, alerts, created } = await startSessionWithKeywords([]);

  elements['located-keyword-name-input'].value = 'Pachacaid';
  click(elements['save-located-keyword-button']);
  await flushMicrotasks();
  assert.match(alerts[0], /Drop a pin/);

  created.maps[0]._simulateClick(43.19, 6.47);
  fetchMock.resolveMatching('/api/elevation', { ok: true, alt: 65 });
  await flushMicrotasks();
  elements['located-keyword-name-input'].value = '  ';
  click(elements['save-located-keyword-button']);
  await flushMicrotasks();
  assert.match(alerts[1], /name/);

  assert.equal(fetchMock.countPending('/api/keywords/location'), 0);
});

test('"Save pin as located keyword" posts the pin and shows the new located keyword', async () => {
  const { elements, fetchMock, created } = await startSessionWithKeywords([{ name: 'beach', location: null }]);

  created.maps[0]._simulateClick(43.19, 6.47);
  fetchMock.resolveMatching('/api/elevation', { ok: true, alt: 65 });
  await flushMicrotasks();

  elements['located-keyword-name-input'].value = ' Pachacaid ';
  click(elements['save-located-keyword-button']);
  await flushMicrotasks();

  const req = fetchMock.log.find((e) => e.method === 'POST' && e.url.includes('/api/keywords/location'));
  assert.deepEqual(req.body, { keyword: 'Pachacaid', lat: 43.19, lon: 6.47, alt: 65 });

  fetchMock.resolveMatching('/api/keywords/location', [
    { name: 'beach', location: null },
    { name: 'Pachacaid', location: { lat: 43.19, lon: 6.47, alt: 65 } },
  ]);
  await flushMicrotasks();

  assert.match(elements['located-keyword-pills'].innerHTML, /📍 Pachacaid/);
  assert.equal(elements['located-keyword-name-input'].value, '');
});

test('saving the pin under a plain keyword\'s name moves it to the located pills', async () => {
  const { elements, fetchMock, created } = await startSessionWithKeywords([{ name: 'beach', location: null }]);

  created.maps[0]._simulateClick(1, 2);
  fetchMock.resolveMatching('/api/elevation', { ok: true, alt: 3 });
  await flushMicrotasks();
  elements['located-keyword-name-input'].value = 'beach';
  click(elements['save-located-keyword-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords/location', [{ name: 'beach', location: { lat: 1, lon: 2, alt: 3 } }]);
  await flushMicrotasks();

  assert.match(elements['located-keyword-pills'].innerHTML, /📍 beach/);
  assert.doesNotMatch(elements['keyword-pills'].innerHTML, /beach/);
});

test('saving keeps a keyword only on this photo\'s field as a pill', async () => {
  const { elements, fetchMock, created } = await startSessionWithKeywords([], { keywords: ['archive'] });

  created.maps[0]._simulateClick(1, 2);
  fetchMock.resolveMatching('/api/elevation', { ok: true, alt: 3 });
  await flushMicrotasks();
  elements['located-keyword-name-input'].value = 'Home';
  click(elements['save-located-keyword-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords/location', [{ name: 'Home', location: { lat: 1, lon: 2, alt: 3 } }]);
  await flushMicrotasks();

  assert.match(elements['keyword-pills'].innerHTML, /data-keyword="archive"/);
});

// ---- Location's "same as previous" ----

function withPreviousLocation(previous) {
  return { ...photoResponse(1), previous: { location: previous } };
}

async function skipToPhotoWithPrevious(app, previous) {
  click(app.elements['skip-button']);
  await flushMicrotasks();
  app.fetchMock.resolveMatching('/api/photo/skip', withPreviousLocation(previous));
  await flushMicrotasks();
}

function sameAsPrevLocation(app) {
  return app.sameAsPrevButtons.find((b) => b.dataset.group === 'location');
}

test('Location "same as previous" restores the pin and adds its located keyword to Keywords', async () => {
  const app = await startSessionWithKeywords([CONCERT]);
  await skipToPhotoWithPrevious(app, { lat: 40.7128, lon: -74.006, alt: 10, locatedKeyword: 'concert' });

  click(sameAsPrevLocation(app));

  assert.equal(app.elements['keywords-input'].value, 'concert');
  const body = await applyBody(app.elements, app.fetchMock);
  assert.equal(body.lat, 40.7128);
  assert.equal(body.locationTouched, true);
  assert.equal(body.locatedKeyword, 'concert');
  assert.equal(body.keywordsTouched, true, 'the carried-over keyword must be written');
  assert.deepEqual(body.keywords, ['concert']);
});

test('Location "same as previous" does not duplicate a located keyword already in Keywords', async () => {
  const app = await startSessionWithKeywords([CONCERT]);
  await skipToPhotoWithPrevious(app, { lat: 40.7128, lon: -74.006, alt: 10, locatedKeyword: 'concert' });
  app.elements['keywords-input'].value = 'gig, concert';

  click(sameAsPrevLocation(app));

  assert.equal(app.elements['keywords-input'].value, 'gig, concert');
});

test('Location "same as previous" for a freehand pin leaves Keywords alone', async () => {
  const app = await startSessionWithKeywords([]);
  await skipToPhotoWithPrevious(app, { lat: 1, lon: 2, alt: 3 });

  click(sameAsPrevLocation(app));

  assert.equal(app.elements['keywords-input'].value, '');
  const body = await applyBody(app.elements, app.fetchMock);
  assert.equal(body.lat, 1);
  assert.equal(body.locatedKeyword, '');
  assert.equal(body.keywordsTouched, false);
});
