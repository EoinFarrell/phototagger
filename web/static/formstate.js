'use strict';
// Owns the guard state that keeps web/static/app.js's DOM handlers from
// racing themselves, their own programmatic field writes, or a stale
// elevation lookup: the in-flight `busy` flag, the Touched-field set (see
// CONTEXT.md), the programmatic-write bracket, and the elevation-lookup
// cancellation token. See GitHub issues #10 and #12 -- all four guards are
// load-bearing (issues #1 and #2 were caused by missing them), so one
// module owns them behind a small interface instead of the ad hoc
// `if (x || busy) return;` checks and a hand-bumped `altitudeGeneration`
// counter, both copied at every call site, which nothing enforced a new
// call site would get right.
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
  // Owns the elevation-lookup cancellation token from issue #12: an
  // /api/elevation lookup takes a moment, and by the time it resolves the
  // pin/photo it was looked up for may have been superseded by a new pin, a
  // favourite pick, a same-as-prev copy, a manual edit, or a new photo
  // rendering -- any of which must stop that lookup's result from landing.
  // Previously each of those five call sites in app.js was independently
  // responsible for bumping a shared `altitudeGeneration` counter correctly
  // before checking it; missing that bump is exactly how issue #2 (altitude
  // silently saved as 0) happened. Owning the counter here means those call
  // sites only ever call invalidateElevation() or requestElevation() --
  // there's no counter left for a new call site to forget to bump.
  let elevationGeneration = 0;

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

  // Called by a caller that's setting the altitude field's meaning itself
  // (a favourite pick, a same-as-prev copy, a manual edit, a new photo
  // rendering) without needing a new lookup -- invalidates whatever lookup
  // is still in flight so it can't land afterwards and clobber this value.
  function invalidateElevation() {
    elevationGeneration++;
  }

  // Looks up (lat, lon)'s elevation and calls onResult(alt) with it, unless
  // a later requestElevation() or invalidateElevation() call has superseded
  // this one by the time the response arrives -- in which case the result
  // is silently dropped instead of overwriting whatever's there now.
  async function requestElevation(lat, lon, onResult) {
    const gen = ++elevationGeneration;
    try {
      const res = await fetch('/api/elevation', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lat, lon }),
      });
      const data = await res.json();
      if (data.ok && gen === elevationGeneration) onResult(data.alt);
    } catch (e) {
      // Offline or unreachable: leave altitude as-is rather than blocking.
    }
  }

  return {
    isBusy, setBusy, applyProgrammaticUpdate, guarded, guardedField,
    touch, isTouched, resetTouched, invalidateElevation, requestElevation,
  };
}
