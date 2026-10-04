'use strict';

let map, marker;
let knownKeywords = [];
let previousData = {};
// The located keyword the pin is snapped to, if any -- it names the
// renamed file (the Apply payload's locatedKeyword). Cleared by moving the
// pin by hand, not by removing the keyword from the Keywords field.
let snappedLocatedKeyword = '';
// The current photo's keywords, in order -- what the Keywords chips show
// and what Apply sends. Written only through setPhotoKeywords.
let photoKeywords = [];
// The Keywords tag input's suggestion list: whether it's open, and which
// suggestion is highlighted (-1 for none).
let suggestionsOpen = false;
let suggestionIndex = -1;
let offsetManuallyEdited = false;
// Owns the busy flag, the Touched-field set, and the programmatic-write
// guard (formerly `busy`, `touched`, `settingProgrammatically` here) behind
// a single interface -- see web/static/formstate.js.
const formState = createFormState();

const $ = (id) => document.getElementById(id);

// setBusy toggles formState's busy flag (see web/static/formstate.js for
// what it means per action) and drives its only visible effect: disabling
// the three navigation buttons.
function setBusy(v) {
  formState.setBusy(v);
  $('apply-button').disabled = v;
  $('skip-button').disabled = v;
  $('prev-button').disabled = v;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function plural(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function switchView(name) {
  // The toast belongs to the tagging run; Done keeps it so the last Apply
  // is still confirmed.
  if (name !== 'tag' && name !== 'done') hideToast();
  $('start-view').hidden = name !== 'start';
  $('tag-view').hidden = name !== 'tag';
  $('manage-view').hidden = name !== 'manage';
  $('done-view').hidden = name !== 'done';
}

// ---- Messages and the shared dialog ----

// Inline messages (issue #18): each sits next to what it's about, and is
// shown or cleared by setting its text.
function showMessage(id, text) {
  $(id).textContent = text;
  $(id).hidden = false;
}

function clearMessage(id) {
  $(id).textContent = '';
  $(id).hidden = true;
}

// The server's error text for a failed response, else its status text.
async function responseError(res) {
  const body = await res.json().catch(() => ({}));
  return body.error || res.statusText;
}

// ask() opens #ask-dialog -- the one in-page dialog behind every
// confirmation and text prompt -- and resolves once it closes. `input`
// (a starting value) adds a text field. `onConfirm(value)` runs the action
// with the dialog still open and returns an error message to show inline
// (keeping it open for another try or Cancel), or '' to close. While it
// runs, the confirm button shows Pico's aria-busy spinner and `working`
// shows as a line in the dialog -- rename and delete everywhere can take a
// while on a real library (issue #21). Cancel,
// Escape, or closing it any other way resolve without calling onConfirm --
// except while onConfirm is running, when both are held off so its result
// (success or error) is never lost.
let askPending = null;

function setAskRunning(running, working = '') {
  $('ask-confirm-button').disabled = running;
  $('ask-cancel-button').disabled = running;
  if (running) {
    $('ask-confirm-button').setAttribute('aria-busy', 'true');
    showMessage('ask-working', working);
  } else {
    $('ask-confirm-button').removeAttribute('aria-busy');
    clearMessage('ask-working');
  }
}

function ask({ title, message = '', input = null, confirmLabel, danger = false, working = 'Working…', onConfirm }) {
  if (askPending) finishAsk(); // never strand an earlier caller's promise
  $('ask-title').textContent = title;
  $('ask-message').textContent = message;
  $('ask-message').hidden = message === '';
  $('ask-input').hidden = input === null;
  $('ask-input').value = input === null ? '' : input;
  clearMessage('ask-error');
  $('ask-confirm-button').textContent = confirmLabel;
  $('ask-confirm-button').classList.toggle('danger', danger);
  $('ask-confirm-button').classList.toggle('outline', danger);
  setAskRunning(false);
  const opener = document.activeElement;
  return new Promise((resolve) => {
    askPending = { onConfirm, working, resolve, opener };
    $('ask-dialog').showModal();
    if (input !== null) $('ask-input').focus();
  });
}

function finishAsk() {
  const pending = askPending;
  askPending = null;
  if ($('ask-dialog').open) $('ask-dialog').close();
  // A row button re-rendered by the action is detached; focus falls back
  // to the page then.
  if (pending.opener && pending.opener.isConnected) pending.opener.focus();
  pending.resolve();
}

$('ask-confirm-button').addEventListener('click', async () => {
  const pending = askPending;
  if (!pending) return;
  clearMessage('ask-error');
  setAskRunning(true, pending.working);
  let error;
  try {
    error = await pending.onConfirm($('ask-input').value);
  } catch (e) {
    error = e.message;
  }
  setAskRunning(false);
  if (error) {
    showMessage('ask-error', error);
  } else {
    finishAsk();
  }
});

$('ask-cancel-button').addEventListener('click', () => {
  if (askPending) finishAsk();
});

// Enter in the text field confirms, as it would in a form.
$('ask-input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  $('ask-confirm-button').click();
});

// Escape fires cancel, then closes the <dialog> natively (bypassing the
// Cancel button); hold it off while onConfirm runs.
$('ask-dialog').addEventListener('cancel', (e) => {
  if ($('ask-cancel-button').disabled) e.preventDefault();
});
$('ask-dialog').addEventListener('close', () => {
  if (askPending) finishAsk();
});

// The tagging screen's banner, for a failed Skip/Prev/Apply. Dismissible,
// and cleared by the next navigation that succeeds.
function showTagError(text) {
  $('tag-error-message').textContent = text;
  $('tag-error').hidden = false;
}

function clearTagError() {
  $('tag-error').hidden = true;
}

$('tag-error-dismiss').addEventListener('click', clearTagError);

// ---- Start screen ----

async function loadState() {
  const res = await fetch('/api/state');
  const data = await res.json();

  const extLine = Object.entries(data.extCounts).map(([ext, count]) => `${count} ${ext.toUpperCase()}`).join(', ') || 'no photos';
  let html = `<p id="start-counts">${plural(data.photoCount, 'photo')} · ${plural(data.subfolderCount, 'subfolder')} · ${extLine}</p>`;
  html += `<p class="start-path"><small>Source <code>${escapeHtml(data.sourceDir)}</code></small></p>`;
  html += `<p class="start-path"><small>Backup <code>${escapeHtml(data.backupDir)}</code></small></p>`;
  if (data.skipped && data.skipped.length) {
    html += `<details><summary>${plural(data.skipped.length, 'skipped/non-applicable file')}</summary>` +
      `<ul id="skipped-list">${data.skipped.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul></details>`;
  }
  $('start-summary').innerHTML = html;

  const modes = data.modes || { all: 0, nonTagged: 0, tagged: 0 };
  $('mode-count-all').textContent = modes.all;
  $('mode-count-non-tagged').textContent = modes.nonTagged;
  $('mode-count-tagged').textContent = modes.tagged;

  const geo = data.geo || { all: 0, missingGps: 0 };
  $('geo-count-all').textContent = geo.all;
  $('geo-count-missing-gps').textContent = geo.missingGps;

  // A Mode with zero matching photos is still a valid choice -- it just
  // goes straight to the Done state -- so this only guards against there
  // being nothing in the source directory at all.
  $('start-button').disabled = data.photoCount === 0;
}

$('start-button').addEventListener('click', async () => {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const geo = document.querySelector('input[name="geo"]:checked').value;
  await fetch('/api/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, geo }),
  });
  switchView('tag');
  // A second run (via the Done screen's "Back to start") reuses the map:
  // Leaflet refuses to initialise the same container twice.
  if (map) {
    map.invalidateSize();
  } else {
    initMap();
  }
  await loadKeywords();
  const res = await fetch('/api/photo/current');
  renderCurrent(await res.json());
});

// ---- Map ----

// Both maps (the tagging form's and the manage-view's location editor)
// share one starting view and tile source.
function createMap(containerId) {
  const m = L.map(containerId).setView([53.35, -6.26], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(m);
  return m;
}

function initMap() {
  map = createMap('map');
  map.on('click', formState.guardedField((e) => {
    setMarker(e.latlng.lat, e.latlng.lng);
    onManualPin(e.latlng.lat, e.latlng.lng);
  }));
}

function setMarker(lat, lon) {
  if (marker) {
    marker.setLatLng([lat, lon]);
  } else {
    marker = L.marker([lat, lon], { draggable: true }).addTo(map);
    marker.on('dragend', formState.guardedField(() => {
      const ll = marker.getLatLng();
      onManualPin(ll.lat, ll.lng);
    }));
  }
  map.setView([lat, lon], Math.max(map.getZoom(), 12));
}

function clearMarker() {
  if (marker) {
    map.removeLayer(marker);
    marker = null;
  }
}

function onManualPin(lat, lon) {
  formState.touch('location');
  snappedLocatedKeyword = '';
  offsetManuallyEdited = false;
  formState.requestElevation(lat, lon, (alt) => { $('altitude-input').value = alt; });
  maybeResolveTimezone();
}

// Offset is a real "you must fill this in" state when timezone resolution
// fails -- it lives inside the collapsed #additional-details disclosure, so
// going required also force-expands the disclosure and shows the summary
// badge, or the user could miss it and submit an incomplete Apply.
function setOffsetRequired(missing) {
  const offsetInput = $('offset-input');
  offsetInput.required = missing;
  if (missing) {
    offsetInput.classList.add('required-missing');
    $('additional-required-badge').hidden = false;
    $('additional-details').open = true;
  } else {
    offsetInput.classList.remove('required-missing');
    $('additional-required-badge').hidden = true;
  }
}

async function maybeResolveTimezone() {
  if (!marker || offsetManuallyEdited) return;
  const dtVal = $('datetime-input').value;
  if (!dtVal) return;
  const ll = marker.getLatLng();
  const offsetInput = $('offset-input');
  try {
    const res = await fetch('/api/timezone', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: ll.lat, lon: ll.lng, dateTime: dtVal }),
    });
    const data = await res.json();
    if (data.ok) {
      offsetInput.value = data.offset;
      setOffsetRequired(false);
    } else {
      setOffsetRequired(true);
    }
  } catch (e) {
    // Offline: leave the offset field as-is (still editable manually).
  }
}

// ---- Keywords ----

async function loadKeywords() {
  const res = await fetch('/api/keywords');
  knownKeywords = await res.json();
  renderKeywords();
}

// Replaces knownKeywords with the server's list (as returned by every
// keyword-changing endpoint), keeping any keyword only on the current
// photo -- e.g. from an unApplied photo's existing EXIF -- which the
// server's keywords.json doesn't know about yet.
function replaceKnownKeywords(list) {
  knownKeywords = list;
  mergeKnownKeywords(photoKeywords);
  renderKeywords();
}

// Sets kw's Location via POST /api/keywords/location (creating kw if it's
// new), writing immediately rather than waiting for Apply. Returns an error
// message for the caller to show, or '' on success.
async function saveKeywordLocation(kw, lat, lon, alt) {
  const res = await fetch('/api/keywords/location', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword: kw, lat, lon, alt }),
  });
  if (!res.ok) return `Couldn't save the location for "${kw}": ${await responseError(res)}`;
  replaceKnownKeywords(await res.json());
  return '';
}

function findKnownKeyword(kw) {
  return knownKeywords.find((k) => k.name === kw);
}

// ---- Keyword tag input ----
//
// The photo's keywords show as chips (each with a × to remove it) ahead of
// a text entry. Clicking into the entry, typing, or ArrowDown opens a list
// of known keywords not already on the photo, filtered by the typed text,
// located keywords first. Keys in the entry:
//   Enter or ,  adds the highlighted suggestion, else the typed text
//   ArrowDown/ArrowUp move the highlight
//   Backspace   in an empty entry removes the last chip
//   Escape      closes the list (so Enter then adds exactly what's typed)
// Typing highlights the first suggestion the text starts, so "eif" + Enter
// picks "Eiffel Tower"; a mid-word match isn't highlighted. Typed text that
// matches a known keyword in another case adds the known keyword. Renaming
// or deleting a keyword, and editing its Location, live on the manage-view.

// The entry's comma-separated parts; the last is the one being typed.
function entryParts() {
  return $('keyword-entry').value.split(',');
}

function entryFragment() {
  return entryParts().pop().trim().toLowerCase();
}

function currentSuggestions() {
  const fragment = entryFragment();
  const onPhoto = new Set(photoKeywords);
  const matches = knownKeywords.filter((k) => !onPhoto.has(k.name) && k.name.toLowerCase().includes(fragment));
  return [...matches.filter((k) => k.location), ...matches.filter((k) => !k.location)];
}

function highlightedSuggestion() {
  if (!suggestionsOpen) return null;
  const s = currentSuggestions()[suggestionIndex];
  return s ? s.name : null;
}

// The pin is decorative for screen readers, which hear "located keyword".
function keywordLabel(name) {
  const known = findKnownKeyword(name);
  const located = known && known.location
    ? '<span class="keyword-pin" aria-hidden="true">📍</span><span class="visually-hidden">located keyword </span>'
    : '';
  return located + escapeHtml(name);
}

function renderKeywords() {
  $('keyword-chips').innerHTML = photoKeywords.map((kw) => {
    const esc = escapeHtml(kw);
    return `<span class="keyword-chip">${keywordLabel(kw)}` +
      `<button type="button" class="keyword-chip-remove" data-keyword="${esc}" aria-label="Remove ${esc}">×</button></span>`;
  }).join('');

  const suggestions = currentSuggestions();
  if (suggestionIndex >= suggestions.length) suggestionIndex = suggestions.length - 1;
  const show = suggestionsOpen && suggestions.length > 0;
  $('keyword-suggestions').innerHTML = suggestions.map((k, i) => {
    const active = i === suggestionIndex;
    return `<li role="option" id="keyword-option-${i}" class="keyword-suggestion${active ? ' active' : ''}" ` +
      `aria-selected="${active}" data-keyword="${escapeHtml(k.name)}">${keywordLabel(k.name)}</li>`;
  }).join('');
  $('keyword-suggestions').hidden = !show;
  $('keyword-entry').setAttribute('aria-expanded', String(show));
  if (show && suggestionIndex >= 0) {
    $('keyword-entry').setAttribute('aria-activedescendant', `keyword-option-${suggestionIndex}`);
  } else {
    $('keyword-entry').removeAttribute('aria-activedescendant');
  }
}

// The one writer of photoKeywords. `touched` marks Keywords as Touched;
// rename/delete everywhere and a new photo pass false.
function setPhotoKeywords(list, { touched }) {
  photoKeywords = list;
  if (touched) formState.touch('keywords');
  renderKeywords();
}

// Empties the entry and closes the list.
function resetKeywordEntry() {
  $('keyword-entry').value = '';
  suggestionsOpen = false;
  suggestionIndex = -1;
}

// The known keyword typed text names, ignoring case, else the text itself.
function resolveKeyword(text) {
  const lower = text.toLowerCase();
  const known = knownKeywords.find((k) => k.name.toLowerCase() === lower);
  return known ? known.name : text;
}

// Adding a located keyword also snaps the map to its Location and makes it
// the file's name -- but only on add: removing one leaves the map
// untouched, since removing a keyword says nothing about where the photo
// actually is.
function addKeywords(names) {
  const added = names.map(resolveKeyword).filter((kw, i, all) => !photoKeywords.includes(kw) && all.indexOf(kw) === i);
  if (!added.length) return;
  added.forEach((kw) => {
    const known = findKnownKeyword(kw);
    if (!known || !known.location) return;
    const loc = known.location;
    formState.applyProgrammaticUpdate(() => setMarker(loc.lat, loc.lon));
    formState.invalidateElevation();
    $('altitude-input').value = loc.alt;
    snappedLocatedKeyword = known.name;
    offsetManuallyEdited = false;
    formState.touch('location');
    maybeResolveTimezone();
  });
  $('keyword-status').textContent = `Added ${added.join(', ')}`;
  setPhotoKeywords([...photoKeywords, ...added], { touched: true });
}

function removeKeyword(kw) {
  $('keyword-status').textContent = `Removed ${kw}`;
  setPhotoKeywords(photoKeywords.filter((k) => k !== kw), { touched: true });
}

// Adds what's typed (comma-separated, so a pasted list adds each), with
// the highlighted suggestion, if any, standing in for the part still being
// typed -- what Enter, comma and Apply all do.
function commitKeywordEntry() {
  const parts = entryParts();
  const picked = highlightedSuggestion();
  if (picked !== null) parts.pop();
  const names = parseKeywords(parts.join(','));
  if (picked !== null) names.push(picked);
  $('keyword-entry').value = '';
  suggestionIndex = -1;
  addKeywords(names);
}

// Adds a clicked suggestion, after any earlier comma-separated parts.
function pickSuggestion(name) {
  const parts = entryParts();
  parts.pop();
  $('keyword-entry').value = '';
  suggestionIndex = -1;
  addKeywords([...parseKeywords(parts.join(',')), name]);
}

function openSuggestions() {
  suggestionsOpen = true;
  renderKeywords();
}

$('keyword-entry').addEventListener('click', formState.guardedField(openSuggestions));
$('keyword-entry').addEventListener('blur', () => {
  suggestionsOpen = false;
  suggestionIndex = -1;
  renderKeywords();
});

$('keyword-entry').addEventListener('input', formState.guardedField(() => {
  suggestionsOpen = true;
  const fragment = entryFragment();
  suggestionIndex = fragment === ''
    ? -1
    : currentSuggestions().findIndex((k) => k.name.toLowerCase().startsWith(fragment));
  renderKeywords();
}));

$('keyword-entry').addEventListener('keydown', formState.guardedField((e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const count = currentSuggestions().length;
    suggestionsOpen = true;
    suggestionIndex = e.key === 'ArrowDown'
      ? Math.min(suggestionIndex + 1, count - 1)
      : Math.max(suggestionIndex - 1, 0);
    renderKeywords();
  } else if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    commitKeywordEntry();
    renderKeywords();
  } else if (e.key === 'Backspace' && $('keyword-entry').value === '' && photoKeywords.length) {
    e.preventDefault();
    removeKeyword(photoKeywords[photoKeywords.length - 1]);
  } else if (e.key === 'Escape') {
    suggestionsOpen = false;
    suggestionIndex = -1;
    renderKeywords();
  }
}));

// Keeps focus in the entry while a suggestion is clicked (a blur would
// close the list before the click lands).
$('keyword-suggestions').addEventListener('mousedown', (e) => e.preventDefault());
$('keyword-suggestions').addEventListener('click', formState.guarded((e) => {
  const opt = e.target.closest('.keyword-suggestion');
  if (opt) pickSuggestion(opt.dataset.keyword);
}));

// Re-rendering the chips destroys the focused × button, so focus moves to
// the entry rather than falling back to the page.
$('keyword-chips').addEventListener('click', formState.guarded((e) => {
  const btn = e.target.closest('.keyword-chip-remove');
  if (!btn) return;
  removeKeyword(btn.dataset.keyword);
  $('keyword-entry').focus();
}));

// Clicking the field's empty space focuses the entry, as in a real input.
$('keyword-field').addEventListener('click', (e) => {
  if (e.target === $('keyword-field')) $('keyword-entry').focus();
});

// Optimistic local mirror of the server's keywords.json (updated on Apply,
// see internal/server/session.go's Apply) -- keeps a keyword Applied this
// session among the suggestions immediately, without a round trip. A
// keyword merged in this way never carries a Location -- that's only ever
// set through POST /api/keywords/location.
function mergeKnownKeywords(kws) {
  let changed = false;
  kws.forEach((kw) => {
    if (!findKnownKeyword(kw)) {
      knownKeywords.push({ name: kw, location: null });
      changed = true;
    }
  });
  if (changed) renderKeywords();
}

// Deletes kw from the known-keywords list and strips it from every photo in
// the source directory that currently has it (not just the one on screen),
// via DELETE /api/keywords -- see internal/server/session.go's
// DeleteKeyword. Confirmed first in the dialog since, unlike the rest of
// this form, it writes to disk immediately rather than waiting for Apply.
// Called from the manage-view's "Delete" button (see "---- Keyword
// management ----" below).
function deleteKeyword(kw) {
  return ask({
    title: `Delete "${kw}"?`,
    message: "This removes it from every photo in this folder that has it, not just this one, and can't be undone from here.",
    confirmLabel: 'Delete',
    danger: true,
    working: `Removing "${kw}" from every photo that has it…`,
    onConfirm: async () => {
      const res = await fetch('/api/keywords', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: kw }),
      });
      if (!res.ok) return `Couldn't delete "${kw}": ${await responseError(res)}`;
      dropKnownKeyword(kw);
      return '';
    },
  });
}

function dropKnownKeyword(kw) {
  // Filter locally rather than replacing knownKeywords with the server's
  // response: the server's keywords.json only has what's been Applied, but
  // knownKeywords also carries keywords merged in from an unApplied photo's
  // existing EXIF (mergeKnownKeywords, above) -- replacing wholesale would
  // drop those too, not just kw.
  knownKeywords = knownKeywords.filter((k) => k.name !== kw);
  // The file(s) on disk are already fixed by the server; mirror that in the
  // current field without marking keywords touched -- this isn't the user
  // editing this photo's keywords, just the display catching up.
  formState.applyProgrammaticUpdate(() => {
    setPhotoKeywords(photoKeywords.filter((k) => k !== kw), { touched: false });
  });
  if (editingKeyword === kw) closeLocationEditor();
  renderManageKeywordsList();
}

// Renames kw to a new name everywhere -- every photo in the folder carrying
// it, and the known-keywords list itself (preserving its Location) -- via
// POST /api/keywords/rename (internal/server/session.go's RenameKeyword).
// Asks for the new name in the dialog rather than an inline editable field
// per row. A blank name is refused inline; an unchanged one just closes.
function renameKeyword(kw) {
  return ask({
    title: `Rename "${kw}"`,
    input: kw,
    confirmLabel: 'Rename',
    working: `Renaming "${kw}" in every photo that has it…`,
    onConfirm: async (value) => {
      const newName = value.trim();
      if (newName === '') return 'Enter a name.';
      if (newName === kw) return '';
      const res = await fetch('/api/keywords/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldKeyword: kw, newKeyword: newName }),
      });
      if (!res.ok) return `Couldn't rename "${kw}": ${await responseError(res)}`;
      applyRenameLocally(kw, newName, await res.json());
      return '';
    },
  });
}

function applyRenameLocally(kw, newName, renamed) {
  // If the current photo still has the old name queued (not yet Applied),
  // carry the rename onto it too, rather than leaving a now-nonexistent
  // keyword on it. Done before replaceKnownKeywords, which would otherwise
  // merge the old name back in.
  formState.applyProgrammaticUpdate(() => {
    setPhotoKeywords(photoKeywords.map((k) => (k === kw ? newName : k)), { touched: false });
  });
  replaceKnownKeywords(renamed);
  if (editingKeyword === kw) closeLocationEditor();
  renderManageKeywordsList();
}

// The name row is rarely needed, so it stays behind a button under the map
// and takes that button's place while open -- only one of the two shows at
// a time. A save, Cancel or the next photo swap the button back.
function openSaveLocatedKeywordRow() {
  $('save-located-keyword-toggle').hidden = true;
  $('save-located-keyword-row').hidden = false;
  clearMessage('located-keyword-error');
  $('located-keyword-name-input').focus();
}

function closeSaveLocatedKeywordRow({ refocus = true } = {}) {
  const wasOpen = !$('save-located-keyword-row').hidden;
  $('save-located-keyword-row').hidden = true;
  $('save-located-keyword-toggle').hidden = false;
  $('located-keyword-name-input').value = '';
  clearMessage('located-keyword-error');
  // The focused Save/Cancel button just disappeared.
  if (wasOpen && refocus) $('save-located-keyword-toggle').focus();
}

$('save-located-keyword-toggle').addEventListener('click', openSaveLocatedKeywordRow);
$('save-located-keyword-cancel').addEventListener('click', () => closeSaveLocatedKeywordRow());

// "Save pin as located keyword": captures the current pin (and altitude)
// as a keyword's Location -- creating the keyword if it's new, or
// (re)locating an existing one.
$('save-located-keyword-button').addEventListener('click', formState.guarded(async () => {
  if (!marker) {
    showMessage('located-keyword-error', 'Drop a pin on the map first.');
    return;
  }
  const name = $('located-keyword-name-input').value.trim();
  if (!name) {
    showMessage('located-keyword-error', 'Enter a name for this located keyword.');
    return;
  }
  const altVal = $('altitude-input').value;
  if (altVal === '') {
    showMessage('located-keyword-error', 'Altitude is still loading — wait a moment, or enter it manually, then try again.');
    return;
  }
  const ll = marker.getLatLng();
  const error = await saveKeywordLocation(name, ll.lat, ll.lng, parseFloat(altVal));
  if (error) {
    showMessage('located-keyword-error', error);
    return;
  }
  // The pin is already at the keyword's new Location, so it goes on the
  // photo and names the file, as picking it would -- minus the map snap and
  // elevation lookup.
  snappedLocatedKeyword = name;
  if (!photoKeywords.includes(name)) {
    $('keyword-status').textContent = `Added ${name}`;
    setPhotoKeywords([...photoKeywords, name], { touched: true });
  }
  closeSaveLocatedKeywordRow();
}));

// ---- Keyword management (rename/delete) ----

// Renders a row per known keyword in the manage-view: its name and a
// Rename/Delete pair. Kept as its own full-page view (reached via "Manage
// keywords…" from the start screen or the tagging form) rather than inline
// controls on each chip, since deleting or renaming a keyword acts on every
// photo in the folder, not just the one on screen -- worth a deliberate
// destination rather than a stray click in the tagging form.
function formatLocation(loc) {
  return loc ? `📍 ${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}` : 'no location';
}

function renderManageKeywordsList() {
  $('manage-keywords-list').innerHTML = knownKeywords.map((kw) => {
    const esc = escapeHtml(kw.name);
    return `<li>` +
      `<span class="manage-keyword-name">${esc}</span>` +
      `<span class="manage-keyword-location-status">${formatLocation(kw.location)}</span>` +
      `<button type="button" class="manage-keyword-location outline secondary small" data-keyword="${esc}">Edit location</button>` +
      `<button type="button" class="manage-keyword-rename outline secondary small" data-keyword="${esc}">Rename</button>` +
      `<button type="button" class="manage-keyword-delete outline danger small" data-keyword="${esc}">Delete</button>` +
      `</li>`;
  }).join('');
}

// Tracks which view "Manage keywords…" was opened from, so the back button
// returns there instead of always landing on one fixed view.
let manageReturnView = 'start';

async function openManageKeywords(returnView) {
  manageReturnView = returnView;
  closeLocationEditor();
  await loadKeywords();
  renderManageKeywordsList();
  switchView('manage');
}

$('manage-keywords-start-button').addEventListener('click', () => openManageKeywords('start'));
$('manage-keywords-tag-button').addEventListener('click', formState.guarded(() => openManageKeywords('tag')));
$('manage-back-button').addEventListener('click', () => switchView(manageReturnView));

$('manage-keywords-list').addEventListener('click', (e) => {
  const locBtn = e.target.closest('.manage-keyword-location');
  if (locBtn) {
    openLocationEditor(locBtn.dataset.keyword);
    return;
  }
  const renameBtn = e.target.closest('.manage-keyword-rename');
  if (renameBtn) {
    renameKeyword(renameBtn.dataset.keyword);
    return;
  }
  const delBtn = e.target.closest('.manage-keyword-delete');
  if (delBtn) {
    deleteKeyword(delBtn.dataset.keyword);
  }
});

// ---- Keyword location editor (manage-view) ----

// One shared editor panel with its own small map, rather than one per row:
// Leaflet needs a real container element, and only one keyword's Location
// is ever being edited at a time. The map starts at the keyword's own
// Location, else -- when opened from the tagging form -- that form's pin,
// so a place just pinned there can be saved; else it starts unpinned.
let manageMap, manageMarker;
let editingKeyword = null;
// Altitude for the editor's pin while it sits where it started (the
// keyword's saved alt, or the tagging form's altitude field); null once the
// pin is moved here, meaning Save looks it up.
let editingAlt = null;

function setManageMarker(lat, lon) {
  if (manageMarker) {
    manageMarker.setLatLng([lat, lon]);
  } else {
    manageMarker = L.marker([lat, lon], { draggable: true }).addTo(manageMap);
    manageMarker.on('dragend', () => { editingAlt = null; });
  }
  manageMap.setView([lat, lon], Math.max(manageMap.getZoom(), 12));
}

function openLocationEditor(kw) {
  const known = findKnownKeyword(kw);
  editingKeyword = kw;
  $('manage-location-keyword').textContent = kw;
  $('manage-location-status').textContent = formatLocation(known && known.location);
  $('manage-location-clear-button').disabled = !(known && known.location);
  clearMessage('manage-location-error');
  if (!$('manage-location-editor').open) $('manage-location-editor').showModal();

  if (!manageMap) {
    manageMap = createMap('manage-location-map');
    manageMap.on('click', (e) => {
      setManageMarker(e.latlng.lat, e.latlng.lng);
      editingAlt = null;
    });
  }
  // The container was hidden until just now, so Leaflet's cached size is stale.
  manageMap.invalidateSize();

  if (manageMarker) {
    manageMap.removeLayer(manageMarker);
    manageMarker = null;
  }
  editingAlt = null;
  const altVal = $('altitude-input').value;
  if (known && known.location) {
    setManageMarker(known.location.lat, known.location.lon);
    editingAlt = known.location.alt;
  } else if (manageReturnView === 'tag' && marker) {
    const ll = marker.getLatLng();
    setManageMarker(ll.lat, ll.lng);
    if (altVal !== '') editingAlt = parseFloat(altVal);
  }
}

function closeLocationEditor() {
  editingKeyword = null;
  if ($('manage-location-editor').open) $('manage-location-editor').close();
}

// Looks up the altitude for a pin moved on the manage map. Unlike the
// tagging form, nothing here can be edited by hand meanwhile, so it's a
// plain request rather than formState.requestElevation; a failed lookup
// saves 0 rather than blocking the save.
async function lookupAltitude(lat, lon) {
  try {
    const res = await fetch('/api/elevation', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lat, lon }),
    });
    const data = await res.json();
    return data.ok ? data.alt : 0;
  } catch (e) {
    return 0;
  }
}


$('manage-location-save-button').addEventListener('click', async () => {
  const kw = editingKeyword;
  if (!kw) return;
  if (!manageMarker) {
    showMessage('manage-location-error', 'Click the map to place a pin first.');
    return;
  }
  const ll = manageMarker.getLatLng();
  const alt = editingAlt !== null ? editingAlt : await lookupAltitude(ll.lat, ll.lng);
  const error = await saveKeywordLocation(kw, ll.lat, ll.lng, alt);
  if (error) {
    showMessage('manage-location-error', error);
    return;
  }
  renderManageKeywordsList();
  closeLocationEditor();
});

$('manage-location-clear-button').addEventListener('click', async () => {
  const kw = editingKeyword;
  if (!kw) return;
  const res = await fetch('/api/keywords/location', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword: kw }),
  });
  if (!res.ok) {
    showMessage('manage-location-error', `Couldn't clear the location for "${kw}": ${await responseError(res)}`);
    return;
  }
  replaceKnownKeywords(await res.json());
  renderManageKeywordsList();
  closeLocationEditor();
});

$('manage-location-cancel-button').addEventListener('click', closeLocationEditor);
// Escape closes the <dialog> natively, bypassing closeLocationEditor.
$('manage-location-editor').addEventListener('close', () => { editingKeyword = null; });

// ---- Field touch tracking ----

$('datetime-input').addEventListener('input', formState.guardedField(() => {
  formState.touch('dateTime');
  offsetManuallyEdited = false;
  maybeResolveTimezone();
}));

$('offset-input').addEventListener('input', formState.guardedField(() => {
  offsetManuallyEdited = true;
  formState.touch('dateTime');
  setOffsetRequired(false);
}));

$('altitude-input').addEventListener('input', formState.guardedField(() => {
  formState.invalidateElevation();
  formState.touch('location');
}));

$('caption-input').addEventListener('input', formState.guardedField(() => {
  formState.touch('caption');
}));

document.querySelectorAll('.same-as-prev').forEach((btn) => {
  btn.addEventListener('click', formState.guarded(() => {
    const group = btn.dataset.group;
    const prev = previousData[group];
    if (!prev) return;

    formState.applyProgrammaticUpdate(() => {
      if (group === 'location') {
        setMarker(prev.lat, prev.lon);
        formState.invalidateElevation();
        $('altitude-input').value = prev.alt ?? '';
        snappedLocatedKeyword = prev.locatedKeyword || '';
        // Location and its located keyword travel together: carry the
        // keyword across too, unless the photo already has it.
        if (snappedLocatedKeyword && !photoKeywords.includes(snappedLocatedKeyword)) {
          setPhotoKeywords([...photoKeywords, snappedLocatedKeyword], { touched: true });
        }
      } else if (group === 'dateTime') {
        $('datetime-input').value = prev.dateTime || '';
        $('offset-input').value = prev.offset || '';
        setOffsetRequired(false);
        offsetManuallyEdited = true; // trust the copied offset; don't recompute over it
      } else if (group === 'keywords') {
        resetKeywordEntry();
        setPhotoKeywords([...(prev.keywords || [])], { touched: false }); // touched below
      } else if (group === 'caption') {
        $('caption-input').value = prev.caption || '';
      }
    });

    formState.touch(group);
  }));
});

// ---- Tagging queue ----

function parseKeywords(text) {
  return text.split(',').map((s) => s.trim()).filter(Boolean);
}

// Confirms an Apply by naming the file it produced. A later Apply replaces
// the message and restarts the timer. #toast is a live region, so it stays
// rendered and is shown with a class rather than `hidden` -- a region
// unhidden at the same moment its text changes often isn't announced.
const TOAST_MS = 4000;
let toastTimer = null;

function showToast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, TOAST_MS);
}

function hideToast() {
  clearTimeout(toastTimer);
  $('toast').classList.remove('visible');
  $('toast').textContent = '';
}

function renderCurrent(data) {
  setBusy(false);
  // Only the apply response carries appliedAs; Skip and Prev clear any
  // toast left over from an earlier Apply, which would now be misleading.
  if (data.appliedAs) {
    showToast(`Saved as ${data.appliedAs}`);
  } else {
    hideToast();
  }

  if (data.done) {
    const applied = data.applied || 0;
    $('done-summary').textContent =
      `Applied ${applied} · Skipped ${data.total - applied} · ${data.total} in this run`;
    switchView('done');
    return;
  }

  $('tag-progress').textContent = `${data.index + 1} / ${data.total}`;
  $('tag-progress-bar').value = data.index + 1;
  $('tag-progress-bar').max = data.total;
  $('tag-relpath').textContent = data.relPath;
  $('preview-img').src = `${data.previewUrl}?i=${data.index}&t=${Date.now()}`;

  formState.resetTouched();
  offsetManuallyEdited = false;
  snappedLocatedKeyword = '';
  previousData = data.previous || {};
  formState.invalidateElevation();
  $('additional-details').open = false;
  closeSaveLocatedKeywordRow({ refocus: false });

  const ex = data.existing || {};
  $('photo-facts').textContent = photoFacts(ex, data.camera);
  formState.applyProgrammaticUpdate(() => {
    $('datetime-input').value = ex.dateTime || '';
    $('offset-input').value = ex.offset || '';
    setOffsetRequired(false);
    if (ex.lat != null && ex.lon != null) {
      setMarker(ex.lat, ex.lon);
    } else {
      clearMarker();
    }
    $('altitude-input').value = ex.alt ?? '';
    $('caption-input').value = ex.caption || '';
  });
  resetKeywordEntry();
  mergeKnownKeywords(ex.keywords || []);
  setPhotoKeywords([...(ex.keywords || [])], { touched: false });

  document.querySelectorAll('.same-as-prev').forEach((btn) => {
    btn.disabled = !previousData[btn.dataset.group];
  });
}

// What the photo carried before this run touched it, shown under the
// preview -- the original date and camera help place a photo, and GPS
// status says whether the map pin is real or still to be set.
function photoFacts(ex, camera) {
  const facts = [ex.dateTime ? `Taken ${ex.dateTime.replace('T', ' ')}` : 'No EXIF date'];
  if (camera) facts.push(camera);
  facts.push(ex.lat != null && ex.lon != null ? 'Has GPS' : 'No GPS');
  return facts.join(' · ');
}

function buildApplyPayload() {
  const lat = marker ? marker.getLatLng().lat : null;
  const lon = marker ? marker.getLatLng().lng : null;
  const altVal = $('altitude-input').value;

  return {
    dateTime: $('datetime-input').value,
    dateTimeTouched: formState.isTouched('dateTime'),
    offset: $('offset-input').value,
    lat, lon,
    alt: altVal === '' ? null : parseFloat(altVal),
    locationTouched: formState.isTouched('location'),
    locatedKeyword: snappedLocatedKeyword,
    keywords: photoKeywords,
    keywordsTouched: formState.isTouched('keywords'),
    caption: $('caption-input').value,
    captionTouched: formState.isTouched('caption'),
  };
}

// runNavigation guards every skip/prev/apply request behind formState's
// busy flag -- for Apply this doubles as an optimistic mirror of the
// server's authoritative lock (see the busy field's doc comment in
// internal/server/session.go and issue #11) -- and guarantees it's cleared
// on any failure (bad response or network error) -- otherwise a single
// failed request would leave the buttons disabled and every handler locked
// out for the rest of the session. Kept as a plain async function (not
// wrapped in formState.guarded()) so it keeps returning a Promise on the
// early-return path too, same as before this refactor.
async function runNavigation(action, fetchFn) {
  if (formState.isBusy()) return;
  setBusy(true);
  try {
    const res = await fetchFn();
    if (!res.ok) throw new Error(await responseError(res));
    clearTagError();
    renderCurrent(await res.json());
  } catch (e) {
    setBusy(false);
    showTagError(`Could not ${action}: ${e.message}`);
  }
}

function doSkip() {
  return runNavigation('skip', () => fetch('/api/photo/skip', { method: 'POST' }));
}

function doPrev() {
  return runNavigation('go back', () => fetch('/api/photo/prev', { method: 'POST' }));
}

function doApply() {
  // Text typed in the keyword entry but not yet added still counts.
  if (!formState.isBusy() && $('keyword-entry').value.trim() !== '') commitKeywordEntry();
  const payload = buildApplyPayload();
  if (payload.keywordsTouched) mergeKnownKeywords(payload.keywords);
  return runNavigation('apply', () => fetch('/api/photo/apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  }));
}

$('done-back-button').addEventListener('click', () => {
  switchView('start');
  loadState();
});

$('skip-button').addEventListener('click', doSkip);
$('prev-button').addEventListener('click', doPrev);
$('apply-button').addEventListener('click', doApply);

// ---- Keyboard shortcuts ----

// Enter already has a well-defined job on these -- inserting a newline/
// continuing to type on a free-text field, or activating a focused <button>
// (the native browser behavior for a focused button) -- so it must never be
// hijacked into Apply there.
function isFreeTextField(el) {
  if (!el) return false;
  return el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text');
}

// Links count too: Leaflet's zoom +/- are <a role="button">, and Enter on
// a focused one should zoom, not Apply.
function hasOwnEnterBehavior(el) {
  return isFreeTextField(el) || !!(el && (el.tagName === 'BUTTON' || el.tagName === 'A'));
}

// The dedicated Skip/Prev keys (ArrowRight/ArrowLeft) must defer to any
// control with its own meaning for arrow keys: cursor movement in a text
// field, or "change the selected option" in a <select>.
function ownsArrowKeys(el) {
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

document.addEventListener('keydown', (e) => {
  if (formState.isBusy() || $('tag-view').hidden) return;

  if (e.key === 'Enter') {
    if (hasOwnEnterBehavior(e.target)) return;
    e.preventDefault();
    doApply();
    return;
  }

  if (ownsArrowKeys(e.target)) return;

  if (e.key === 'ArrowRight') {
    e.preventDefault();
    doSkip();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    doPrev();
  }
});

loadState();
