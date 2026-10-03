'use strict';

let map, marker;
let favourites = [];
let knownKeywords = [];
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
  initMap();
  await loadFavourites();
  await loadKeywords();
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

// ---- Keywords ----

async function loadKeywords() {
  const res = await fetch('/api/keywords');
  knownKeywords = await res.json();
  renderKeywordPills();
  renderKeywordLocations();
}

function findKnownKeyword(kw) {
  return knownKeywords.find((k) => k.name === kw);
}

// Pills double as a legend for what's already in the field: one already
// present in keywords-input renders .active, and clicking it again removes
// it from the field (toggle), keeping the pill and the field in sync. Each
// pill pairs with a small × button that deletes the keyword everywhere
// (see deleteKeyword) rather than just from this photo. A keyword carrying
// a saved Location (see renderKeywordLocations below) gets a pin marker, so
// it's visible before clicking that doing so will also move the map.
function renderKeywordPills() {
  const current = new Set(parseKeywords($('keywords-input').value));
  $('keyword-pills').innerHTML = knownKeywords.map((kw) => {
    const active = current.has(kw.name) ? ' active' : '';
    const esc = escapeHtml(kw.name);
    const pin = kw.location ? '📍 ' : '';
    return `<span class="keyword-pill-group">` +
      `<button type="button" class="keyword-pill${active}" data-keyword="${esc}">${pin}${esc}</button>` +
      `<button type="button" class="keyword-pill-delete${active}" data-keyword="${esc}" title="Delete “${esc}” from every photo in this folder" aria-label="Delete ${esc}">×</button>` +
      `</span>`;
  }).join('');
}

// Adding a keyword that carries a saved Location also snaps the map to it,
// mirroring the favourite-select change handler -- but only on add:
// clicking an already-active pill to remove it leaves the map untouched,
// since removing a keyword says nothing about where the photo actually is.
function toggleKeyword(kw) {
  const current = parseKeywords($('keywords-input').value);
  const idx = current.indexOf(kw);
  if (idx === -1) {
    current.push(kw);
    const known = findKnownKeyword(kw);
    if (known && known.location) {
      const loc = known.location;
      formState.applyProgrammaticUpdate(() => setMarker(loc.lat, loc.lon));
      formState.invalidateElevation();
      $('altitude-input').value = loc.alt;
      $('favourite-select').value = '';
      selectedFavouriteName = '';
      offsetManuallyEdited = false;
      formState.touch('location');
      maybeResolveTimezone();
    }
  } else {
    current.splice(idx, 1);
  }
  $('keywords-input').value = current.join(', ');
  formState.touch('keywords');
  renderKeywordPills();
}

// Optimistic local mirror of the server's keywords.json (updated on Apply,
// see internal/server/session.go's Apply) -- keeps a keyword typed this
// session showing up as a pill immediately, without a round trip. A
// keyword merged in this way never carries a Location -- only an
// already-known keyword can have one set, via the management UI below.
function mergeKnownKeywords(kws) {
  let changed = false;
  kws.forEach((kw) => {
    if (!findKnownKeyword(kw)) {
      knownKeywords.push({ name: kw, location: null });
      changed = true;
    }
  });
  if (changed) { renderKeywordPills(); renderKeywordLocations(); }
}

// Deletes kw from the known-keywords list and strips it from every photo in
// the source directory that currently has it (not just the one on screen),
// via DELETE /api/keywords -- see internal/server/session.go's
// DeleteKeyword. Confirmed first since, unlike the rest of this form, it
// writes to disk immediately rather than waiting for Apply.
async function deleteKeyword(kw) {
  if (!confirm(`Delete "${kw}"?\n\nThis removes it from every photo in this folder that has it, not just this one, and can't be undone from here.`)) {
    return;
  }
  const res = await fetch('/api/keywords', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword: kw }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert(`Failed to delete "${kw}": ${body.error || res.statusText}`);
    return;
  }
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
    const remaining = parseKeywords($('keywords-input').value).filter((k) => k !== kw);
    $('keywords-input').value = remaining.join(', ');
  });
  renderKeywordPills();
  renderKeywordLocations();
}

$('keyword-pills').addEventListener('click', formState.guardedField((e) => {
  const delBtn = e.target.closest('.keyword-pill-delete');
  if (delBtn) {
    deleteKeyword(delBtn.dataset.keyword);
    return;
  }
  const btn = e.target.closest('.keyword-pill');
  if (!btn) return;
  toggleKeyword(btn.dataset.keyword);
}));

// ---- Keyword location management ----

// Renders a row per known keyword in the "Manage keyword locations"
// disclosure: its saved Location if any, and two actions -- capture the
// map's current pin as that keyword's Location, or clear it. Kept as its
// own section below the quick-pick pills, rather than inline controls on
// each pill, so the pill row itself stays visually simple.
function renderKeywordLocations() {
  $('keyword-locations-list').innerHTML = knownKeywords.map((kw) => {
    const esc = escapeHtml(kw.name);
    const status = kw.location
      ? `${kw.location.lat.toFixed(4)}, ${kw.location.lon.toFixed(4)}`
      : 'no location';
    return `<li>` +
      `<span class="kw-loc-name">${esc}</span>` +
      `<span class="kw-loc-status">${status}</span>` +
      `<button type="button" class="kw-loc-set" data-keyword="${esc}">Set to current pin</button>` +
      `<button type="button" class="kw-loc-clear" data-keyword="${esc}"${kw.location ? '' : ' disabled'}>Clear</button>` +
      `</li>`;
  }).join('');
}

// Links kw to the map's current pin via POST /api/keywords/location (see
// internal/server/session.go's SetKeywordLocation) -- writes immediately,
// like deleteKeyword, rather than waiting for Apply.
async function setKeywordLocationToCurrentPin(kw) {
  if (!marker) {
    alert('Drop a pin on the map first.');
    return;
  }
  const altVal = $('altitude-input').value;
  if (altVal === '') {
    alert('Altitude is still loading — wait a moment, or enter it manually, then try again.');
    return;
  }
  const ll = marker.getLatLng();
  const res = await fetch('/api/keywords/location', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword: kw, lat: ll.lat, lon: ll.lng, alt: parseFloat(altVal) }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert(`Failed to set location for "${kw}": ${body.error || res.statusText}`);
    return;
  }
  knownKeywords = await res.json();
  renderKeywordPills();
  renderKeywordLocations();
}

async function clearKeywordLocation(kw) {
  const res = await fetch('/api/keywords/location', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword: kw }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert(`Failed to clear location for "${kw}": ${body.error || res.statusText}`);
    return;
  }
  knownKeywords = await res.json();
  renderKeywordPills();
  renderKeywordLocations();
}

$('keyword-locations-list').addEventListener('click', formState.guarded((e) => {
  const setBtn = e.target.closest('.kw-loc-set');
  if (setBtn) {
    setKeywordLocationToCurrentPin(setBtn.dataset.keyword);
    return;
  }
  const clearBtn = e.target.closest('.kw-loc-clear');
  if (clearBtn) {
    clearKeywordLocation(clearBtn.dataset.keyword);
  }
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
  renderKeywordPills();
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
        renderKeywordPills();
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

  const ex = data.existing || {};
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
    $('favourite-select').value = '';
    $('keywords-input').value = (ex.keywords || []).join(', ');
    $('caption-input').value = ex.caption || '';
  });
  mergeKnownKeywords(ex.keywords || []);
  renderKeywordPills();

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
  const payload = buildApplyPayload();
  if (payload.keywordsTouched) mergeKnownKeywords(payload.keywords);
  return runNavigation('apply', () => fetch('/api/photo/apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
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
