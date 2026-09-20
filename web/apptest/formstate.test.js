'use strict';
// Coverage for GitHub issue #10 ("give the form its own state module"):
// web/static/formstate.js owns the busy flag, the Touched-field set, and
// the programmatic-write guard that web/static/app.js previously
// duplicated as ad hoc `if (x || busy) return;` checks at every call site.
//
// This loads and drives the real web/static/formstate.js (unmodified, via
// Node's vm module) through its own function interface -- no fake DOM
// required, since the module itself has no DOM dependency.
//
// Run with: node --test web/apptest/formstate.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFormStateModule } = require('./testutil');

function newState() {
  const createFormState = loadFormStateModule();
  return createFormState();
}

test('starts idle, with every group untouched', () => {
  const state = newState();
  assert.equal(state.isBusy(), false);
  ['location', 'dateTime', 'keywords', 'caption'].forEach((g) => {
    assert.equal(state.isTouched(g), false);
  });
});

test('setBusy toggles isBusy', () => {
  const state = newState();
  state.setBusy(true);
  assert.equal(state.isBusy(), true);
  state.setBusy(false);
  assert.equal(state.isBusy(), false);
});

test('touch marks only the given group as touched', () => {
  const state = newState();
  state.touch('caption');
  assert.equal(state.isTouched('caption'), true);
  assert.equal(state.isTouched('location'), false);
  assert.equal(state.isTouched('dateTime'), false);
  assert.equal(state.isTouched('keywords'), false);
});

test('resetTouched clears every group back to untouched', () => {
  const state = newState();
  state.touch('location');
  state.touch('caption');
  state.resetTouched();
  assert.equal(state.isTouched('location'), false);
  assert.equal(state.isTouched('caption'), false);
});

test('guarded() runs the wrapped handler when idle, and forwards its arguments and return value', () => {
  const state = newState();
  const calls = [];
  const handler = state.guarded((a, b) => { calls.push([a, b]); return 'ran'; });

  const result = handler(1, 2);

  assert.deepEqual(calls, [[1, 2]]);
  assert.equal(result, 'ran');
});

test('guarded() no-ops while busy', () => {
  const state = newState();
  const calls = [];
  const handler = state.guarded(() => calls.push('ran'));

  state.setBusy(true);
  handler();

  assert.deepEqual(calls, []);
});

test('guardedField() no-ops while busy, like guarded()', () => {
  const state = newState();
  const calls = [];
  const handler = state.guardedField(() => calls.push('ran'));

  state.setBusy(true);
  handler();

  assert.deepEqual(calls, []);
});

test('guardedField() no-ops during an applyProgrammaticUpdate() bracket', () => {
  const state = newState();
  const calls = [];
  const handler = state.guardedField(() => calls.push('ran'));

  state.applyProgrammaticUpdate(() => {
    handler();
  });

  assert.deepEqual(calls, [], 'a field handler must not fire for a programmatic write');
});

test('guardedField() runs normally once the programmatic bracket has closed', () => {
  const state = newState();
  const calls = [];
  const handler = state.guardedField(() => calls.push('ran'));

  state.applyProgrammaticUpdate(() => {});
  handler();

  assert.deepEqual(calls, ['ran']);
});

test('guarded() (busy-only) still fires during an applyProgrammaticUpdate() bracket', () => {
  const state = newState();
  const calls = [];
  const handler = state.guarded(() => calls.push('ran'));

  state.applyProgrammaticUpdate(() => {
    handler();
  });

  assert.deepEqual(calls, ['ran'], 'guarded() must only care about busy, not the programmatic flag');
});

test('applyProgrammaticUpdate() clears its flag even if the callback throws', () => {
  const state = newState();
  const handler = state.guardedField(() => 'ran');

  assert.throws(() => {
    state.applyProgrammaticUpdate(() => { throw new Error('boom'); });
  }, /boom/);

  assert.equal(handler(), 'ran', 'the programmatic flag must not be left stuck on after a throw');
});
