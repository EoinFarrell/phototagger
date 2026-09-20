'use strict';

let map, marker;
let favourites = [];
let previousData = {};
let selectedFavouriteName = '';
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

function switchView(name) {
  $('start-view').hidden = name !== 'start';
  $('tag-view').hidden = name !== 'tag';
  $('done-view').hidden = name !== 'done';
}

// ---- Start screen ----

async function loadState() {
  const res = await fetch('/api/state');
  const data = await res.json();

  const extLine = Object.entries(data.extCounts).map(([ext, count]) => `${count} .${ext}`).join(', ') || 'none';
  let html = `<p><strong>${data.photoCount}</strong> photo(s) found in <code>${escapeHtml(data.sourceDir)}</code> ` +
    `across <strong>${data.subfolderCount}</strong> subfolder(s): ${extLine}.</p>`;
  html += `<p>Backup: <code>${escapeHtml(data.backupDir)}</code></p>`;
  if (data.skipped && data.skipped.length) {
    html += `<details><summary>${data.skipped.length} skipped/non-applicable file(s)</summary>` +
      `<ul id="skipped-list">${data.skipped.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul></details>`;
  }
  $('start-summary').innerHTML = html;

  const modes = data.modes || { all: 0, nonTagged: 0, tagged: 0 };
  $('mode-count-all').textContent = modes.all;
  $('mode-count-non-tagged').textContent = modes.nonTagged;
  $('mode-count-tagged').textContent = modes.tagged;

  // A Mode with zero matching photos is still a valid choice -- it just
  // goes straight to the Done state -- so this only guards against there
  // being nothing in the source directory at all.
  $('start-button').disabled = data.photoCount === 0;
}

$('start-button').addEventListener('click', async () => {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  await fetch('/api/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }),
  });
  switchView('tag');
  initMap();
  await loadFavourites();
  const res = await fetch('/api/photo/current');
  renderCurrent(await res.json());
});

// ---- Map ----

function initMap() {
  map = L.map('map').setView([53.35, -6.26], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(map);
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
  selectedFavouriteName = '';
  offsetManuallyEdited = false;
  $('favourite-select').value = '';
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

// ---- Favourites ----

async function loadFavourites() {
  const res = await fetch('/api/favourites');
  favourites = await res.json();
  populateFavouriteSelect();
}

function populateFavouriteSelect() {
  const sel = $('favourite-select');
  const current = sel.value;
  sel.innerHTML = '<option value="">— freehand pin —</option>' +
    favourites.map((f) => `<option value="${escapeHtml(f.name)}">${escapeHtml(f.name)}</option>`).join('');
  sel.value = current;
}

$('favourite-select').addEventListener('change', formState.guarded((e) => {
  const name = e.target.value;
  if (!name) return;
  const fav = favourites.find((f) => f.name === name);
  if (!fav) return;
  formState.applyProgrammaticUpdate(() => setMarker(fav.lat, fav.lon));
  formState.invalidateElevation();
  $('altitude-input').value = fav.alt;
  formState.touch('location');
  selectedFavouriteName = fav.name;
  offsetManuallyEdited = false;
  maybeResolveTimezone();
}));

$('save-favourite-button').addEventListener('click', formState.guarded(async () => {
  if (!marker) {
    alert('Drop a pin on the map first.');
    return;
  }
  const name = $('favourite-name-input').value.trim();
  if (!name) {
    alert('Enter a name for this location.');
    return;
  }
  const altVal = $('altitude-input').value;
  if (altVal === '') {
    alert('Altitude is still loading — wait a moment, or enter it manually, then try again.');
    return;
  }
  const ll = marker.getLatLng();
  const alt = parseFloat(altVal);
  const res = await fetch('/api/favourites', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, lat: ll.lat, lon: ll.lng, alt }),
  });
  favourites = await res.json();
  populateFavouriteSelect();
  $('favourite-name-input').value = '';
}));

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

$('keywords-input').addEventListener('input', formState.guardedField(() => {
  formState.touch('keywords');
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
        selectedFavouriteName = prev.favouriteName || '';
        $('favourite-select').value = selectedFavouriteName;
      } else if (group === 'dateTime') {
        $('datetime-input').value = prev.dateTime || '';
        $('offset-input').value = prev.offset || '';
        setOffsetRequired(false);
        offsetManuallyEdited = true; // trust the copied offset; don't recompute over it
      } else if (group === 'keywords') {
        $('keywords-input').value = (prev.keywords || []).join(', ');
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

function renderCurrent(data) {
  setBusy(false);

  if (data.done) {
    switchView('done');
    return;
  }

  $('tag-progress').textContent = `${data.index + 1} / ${data.total}`;
  $('tag-relpath').textContent = data.relPath;
  $('preview-img').src = `${data.previewUrl}?i=${data.index}&t=${Date.now()}`;

  formState.resetTouched();
  offsetManuallyEdited = false;
  selectedFavouriteName = '';
  previousData = data.previous || {};
  formState.invalidateElevation();
  $('additional-details').open = false;

  formState.applyProgrammaticUpdate(() => {
    const ex = data.existing || {};
    $('datetime-input').value = ex.dateTime || '';
    $('offset-input').value = ex.offset || '';
    setOffsetRequired(false);
    if (ex.lat != null && ex.lon != null) {
      setMarker(ex.lat, ex.lon);
    } else {
      clearMarker();
    }
    $('altitude-input').value = ex.alt ?? '';
    $('favourite-select').value = '';
    $('keywords-input').value = (ex.keywords || []).join(', ');
    $('caption-input').value = ex.caption || '';
  });

  document.querySelectorAll('.same-as-prev').forEach((btn) => {
    btn.disabled = !previousData[btn.dataset.group];
  });
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
    favouriteName: selectedFavouriteName,
    keywords: parseKeywords($('keywords-input').value),
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
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || res.statusText);
    }
    renderCurrent(await res.json());
  } catch (e) {
    setBusy(false);
    alert(`Could not ${action}: ` + e.message);
  }
}

function doSkip() {
  return runNavigation('skip', () => fetch('/api/photo/skip', { method: 'POST' }));
}

function doPrev() {
  return runNavigation('go back', () => fetch('/api/photo/prev', { method: 'POST' }));
}

function doApply() {
  return runNavigation('apply', () => fetch('/api/photo/apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildApplyPayload()),
  }));
}

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

function hasOwnEnterBehavior(el) {
  return isFreeTextField(el) || !!(el && el.tagName === 'BUTTON');
}

// The dedicated Skip/Prev keys (ArrowRight/ArrowLeft) must defer to any
// control with its own meaning for arrow keys: cursor movement in a text
// field, or "change the selected option" in the favourite <select>.
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
