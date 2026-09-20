'use strict';
// Owns the guard state that keeps web/static/app.js's DOM handlers from
// racing themselves or their own programmatic field writes: the in-flight
// `busy` flag, the Touched-field set (see CONTEXT.md), and the
// programmatic-write bracket. See GitHub issue #10 -- the Touched-field and
// programmatic-write guards are load-bearing (issues #1 and #2 were caused
// by missing them), so one module owns all three behind a small interface
// instead of the ad hoc `if (x || busy) return;` copied at every call site,
// which nothing enforced a new call site would get right.
//
// `busy` itself is different, and plays two roles depending which action
// it's guarding. For Apply, it's an optimistic client-side mirror of
// internal/server/session.go's authoritative `Session.busy` lock -- see
// that field's doc comment for the full deletion-test reasoning (issue
// #11). For Skip/Prev it isn't mirroring anything: the server holds no
// lock there, so `busy` is pure click-debounce. One flag serves both
// because the visible behaviour (disable the buttons while a request is
// in flight) is identical either way -- splitting it into two flags, or
// renaming it to something Apply-specific, would invent a distinction the
// UI never needs to make.
//
// Loaded as a classic global script (same pattern as Leaflet's `L`), before
// app.js, so `createFormState` is just a global function both index.html's
// script tags and the Node test harness (web/apptest/testutil.js) can see.

const TOUCHABLE_GROUPS = ['location', 'dateTime', 'keywords', 'caption'];

function freshTouched() {
  const touched = {};
  TOUCHABLE_GROUPS.forEach((group) => { touched[group] = false; });
  return touched;
}

function createFormState() {
  let busy = false;
  let programmatic = false;
  let touched = freshTouched();

  // isBusy/setBusy read and write the busy flag described above -- for
  // Apply, that's the optimistic mirror, never the authoritative lock
  // itself, which lives server-side.
  function isBusy() { return busy; }
  function setBusy(v) { busy = v; }

  // Brackets a block of direct field writes (renderCurrent, favourite
  // selection, same-as-previous) so guardedField() below treats them as
  // programmatic rather than the user editing the field. try/finally means
  // a callback that throws still clears the flag, unlike the hand-paired
  // `settingProgrammatically = true; ...; = false;` it replaces.
  function applyProgrammaticUpdate(fn) {
    programmatic = true;
    try {
      fn();
    } finally {
      programmatic = false;
    }
  }

  // Wraps a handler so it no-ops while a navigation request is in flight.
  // For handlers that only need locking out during busy: button clicks and
  // the favourite <select>.
  function guarded(fn) {
    return (...args) => {
      if (busy) return undefined;
      return fn(...args);
    };
  }

  // Wraps a handler so it additionally no-ops during an
  // applyProgrammaticUpdate() bracket. For handlers on fields/controls that
  // are also written to programmatically (map clicks, marker drags, field
  // `input` events), so those writes aren't misread as the user touching
  // the field.
  function guardedField(fn) {
    return (...args) => {
      if (busy || programmatic) return undefined;
      return fn(...args);
    };
  }

  function touch(group) { touched[group] = true; }
  function isTouched(group) { return touched[group]; }
  function resetTouched() { touched = freshTouched(); }

  return {
    isBusy, setBusy, applyProgrammaticUpdate, guarded, guardedField,
    touch, isTouched, resetTouched,
  };
}
