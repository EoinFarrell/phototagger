'use strict';
// Covers located keywords (a keyword carrying a saved Location -- see
// CONTEXT.md) in the tagging form: they're suggested first in the Keywords
// tag input, marked with a pin; adding one snaps the map to its Location
// and names the renamed file after it (the Apply payload's
// locatedKeyword); removing one leaves the map alone; and "Save pin as
// located keyword" captures the current pin under a new or existing
// keyword via POST /api/keywords/location. Editing a located keyword's
// Location from the manage-view is covered in keyword-management.test.js.
//
// Run with: node --test web/apptest/located-keywords.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  flushMicrotasks, click, photoResponse, startSessionWithKeywords,
  chipKeywords, suggestionKeywords, openKeywordSuggestions, typeInKeywordEntry,
  pressInKeywordEntry, pickKeyword, removeKeywordChip,
} = require('./testutil');

const CONCERT = { name: 'concert', location: { lat: 40.7128, lon: -74.006, alt: 10 } };

async function applyBody(elements, fetchMock) {
  click(elements['apply-button']);
  await flushMicrotasks();
  return fetchMock.log.find((e) => e.url.includes('/api/photo/apply')).body;
}

test('located keywords are suggested before plain ones, marked with a pin', async () => {
  const { elements } = await startSessionWithKeywords([{ name: 'beach', location: null }, CONCERT]);

  openKeywordSuggestions(elements);

  assert.deepEqual(suggestionKeywords(elements), ['concert', 'beach']);
  assert.match(elements['keyword-suggestions'].innerHTML, /📍<\/span>[^<]*<span[^>]*>[^<]*<\/span>concert/);
  assert.doesNotMatch(elements['keyword-suggestions'].innerHTML, /📍<\/span>[^<]*<span[^>]*>[^<]*<\/span>beach/);
});

test('picking a located keyword snaps the pin, adds the keyword, and names the file after it', async () => {
  const { elements, fetchMock } = await startSessionWithKeywords([CONCERT]);

  pickKeyword(elements, 'concert');
  assert.deepEqual(chipKeywords(elements), ['concert']);

  const body = await applyBody(elements, fetchMock);
  assert.equal(body.locationTouched, true);
  assert.equal(body.keywordsTouched, true);
  assert.equal(body.lat, 40.7128);
  assert.equal(body.lon, -74.006);
  assert.equal(body.alt, 10);
  assert.equal(body.locatedKeyword, 'concert');
  assert.equal('favouriteName' in body, false);
});

test('typing a located keyword\'s name snaps the pin just like picking it', async () => {
  const { elements, fetchMock } = await startSessionWithKeywords([CONCERT]);

  typeInKeywordEntry(elements, 'Conc');
  pressInKeywordEntry(elements, 'Enter');

  const body = await applyBody(elements, fetchMock);
  assert.equal(body.lat, 40.7128);
  assert.equal(body.locatedKeyword, 'concert');
});

test('removing a located keyword\'s chip leaves the pin and the file name alone', async () => {
  const { elements, fetchMock } = await startSessionWithKeywords([CONCERT]);

  pickKeyword(elements, 'concert');
  removeKeywordChip(elements, 'concert');

  assert.deepEqual(chipKeywords(elements), []);
  const body = await applyBody(elements, fetchMock);
  assert.equal(body.lat, 40.7128);
  assert.equal(body.locatedKeyword, 'concert', 'only moving the pin changes the file name');
});

test('moving the pin by hand after picking a located keyword falls back to the reverse-geocoded file name', async () => {
  const { elements, fetchMock, created } = await startSessionWithKeywords([CONCERT]);

  pickKeyword(elements, 'concert');
  created.maps[0]._simulateClick(41, -73);

  const body = await applyBody(elements, fetchMock);
  assert.equal(body.lat, 41);
  assert.equal(body.locatedKeyword, '');
  assert.deepEqual(chipKeywords(elements), ['concert'], 'the keyword itself stays on the photo');
});

test('the last-picked located keyword names the file when several are picked', async () => {
  const dublin = { name: 'Dublin', location: { lat: 53.35, lon: -6.26, alt: 5 } };
  const { elements, fetchMock } = await startSessionWithKeywords([CONCERT, dublin]);

  pickKeyword(elements, 'concert');
  pickKeyword(elements, 'Dublin');

  assert.deepEqual(chipKeywords(elements), ['concert', 'Dublin']);
  const body = await applyBody(elements, fetchMock);
  assert.equal(body.lat, 53.35);
  assert.equal(body.locatedKeyword, 'Dublin');
});

test('a new photo starts with no located keyword naming its file', async () => {
  const { elements, fetchMock } = await startSessionWithKeywords([CONCERT]);

  pickKeyword(elements, 'concert');
  click(elements['skip-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/photo/skip', photoResponse(1));
  await flushMicrotasks();

  const body = await applyBody(elements, fetchMock);
  assert.equal(body.locatedKeyword, '');
});

test('"Save pin as located keyword" requires a pin and a name', async () => {
  const { elements, fetchMock, created } = await startSessionWithKeywords([]);

  elements['located-keyword-name-input'].value = 'Pachacaid';
  click(elements['save-located-keyword-button']);
  await flushMicrotasks();
  assert.equal(elements['located-keyword-error'].hidden, false);
  assert.match(elements['located-keyword-error'].textContent, /Drop a pin/);

  created.maps[0]._simulateClick(43.19, 6.47);
  fetchMock.resolveMatching('/api/elevation', { ok: true, alt: 65 });
  await flushMicrotasks();
  elements['located-keyword-name-input'].value = '  ';
  click(elements['save-located-keyword-button']);
  await flushMicrotasks();
  assert.match(elements['located-keyword-error'].textContent, /name/);

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

  openKeywordSuggestions(elements);
  assert.match(elements['keyword-suggestions'].innerHTML, /📍<\/span>[^<]*<span[^>]*>[^<]*<\/span>Pachacaid/);
  assert.equal(elements['located-keyword-name-input'].value, '');
});

test('saving the pin under a plain keyword\'s name makes it a located keyword', async () => {
  const { elements, fetchMock, created } = await startSessionWithKeywords([{ name: 'beach', location: null }]);

  created.maps[0]._simulateClick(1, 2);
  fetchMock.resolveMatching('/api/elevation', { ok: true, alt: 3 });
  await flushMicrotasks();
  elements['located-keyword-name-input'].value = 'beach';
  click(elements['save-located-keyword-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords/location', [{ name: 'beach', location: { lat: 1, lon: 2, alt: 3 } }]);
  await flushMicrotasks();

  openKeywordSuggestions(elements);
  assert.match(elements['keyword-suggestions'].innerHTML, /📍<\/span>[^<]*<span[^>]*>[^<]*<\/span>beach/);
});

test('saving keeps a keyword only on this photo\'s field among the known keywords', async () => {
  const { elements, fetchMock, created } = await startSessionWithKeywords([], { keywords: ['archive'] });

  created.maps[0]._simulateClick(1, 2);
  fetchMock.resolveMatching('/api/elevation', { ok: true, alt: 3 });
  await flushMicrotasks();
  elements['located-keyword-name-input'].value = 'Home';
  click(elements['save-located-keyword-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords/location', [{ name: 'Home', location: { lat: 1, lon: 2, alt: 3 } }]);
  await flushMicrotasks();

  removeKeywordChip(elements, 'archive');
  openKeywordSuggestions(elements);
  assert.ok(suggestionKeywords(elements).includes('archive'));
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

  assert.deepEqual(chipKeywords(app.elements), ['concert']);
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
  typeInKeywordEntry(app.elements, 'gig, concert');
  pressInKeywordEntry(app.elements, 'Enter');

  click(sameAsPrevLocation(app));

  assert.deepEqual(chipKeywords(app.elements), ['gig', 'concert']);
});

test('Location "same as previous" for a freehand pin leaves Keywords alone', async () => {
  const app = await startSessionWithKeywords([]);
  await skipToPhotoWithPrevious(app, { lat: 1, lon: 2, alt: 3 });

  click(sameAsPrevLocation(app));

  assert.deepEqual(chipKeywords(app.elements), []);
  const body = await applyBody(app.elements, app.fetchMock);
  assert.equal(body.lat, 1);
  assert.equal(body.locatedKeyword, '');
  assert.equal(body.keywordsTouched, false);
});
