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

test('loadState renders the Geo counts from /api/state', async () => {
  const { elements, fetchMock } = loadApp();

  fetchMock.resolveMatching('/api/state', {
    sourceDir: '/photos', backupDir: '/photos-backup', photoCount: 5,
    extCounts: { jpg: 5 }, subfolderCount: 0, skipped: [], remaining: 0, total: 0,
    modes: { all: 5, nonTagged: 3, tagged: 2 },
    geo: { all: 5, missingGps: 4 },
  });
  await flushMicrotasks();

  assert.equal(elements['geo-count-all'].textContent, 5);
  assert.equal(elements['geo-count-missing-gps'].textContent, 4);
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
