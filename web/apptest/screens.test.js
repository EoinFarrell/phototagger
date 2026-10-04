'use strict';
// Covers the per-screen display added by issue #15's UI review: the start
// screen's one-line summary, the tagging screen's progress bar and photo
// facts, the "Save as located keyword" button and the name row it swaps
// for (issue #23), and the Done
// screen's counts and way back to the start screen. Loads and drives the
// real web/static/app.js (via Node's vm module against stubbed DOM/fetch).
//
// Run with: node --test web/apptest/screens.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { flushMicrotasks, click, loadApp, startSession, photoResponse } = require('./testutil');

const STATE = {
  sourceDir: '/photos', backupDir: '/photos-backup', photoCount: 4,
  extCounts: { jpg: 3, heic: 1 }, subfolderCount: 2, skipped: [],
  modes: { all: 4, nonTagged: 4, tagged: 0 },
  geo: { all: 4, missingGps: 2 },
};

test('the start summary leads with photo, subfolder and type counts, then the paths', async () => {
  const { elements, fetchMock } = loadApp();
  fetchMock.resolveMatching('/api/state', STATE);
  await flushMicrotasks();

  const html = elements['start-summary'].innerHTML;
  assert.match(html, /4 photos · 2 subfolders · 3 JPG, 1 HEIC/);
  assert.match(html, /\/photos<\/code>[\s\S]*\/photos-backup<\/code>/);
});

test('the start summary uses singular nouns for a count of one', async () => {
  const { elements, fetchMock } = loadApp();
  fetchMock.resolveMatching('/api/state', { ...STATE, photoCount: 1, extCounts: { jpg: 1 }, subfolderCount: 1 });
  await flushMicrotasks();

  assert.match(elements['start-summary'].innerHTML, /1 photo · 1 subfolder · 1 JPG/);
});

test('the progress bar and counter show the position in the queue', async () => {
  const { elements } = await startSession();

  assert.equal(elements['tag-progress'].textContent, '1 / 3');
  assert.equal(elements['tag-progress-bar'].value, 1);
  assert.equal(elements['tag-progress-bar'].max, 3);
});

test('the photo facts show its original EXIF date, camera and GPS status', async () => {
  const { elements } = await startSession({
    ...photoResponse(0, { dateTime: '2025-06-14T10:21:00', lat: 48.858, lon: 2.294 }),
    camera: 'Pixel 7',
  });

  assert.equal(elements['photo-facts'].textContent, 'Taken 2025-06-14 10:21:00 · Pixel 7 · Has GPS');
});

test('the photo facts say what is missing when the photo has no date, camera or GPS', async () => {
  const { elements } = await startSession();

  assert.equal(elements['photo-facts'].textContent, 'No EXIF date · No GPS');
});

test('"Save as located keyword" swaps for the name row, and a successful save swaps it back', async () => {
  const { elements, fetchMock, created } = await startSession();
  elements['save-located-keyword-row'].hidden = true; // as in index.html

  click(elements['save-located-keyword-toggle']);
  assert.equal(elements['save-located-keyword-row'].hidden, false);
  assert.equal(elements['save-located-keyword-toggle'].hidden, true);

  created.maps[0]._simulateClick(48.8584, 2.2945);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/elevation', { ok: true, alt: 35 });
  await flushMicrotasks();

  elements['located-keyword-name-input'].value = 'Eiffel Tower';
  click(elements['save-located-keyword-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords/location', [
    { name: 'Eiffel Tower', location: { lat: 48.8584, lon: 2.2945, alt: 35 } },
  ]);
  await flushMicrotasks();

  assert.equal(elements['save-located-keyword-row'].hidden, true);
  assert.equal(elements['save-located-keyword-toggle'].hidden, false);
});

test('opening the name row focuses its input', async () => {
  const { elements } = await startSession();
  let focused = false;
  elements['located-keyword-name-input'].focus = () => { focused = true; };

  click(elements['save-located-keyword-toggle']);

  assert.equal(focused, true);
});

test('Cancel swaps the name row back for the button, dropping the typed name and any error', async () => {
  const { elements } = await startSession();
  click(elements['save-located-keyword-toggle']);
  elements['located-keyword-name-input'].value = 'Eiffel';
  click(elements['save-located-keyword-button']); // no pin yet
  await flushMicrotasks();
  assert.equal(elements['located-keyword-error'].hidden, false);

  click(elements['save-located-keyword-cancel']);

  assert.equal(elements['save-located-keyword-row'].hidden, true);
  assert.equal(elements['save-located-keyword-toggle'].hidden, false);
  assert.equal(elements['located-keyword-name-input'].value, '');
  assert.equal(elements['located-keyword-error'].hidden, true);
});

test('a failed save keeps the name row open with its error under it', async () => {
  const { elements } = await startSession();
  click(elements['save-located-keyword-toggle']);
  click(elements['save-located-keyword-button']); // no pin yet
  await flushMicrotasks();

  assert.equal(elements['save-located-keyword-row'].hidden, false);
  assert.equal(elements['save-located-keyword-toggle'].hidden, true);
  assert.equal(elements['located-keyword-error'].hidden, false);
});

test('moving to the next photo swaps an open name row back for the button', async () => {
  const { elements, fetchMock } = await startSession();
  elements['save-located-keyword-row'].hidden = true;
  click(elements['save-located-keyword-toggle']);

  click(elements['skip-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/photo/skip', photoResponse(1));
  await flushMicrotasks();

  assert.equal(elements['save-located-keyword-row'].hidden, true);
  assert.equal(elements['save-located-keyword-toggle'].hidden, false);
});

async function skipToDone(app, applied) {
  click(app.elements['skip-button']);
  await flushMicrotasks();
  app.fetchMock.resolveMatching('/api/photo/skip', { done: true, total: 3, applied });
  await flushMicrotasks();
}

test('the Done screen shows how many photos were Applied and Skipped', async () => {
  const app = await startSession();
  await skipToDone(app, 1);

  assert.equal(app.elements['done-view'].hidden, false);
  assert.equal(app.elements['done-summary'].textContent, 'Applied 1 · Skipped 2 · 3 in this run');
});

test('"Back to start" returns to the start screen with fresh counts, and starting again reuses the map', async () => {
  const app = await startSession();
  const { elements, fetchMock, created } = app;
  fetchMock.resolveMatching('/api/state', STATE); // the page-load fetch
  await flushMicrotasks();
  await skipToDone(app, 0);

  click(elements['done-back-button']);
  await flushMicrotasks();
  assert.equal(elements['start-view'].hidden, false);
  assert.equal(elements['done-view'].hidden, true);
  fetchMock.resolveMatching('/api/state', { ...STATE, modes: { all: 4, nonTagged: 3, tagged: 1 } });
  await flushMicrotasks();
  assert.equal(elements['mode-count-tagged'].textContent, 1);

  click(elements['start-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/start', { ok: true });
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords', []);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/photo/current', photoResponse(0));
  await flushMicrotasks();

  assert.equal(elements['tag-view'].hidden, false);
  assert.equal(created.maps.filter((m) => m.containerId === 'map').length, 1);
});
