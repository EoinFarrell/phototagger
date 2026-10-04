'use strict';
// Covers the Geo filter (All / Missing GPS): an axis independent of Mode
// (All/Non-Tagged/Tagged) for reviewing photos that lack GPS data regardless
// of their tagged status -- see internal/queue's GeoFilter and
// internal/server/session.go's GeoCounts/Start. Loads and drives the real
// web/static/app.js (via Node's vm module against stubbed DOM/fetch).
//
// Run with: node --test web/apptest/geo-filter.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { flushMicrotasks, click, loadApp } = require('./testutil');

// 5 photos: 2 Tagged (1 missing GPS), 3 Non-Tagged (all missing GPS).
const STATE = {
  sourceDir: '/photos', backupDir: '/photos-backup', photoCount: 5,
  extCounts: { jpg: 5 }, subfolderCount: 0, skipped: [], remaining: 0, total: 0,
  counts: {
    'all': { 'all': 5, 'missing-gps': 4 },
    'non-tagged': { 'all': 3, 'missing-gps': 3 },
    'tagged': { 'all': 2, 'missing-gps': 1 },
  },
};

function counts(elements) {
  return {
    mode: ['non-tagged', 'tagged', 'all'].map((m) => elements[`mode-count-${m}`].textContent),
    geo: ['all', 'missing-gps'].map((g) => elements[`geo-count-${g}`].textContent),
    match: elements['start-match'].textContent,
  };
}

test('each count is what the queue would hold given the other filter\'s selection', async () => {
  const { elements, fetchMock } = loadApp();
  fetchMock.resolveMatching('/api/state', STATE);
  await flushMicrotasks();

  // Defaults: Mode Non-Tagged, Geo All.
  assert.deepEqual(counts(elements), {
    mode: [3, 2, 5], geo: [3, 3], match: 'This run will queue 3 photos.',
  });
});

test('changing either filter recounts the other and the queue size', async () => {
  const { elements, fetchMock, modeRadios, geoRadios } = loadApp();
  fetchMock.resolveMatching('/api/state', STATE);
  await flushMicrotasks();

  modeRadios.forEach((r) => { r.checked = r.value === 'tagged'; });
  elements['mode-select'].dispatchEvent({ type: 'change' });
  assert.deepEqual(counts(elements), {
    mode: [3, 2, 5], geo: [2, 1], match: 'This run will queue 2 photos.',
  });

  geoRadios.forEach((r) => { r.checked = r.value === 'missing-gps'; });
  elements['geo-select'].dispatchEvent({ type: 'change' });
  assert.deepEqual(counts(elements), {
    mode: [3, 1, 4], geo: [2, 1], match: 'This run will queue 1 photo.',
  });
});

test('clicking Start sends the selected Mode and Geo filter to /api/start', async () => {
  const { elements, fetchMock, geoRadios } = loadApp();

  geoRadios.forEach((r) => { r.checked = r.value === 'missing-gps'; });

  click(elements['start-button']);
  await flushMicrotasks();

  const body = fetchMock.log.find((e) => e.url.includes('/api/start')).body;
  assert.equal(body.mode, 'non-tagged', 'mode radio default (non-tagged) should still be sent');
  assert.equal(body.geo, 'missing-gps');
});
