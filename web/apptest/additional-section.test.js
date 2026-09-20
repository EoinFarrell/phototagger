'use strict';
// Regression coverage for GitHub issue #5 ("Collapse Altitude and UTC offset
// under an 'Additional' section by default"). Altitude and UTC offset are
// auto-filled correctly for most photos, so they now live inside a
// <details id="additional-details"> disclosure, collapsed by default, that
// the user can expand to override either value manually.
//
// The one real hazard: maybeResolveTimezone() already flags the offset
// field as required (offset-input.required = true, .required-missing class)
// when timezone resolution fails. If that field is tucked inside a
// collapsed disclosure, the disclosure must auto-expand -- and the badge on
// its <summary> must show -- so the user can't miss a genuinely-required
// field and submit an incomplete Apply.
//
// This loads and drives the real web/static/app.js (unmodified, via Node's
// vm module against stubbed DOM/Leaflet/fetch) to prove the behaviour holds
// against the actual shipped code.
//
// Run with: node --test web/apptest/additional-section.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { flushMicrotasks, click, photoResponse, startSession } = require('./testutil');

test('the Additional section starts collapsed for a freshly rendered photo', async () => {
  const { elements } = await startSession();
  assert.equal(!!elements['additional-details'].open, false);
  assert.equal(elements['additional-required-badge'].hidden, true);
});

test('editing the altitude field inside Additional is tracked as touched', async () => {
  const { elements, fetchMock } = await startSession();

  elements['altitude-input'].value = '12';
  elements['altitude-input'].dispatchEvent({ type: 'input', target: elements['altitude-input'] });

  click(elements['apply-button']);
  await flushMicrotasks();
  const body = fetchMock.log.find((e) => e.url.includes('/api/photo/apply')).body;
  assert.equal(body.locationTouched, true);
  assert.equal(body.alt, 12);
});

test('editing the UTC offset field inside Additional is tracked as touched', async () => {
  const { elements, fetchMock } = await startSession();

  elements['offset-input'].value = '+02:00';
  elements['offset-input'].dispatchEvent({ type: 'input', target: elements['offset-input'] });

  click(elements['apply-button']);
  await flushMicrotasks();
  const body = fetchMock.log.find((e) => e.url.includes('/api/photo/apply')).body;
  assert.equal(body.dateTimeTouched, true);
  assert.equal(body.offset, '+02:00');
});

test('a failed timezone resolution auto-expands Additional and shows the required badge', async () => {
  const { elements, fetchMock, created } = await startSession();

  created.maps[0]._simulateClick(53, -6);
  elements['datetime-input'].value = '2024-06-01T12:00:00';
  elements['datetime-input'].dispatchEvent({ type: 'input', target: elements['datetime-input'] });
  await flushMicrotasks();

  assert.equal(elements['additional-details'].open, false, 'must not be open before resolution fails');

  fetchMock.resolveMatching('/api/timezone', { ok: false });
  await flushMicrotasks();

  assert.equal(elements['additional-details'].open, true, 'must auto-expand once the offset becomes required');
  assert.equal(elements['additional-required-badge'].hidden, false, 'the required badge must be visible');
  assert.equal(elements['offset-input'].required, true);
  assert.ok(elements['offset-input'].classList.contains('required-missing'));
});

test('manually fixing a required offset clears the badge', async () => {
  const { elements, fetchMock, created } = await startSession();

  created.maps[0]._simulateClick(53, -6);
  elements['datetime-input'].value = '2024-06-01T12:00:00';
  elements['datetime-input'].dispatchEvent({ type: 'input', target: elements['datetime-input'] });
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/timezone', { ok: false });
  await flushMicrotasks();

  assert.equal(elements['additional-required-badge'].hidden, false);

  elements['offset-input'].value = '+01:00';
  elements['offset-input'].dispatchEvent({ type: 'input', target: elements['offset-input'] });

  assert.equal(elements['additional-required-badge'].hidden, true, 'badge must clear once the user supplies an offset');
  assert.equal(elements['offset-input'].required, false);
  assert.equal(elements['offset-input'].classList.contains('required-missing'), false);
});

test('moving to the next photo collapses Additional again and clears a stale required state', async () => {
  const { elements, fetchMock, created } = await startSession();

  created.maps[0]._simulateClick(53, -6);
  elements['datetime-input'].value = '2024-06-01T12:00:00';
  elements['datetime-input'].dispatchEvent({ type: 'input', target: elements['datetime-input'] });
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/timezone', { ok: false });
  await flushMicrotasks();

  assert.equal(elements['additional-details'].open, true, 'sanity check: required state opened it');

  elements['offset-input'].value = '+01:00'; // supply it so Apply is allowed to succeed
  elements['offset-input'].dispatchEvent({ type: 'input', target: elements['offset-input'] });

  click(elements['apply-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/photo/apply', photoResponse(1));
  await flushMicrotasks();

  assert.equal(elements['additional-details'].open, false, 'the new photo must start with Additional collapsed');
  assert.equal(elements['additional-required-badge'].hidden, true, 'no stale required badge should carry over');
  assert.equal(elements['offset-input'].required, false);
  assert.equal(elements['offset-input'].classList.contains('required-missing'), false);
});
