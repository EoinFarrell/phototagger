'use strict';

let map, marker;
let favourites = [];
let previousData = {};
let selectedFavouriteName = '';
let offsetManuallyEdited = false;
let settingProgrammatically = false;
let touched = { location: false, dateTime: false, keywords: false, caption: false };
// True while a navigation request (start/skip/prev/apply) is in flight. Blocks
// every handler that reads or sets form state, so a user interaction that
// happens to land in that window can't be silently discarded when the
// response arrives and renderCurrent() resets the form for a different photo.
let busy = false;
// Bumped every time something explicitly sets the altitude field's meaning
// (a new photo renders, a new pin drops, a favourite is picked, or the user
// edits it by hand). fetchElevation() captures this at call time and checks
// it before writing back, so a slow lookup for a pin/photo that's since been
// superseded can't silently clobber whatever's there now with a stale value.
let altitudeGeneration = 0;

const $ = (id) => document.getElementById(id);

function setBusy(v) {
  busy = v;
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
  map.on('click', (e) => {
    if (settingProgrammatically || busy) return;
    setMarker(e.latlng.lat, e.latlng.lng);
    onManualPin(e.latlng.lat, e.latlng.lng);
  });
}

function setMarker(lat, lon) {
  if (marker) {
    marker.setLatLng([lat, lon]);
  } else {
    marker = L.marker([lat, lon], { draggable: true }).addTo(map);
    marker.on('dragend', () => {
      if (settingProgrammatically || busy) return;
      const ll = marker.getLatLng();
      onManualPin(ll.lat, ll.lng);
    });
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
  touched.location = true;
  selectedFavouriteName = '';
  offsetManuallyEdited = false;
  $('favourite-select').value = '';
  altitudeGeneration++;
  fetchElevation(lat, lon, altitudeGeneration);
  maybeResolveTimezone();
}

async function fetchElevation(lat, lon, gen) {
  try {
    const res = await fetch('/api/elevation', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lat, lon }),
    });
    const data = await res.json();
    if (data.ok && gen === altitudeGeneration) $('altitude-input').value = data.alt;
  } catch (e) {
    // Offline or unreachable: leave altitude as-is rather than blocking.
  }
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

$('favourite-select').addEventListener('change', (e) => {
  if (busy) return;
  const name = e.target.value;
  if (!name) return;
  const fav = favourites.find((f) => f.name === name);
  if (!fav) return;
  settingProgrammatically = true;
  setMarker(fav.lat, fav.lon);
  settingProgrammatically = false;
  altitudeGeneration++;
  $('altitude-input').value = fav.alt;
  touched.location = true;
  selectedFavouriteName = fav.name;
  offsetManuallyEdited = false;
  maybeResolveTimezone();
});

$('save-favourite-button').addEventListener('click', async () => {
  if (busy) return;
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
});

// ---- Field touch tracking ----

$('datetime-input').addEventListener('input', () => {
  if (settingProgrammatically || busy) return;
  touched.dateTime = true;
  offsetManuallyEdited = false;
  maybeResolveTimezone();
});

$('offset-input').addEventListener('input', () => {
  if (settingProgrammatically || busy) return;
  offsetManuallyEdited = true;
  touched.dateTime = true;
  setOffsetRequired(false);
});

$('altitude-input').addEventListener('input', () => {
  if (settingProgrammatically || busy) return;
  altitudeGeneration++;
  touched.location = true;
});

$('keywords-input').addEventListener('input', () => {
  if (settingProgrammatically || busy) return;
  touched.keywords = true;
});

$('caption-input').addEventListener('input', () => {
  if (settingProgrammatically || busy) return;
  touched.caption = true;
});

document.querySelectorAll('.same-as-prev').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (busy) return;
    const group = btn.dataset.group;
    const prev = previousData[group];
    if (!prev) return;

    settingProgrammatically = true;
    if (group === 'location') {
      setMarker(prev.lat, prev.lon);
      altitudeGeneration++;
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
    settingProgrammatically = false;

    touched[group] = true;
  });
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

  touched = { location: false, dateTime: false, keywords: false, caption: false };
  offsetManuallyEdited = false;
  selectedFavouriteName = '';
  previousData = data.previous || {};
  altitudeGeneration++;
  $('additional-details').open = false;

  settingProgrammatically = true;
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
  settingProgrammatically = false;

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
    dateTimeTouched: touched.dateTime,
    offset: $('offset-input').value,
    lat, lon,
    alt: altVal === '' ? null : parseFloat(altVal),
    locationTouched: touched.location,
    favouriteName: selectedFavouriteName,
    keywords: parseKeywords($('keywords-input').value),
    keywordsTouched: touched.keywords,
    caption: $('caption-input').value,
    captionTouched: touched.caption,
  };
}

// runNavigation guards every skip/prev/apply request behind the busy flag,
// and guarantees it's cleared on any failure (bad response or network error)
// -- otherwise a single failed request would leave the buttons disabled and
// every handler locked out for the rest of the session.
async function runNavigation(action, fetchFn) {
  if (busy) return;
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

$('skip-button').addEventListener('click', () =>
  runNavigation('skip', () => fetch('/api/photo/skip', { method: 'POST' })));

$('prev-button').addEventListener('click', () =>
  runNavigation('go back', () => fetch('/api/photo/prev', { method: 'POST' })));

$('apply-button').addEventListener('click', () =>
  runNavigation('apply', () => fetch('/api/photo/apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildApplyPayload()),
  })));

loadState();
