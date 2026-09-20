'use strict';
// Regression test for GitHub issue #2 ("Fix altitude always saved as 0").
//
// Root cause: two independent bugs, both on the same LocationTouched path
// as issue #1:
//
//  1. The elevation lookup triggered by dropping a pin writes
//     $('altitude-input').value whenever its response arrives, with no
//     check that the pin/photo it was looked up for is still the one on
//     screen. A pin dropped, then replaced by a second pin (or a
//     favourite, or a manual edit, or a photo change) before the first
//     lookup resolves, could have its correct value silently clobbered by
//     the earlier, now-stale response. (As of issue #12, the cancellation
//     token this depends on is owned by web/static/formstate.js's
//     requestElevation()/invalidateElevation(), not a raw counter here.)
//  2. save-favourite-button read the altitude via
//     `parseFloat(...) || 0`, so saving a favourite before its elevation
//     lookup had resolved (very easy to do -- drop a pin, immediately name
//     and save it) silently baked in 0 as that favourite's permanent
//     stored altitude, forever after.
//
// This loads and drives the real web/static/app.js (unmodified, via Node's
// vm module against stubbed DOM/Leaflet/fetch) to prove the fix holds
// against the actual shipped code.
//
// Run with: node --test web/apptest/altitude.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { flushMicrotasks, click, photoResponse, startSession, loadApp } = require('./testutil');

test('a stale elevation lookup for a superseded pin does not clobber the current altitude', async () => {
  const { elements, fetchMock, created } = await startSession();

  // Drop a pin, then immediately drop a second one before the first
  // lookup's response arrives -- exactly the window the old code left
  // unguarded.
  created.maps[0]._simulateClick(1, 2);
  created.maps[0]._simulateClick(3, 4);
  await flushMicrotasks();

  const elevationRequests = fetchMock.pending.filter((e) => e.url.includes('/api/elevation') && !e.settled);
  assert.equal(elevationRequests.length, 2, 'expected both pin drops to trigger their own elevation lookup');

  // Resolve the SECOND (current) pin's lookup first, then the stale first
  // one -- real network responses can arrive in either order.
  elevationRequests[1].resolve({ ok: true, json: async () => ({ ok: true, alt: 42 }) });
  await flushMicrotasks();
  assert.equal(elements['altitude-input'].value, 42, 'the current pin\'s own lookup result should be shown');

  elevationRequests[0].resolve({ ok: true, json: async () => ({ ok: true, alt: 999 }) });
  await flushMicrotasks();
  assert.equal(
    elements['altitude-input'].value, 42,
    'a stale lookup from the superseded pin must not overwrite the current altitude',
  );

  click(elements['apply-button']);
  await flushMicrotasks();
  const body = fetchMock.log.find((e) => e.url.includes('/api/photo/apply')).body;
  assert.equal(body.alt, 42);
});

test('a stale elevation lookup arriving after the next photo has loaded is ignored', async () => {
  const { elements, fetchMock, created } = await startSession();

  created.maps[0]._simulateClick(1, 2);
  click(elements['apply-button']);
  await flushMicrotasks();

  const staleElevation = fetchMock.pending.find((e) => e.url.includes('/api/elevation') && !e.settled);
  assert.ok(staleElevation, 'expected the pin drop to have started an elevation lookup');

  fetchMock.resolveMatching('/api/photo/apply', {
    done: false, index: 1, total: 3, relPath: 'photo1.jpg', ext: 'jpg', isHeic: false,
    existing: {}, previous: {}, previewUrl: '/api/photo/preview',
  });
  await flushMicrotasks();

  // Now the stale response for photo 0's pin finally lands.
  staleElevation.resolve({ ok: true, json: async () => ({ ok: true, alt: 777 }) });
  await flushMicrotasks();

  assert.equal(
    elements['altitude-input'].value, '',
    'a lookup from the previous photo must not populate the new photo\'s altitude field',
  );
});

test('saving a favourite before its elevation lookup resolves is refused, not silently saved as 0', async () => {
  const { elements, fetchMock, created } = await startSession();

  created.maps[0]._simulateClick(1, 2);
  elements['favourite-name-input'].value = 'Home';
  click(elements['save-favourite-button']);
  await flushMicrotasks();

  assert.equal(
    fetchMock.countPending('/api/favourites'),
    0,
    'must not save a favourite while its altitude is still unresolved',
  );

  fetchMock.resolveMatching('/api/elevation', { ok: true, alt: 88 });
  await flushMicrotasks();
  assert.equal(elements['altitude-input'].value, 88);

  click(elements['save-favourite-button']);
  await flushMicrotasks();
  const body = fetchMock.log.find((e) => e.url.includes('/api/favourites') && e.method === 'POST').body;
  assert.equal(body.alt, 88, 'the favourite must be saved with its real resolved altitude, not 0');
});

test('a manual altitude edit survives a stale elevation lookup that resolves afterwards', async () => {
  const { elements, fetchMock, created } = await startSession();

  // Drop a pin (starts a lookup), then immediately overwrite it by hand
  // before that lookup resolves.
  created.maps[0]._simulateClick(1, 2);
  elements['altitude-input'].value = '75';
  elements['altitude-input'].dispatchEvent({ type: 'input', target: elements['altitude-input'] });

  fetchMock.resolveMatching('/api/elevation', { ok: true, alt: 999 });
  await flushMicrotasks();

  assert.equal(
    elements['altitude-input'].value, '75',
    'a manual edit must not be overwritten by a lookup that was already stale when it resolved',
  );

  click(elements['apply-button']);
  await flushMicrotasks();
  const body = fetchMock.log.find((e) => e.url.includes('/api/photo/apply')).body;
  assert.equal(body.locationTouched, true);
  assert.equal(body.alt, 75, 'the manually-typed altitude must be what gets sent to Apply');
});

test('selecting a favourite is not clobbered by a still-pending elevation lookup from an earlier pin', async () => {
  const app = loadApp();
  const { elements, fetchMock, created } = app;

  click(elements['start-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/start', { ok: true });
  await flushMicrotasks();
  // A favourite already exists with a real, non-zero stored altitude.
  fetchMock.resolveMatching('/api/favourites', [{ name: 'Home', lat: 50, lon: 60, alt: 150 }]);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/photo/current', photoResponse(0));
  await flushMicrotasks();

  // Drop a pin first, so its elevation lookup is still in flight...
  created.maps[0]._simulateClick(1, 2);
  const pinElevation = fetchMock.pending.find((e) => e.url.includes('/api/elevation') && !e.settled);
  assert.ok(pinElevation);

  // ...then pick the favourite before that lookup resolves.
  elements['favourite-select'].dispatchEvent({ type: 'change', target: { value: 'Home' } });
  assert.equal(elements['altitude-input'].value, 150, 'the favourite\'s own altitude should be shown immediately');

  // The stale pin lookup finally lands.
  pinElevation.resolve({ ok: true, json: async () => ({ ok: true, alt: 5 }) });
  await flushMicrotasks();

  assert.equal(
    elements['altitude-input'].value, 150,
    'the favourite\'s altitude must not be clobbered by the earlier pin\'s stale lookup',
  );

  click(elements['apply-button']);
  await flushMicrotasks();
  const body = fetchMock.log.find((e) => e.url.includes('/api/photo/apply')).body;
  assert.equal(body.alt, 150);
});
