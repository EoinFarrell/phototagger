'use strict';
// Coverage for GitHub issue #8's keyboard-shortcuts half (Pico CSS adoption
// is a pure styling change with nothing to unit test): Enter triggers Apply,
// ArrowRight/ArrowLeft trigger Skip/Prev, none of the three fire while a
// request is already in flight, and none of them interfere with typing in
// the caption/keywords text fields.
//
// This loads and drives the real web/static/app.js (unmodified, via Node's
// vm module against stubbed DOM/Leaflet/fetch) to prove the behaviour holds
// against the actual shipped code.
//
// Run with: node --test web/apptest/keyboard-shortcuts.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { flushMicrotasks, keydown, photoResponse, startSession } = require('./testutil');

test('Enter with focus outside a free-text field triggers Apply', async () => {
  const { elements, fetchMock, document } = await startSession();

  keydown(document, 'Enter', elements['datetime-input']);
  await flushMicrotasks();

  assert.equal(fetchMock.countPending('/api/photo/apply'), 1);
});

test('Enter with no particular focus target (e.g. focus on body) triggers Apply', async () => {
  const { fetchMock, document } = await startSession();

  keydown(document, 'Enter', undefined);
  await flushMicrotasks();

  assert.equal(fetchMock.countPending('/api/photo/apply'), 1);
});

test('ArrowRight triggers Skip and ArrowLeft triggers Prev', async () => {
  const { fetchMock, document } = await startSession();

  keydown(document, 'ArrowRight', undefined);
  await flushMicrotasks();
  assert.equal(fetchMock.countPending('/api/photo/skip'), 1);

  fetchMock.resolveMatching('/api/photo/skip', photoResponse(1));
  await flushMicrotasks();

  keydown(document, 'ArrowLeft', undefined);
  await flushMicrotasks();
  assert.equal(fetchMock.countPending('/api/photo/prev'), 1);
});

test('none of the three shortcuts fire while a request is already in flight', async () => {
  const { elements, fetchMock, document } = await startSession();

  keydown(document, 'Enter', undefined);
  await flushMicrotasks();
  assert.equal(fetchMock.countPending('/api/photo/apply'), 1, 'sanity: the first Enter did fire Apply');
  assert.equal(elements['apply-button'].disabled, true, 'busy flag should now be set');

  keydown(document, 'Enter', undefined);
  keydown(document, 'ArrowRight', undefined);
  keydown(document, 'ArrowLeft', undefined);
  await flushMicrotasks();

  assert.equal(fetchMock.countPending('/api/photo/apply'), 1, 'a second Enter while busy must not fire another Apply');
  assert.equal(fetchMock.countPending('/api/photo/skip'), 0, 'ArrowRight must not fire Skip while busy');
  assert.equal(fetchMock.countPending('/api/photo/prev'), 0, 'ArrowLeft must not fire Prev while busy');
});

test('Enter while typing in the caption field does not trigger Apply', async () => {
  const { elements, fetchMock, document } = await startSession();

  keydown(document, 'Enter', elements['caption-input']);
  await flushMicrotasks();

  assert.equal(fetchMock.countPending('/api/photo/apply'), 0);
});

test('Enter while typing in the keywords field does not trigger Apply', async () => {
  const { elements, fetchMock, document } = await startSession();

  keydown(document, 'Enter', elements['keywords-input']);
  await flushMicrotasks();

  assert.equal(fetchMock.countPending('/api/photo/apply'), 0);
});

test('ArrowRight/ArrowLeft while focus is in a text field do not trigger Skip/Prev', async () => {
  const { elements, fetchMock, document } = await startSession();

  keydown(document, 'ArrowRight', elements['keywords-input']);
  keydown(document, 'ArrowLeft', elements['caption-input']);
  keydown(document, 'ArrowRight', elements['datetime-input']);
  await flushMicrotasks();

  assert.equal(fetchMock.countPending('/api/photo/skip'), 0);
  assert.equal(fetchMock.countPending('/api/photo/prev'), 0);
});

test('Enter while focus is on a button (e.g. the just-clicked Skip button) does not fire Apply, leaving the button its native Enter-activates-focus behavior', async () => {
  const { elements, fetchMock, document } = await startSession();

  keydown(document, 'Enter', elements['skip-button']);
  keydown(document, 'Enter', elements['prev-button']);
  await flushMicrotasks();

  assert.equal(fetchMock.countPending('/api/photo/apply'), 0, 'Enter on a focused button must not be hijacked into Apply');
});

test('ArrowRight/ArrowLeft while focus is in the favourite select do not hijack its own arrow-key option browsing', async () => {
  const { elements, fetchMock, document } = await startSession();

  keydown(document, 'ArrowRight', elements['favourite-select']);
  keydown(document, 'ArrowLeft', elements['favourite-select']);
  await flushMicrotasks();

  assert.equal(fetchMock.countPending('/api/photo/skip'), 0);
  assert.equal(fetchMock.countPending('/api/photo/prev'), 0);
});

test('shortcuts are inert on the start screen, before a session has begun', async () => {
  const { fetchMock, document } = await startSession();
  document.getElementById('tag-view').hidden = true;
  document.getElementById('start-view').hidden = false;

  keydown(document, 'Enter', undefined);
  keydown(document, 'ArrowRight', undefined);
  keydown(document, 'ArrowLeft', undefined);
  await flushMicrotasks();

  assert.equal(fetchMock.countPending('/api/photo/apply'), 0);
  assert.equal(fetchMock.countPending('/api/photo/skip'), 0);
  assert.equal(fetchMock.countPending('/api/photo/prev'), 0);
});
