'use strict';
// Regression test for GitHub issue #1 ("Fix intermittent failure to save GPS
// coordinates on Apply"). Root cause: nothing guarded against a second
// Apply/Skip/Prev firing while one was already in flight, so an overlapping
// click could race the in-progress request on the same photo. This loads
// and executes the real web/static/app.js (unmodified, via Node's vm module
// against stubbed DOM/Leaflet/fetch) to prove the fix holds against the
// actual shipped code, not a re-description of it.
//
// Run with: node --test web/apptest/app.test.js
// (Node's built-in test runner -- no extra dependencies needed.)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { flushMicrotasks, click, photoResponse, startSession } = require('./testutil');

test('a second Apply click while the first is in flight is rejected outright, not sent as a duplicate request', async () => {
  const { elements, fetchMock, created } = await startSession();

  // Drop a pin for photo 0 and click Apply.
  created.maps[0]._simulateClick(10, 20);
  click(elements['apply-button']);
  await flushMicrotasks();

  assert.equal(fetchMock.countPending('/api/photo/apply'), 1, 'expected exactly one apply request in flight');
  assert.equal(elements['apply-button'].disabled, true, 'apply-button should be disabled while the request is in flight');

  const firstBody = fetchMock.log.find((e) => e.url.includes('/api/photo/apply')).body;
  assert.equal(firstBody.locationTouched, true);
  assert.equal(firstBody.lat, 10);
  assert.equal(firstBody.lon, 20);

  // Click Apply again, and also try dropping a different pin, before the
  // first request resolves -- this is the exact window the old code left
  // unguarded.
  click(elements['apply-button']);
  created.maps[0]._simulateClick(99, 99);
  await flushMicrotasks();

  assert.equal(
    fetchMock.log.filter((e) => e.url.includes('/api/photo/apply')).length,
    1,
    'the overlapping Apply click must not have issued a second request',
  );
  assert.equal(
    created.markers[created.markers.length - 1].getLatLng().lat,
    10,
    'a map click received while busy must not move the pin',
  );

  // Resolve the first (only) apply request; the app should unlock.
  fetchMock.resolveMatching('/api/photo/apply', photoResponse(1));
  await flushMicrotasks();

  assert.equal(elements['apply-button'].disabled, false, 'apply-button should re-enable once the response arrives');

  // A fresh pin + Apply for the new current photo must reflect only this
  // photo's own data -- nothing from the blocked click above leaked through.
  created.maps[0]._simulateClick(5, 6);
  click(elements['apply-button']);
  await flushMicrotasks();

  const secondBody = fetchMock.log.filter((e) => e.url.includes('/api/photo/apply'))[1].body;
  assert.equal(secondBody.locationTouched, true);
  assert.equal(secondBody.lat, 5);
  assert.equal(secondBody.lon, 6);
});

test('a failed Apply re-enables the buttons instead of leaving the app locked', async () => {
  const { elements, fetchMock } = await startSession();

  click(elements['apply-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/photo/apply', { error: 'dateTime is required' }, { ok: false });
  await flushMicrotasks();

  assert.equal(elements['apply-button'].disabled, false, 'a failed apply must release the busy flag');
  assert.equal(elements['skip-button'].disabled, false);
  assert.equal(elements['prev-button'].disabled, false);
});

test('a network error on Skip re-enables the buttons instead of leaving the app locked', async () => {
  const { elements, fetchMock } = await startSession();

  click(elements['skip-button']);
  await flushMicrotasks();
  const entry = fetchMock.pending.find((e) => e.url.includes('/api/photo/skip'));
  entry.settled = true;
  entry.resolve(Promise.reject(new Error('network down')));
  await flushMicrotasks();

  assert.equal(elements['skip-button'].disabled, false, 'a failed skip must release the busy flag, not lock the app');
});
