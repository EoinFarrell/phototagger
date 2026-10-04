'use strict';
// Covers the "↩ Same as last" buttons for Date & time and Caption, and
// which buttons are enabled. The server records every group the previous
// Applied photo ended up with, Touched or not (issue #22), and sends it as
// `previous`; a group missing from it leaves its button disabled. Location
// and Keywords copying are covered in located-keywords.test.js and
// keywords.test.js. Loads and drives the real web/static/app.js (via
// Node's vm module against stubbed DOM/fetch).
//
// Run with: node --test web/apptest/same-as-last.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { flushMicrotasks, click, photoResponse, startSession } = require('./testutil');

const button = (app, group) => app.sameAsPrevButtons.find((b) => b.dataset.group === group);

// Applies the first photo without touching anything, and answers with the
// second photo carrying `previous`.
async function applyUntouched(app, previous) {
  click(app.elements['apply-button']);
  await flushMicrotasks();
  app.fetchMock.resolveMatching('/api/photo/apply', { ...photoResponse(1), appliedAs: 'x.jpg', previous });
  await flushMicrotasks();
}

async function lastApplyBody(app) {
  click(app.elements['apply-button']);
  await flushMicrotasks();
  return app.fetchMock.log.filter((e) => e.url.includes('/api/photo/apply')).pop().body;
}

test('after an untouched Apply, Date & time "Same as last" is enabled and copies the date and offset', async () => {
  const app = await startSession(photoResponse(0, { dateTime: '2025-06-14T10:21:00', offset: '+02:00' }));
  const sent = await lastApplyBody(app);
  assert.equal(sent.dateTimeTouched, false, 'the first photo\'s date was left alone');
  app.fetchMock.resolveMatching('/api/photo/apply', {
    ...photoResponse(1, { dateTime: '2001-01-01T00:00:00' }), appliedAs: 'x.jpg',
    previous: { dateTime: { dateTime: '2025-06-14T10:21:00', offset: '+02:00' } },
  });
  await flushMicrotasks();

  assert.equal(button(app, 'dateTime').disabled, false);
  click(button(app, 'dateTime'));

  assert.equal(app.elements['datetime-input'].value, '2025-06-14T10:21:00');
  assert.equal(app.elements['offset-input'].value, '+02:00');
  const body = await lastApplyBody(app);
  assert.equal(body.dateTime, '2025-06-14T10:21:00');
  assert.equal(body.offset, '+02:00');
  assert.equal(body.dateTimeTouched, true);
});

test('Caption "Same as last" copies the previous caption', async () => {
  const app = await startSession();
  await applyUntouched(app, { caption: { caption: 'Sandcastles' } });

  assert.equal(button(app, 'caption').disabled, false);
  click(button(app, 'caption'));

  assert.equal(app.elements['caption-input'].value, 'Sandcastles');
  const body = await lastApplyBody(app);
  assert.equal(body.caption, 'Sandcastles');
  assert.equal(body.captionTouched, true);
});

test('a group the previous photo had no value for leaves its button disabled', async () => {
  const app = await startSession();
  await applyUntouched(app, { dateTime: { dateTime: '2025-06-14T10:21:00', offset: '+02:00' } });

  assert.equal(button(app, 'dateTime').disabled, false);
  assert.equal(button(app, 'location').disabled, true);
  assert.equal(button(app, 'keywords').disabled, true);
  assert.equal(button(app, 'caption').disabled, true);
});

test('copying a date that had no offset resolves the offset from the pin instead of leaving it blank', async () => {
  const app = await startSession();
  await applyUntouched(app, { dateTime: { dateTime: '2025-06-14T10:21:00', offset: '' } });
  app.created.maps[0]._simulateClick(48.85, 2.29);
  await flushMicrotasks();
  app.fetchMock.resolveMatching('/api/elevation', { ok: true, alt: 35 });
  await flushMicrotasks();

  click(button(app, 'dateTime'));
  await flushMicrotasks();
  const req = app.fetchMock.resolveMatching('/api/timezone', { ok: true, offset: '+02:00' });
  await flushMicrotasks();

  assert.equal(req.body.dateTime, '2025-06-14T10:21:00');
  assert.equal(app.elements['offset-input'].value, '+02:00');
});
