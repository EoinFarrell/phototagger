'use strict';

let map, marker;
let knownKeywords = [];
let previousData = {};
// The located keyword the pin is snapped to, if any -- it names the
// renamed file (the Apply payload's locatedKeyword). Cleared by moving the
// pin by hand, not by removing the keyword from the Keywords field.
let snappedLocatedKeyword = '';
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
  $('start-view').hidden = name !== 'start';
  $('tag-view').hidden = name !== 'tag';
  $('manage-view').hidden = name !== 'manage';
  $('done-view').hidden = name !== 'done';
}

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
  renderKeywordPills();
}

// Replaces knownKeywords with the server's list (as returned by every
// keyword-changing endpoint), keeping any keyword only on the current
// photo's field -- e.g. from an unApplied photo's existing EXIF -- which
// the server's keywords.json doesn't know about yet.
function replaceKnownKeywords(list) {
  knownKeywords = list;
  mergeKnownKeywords(parseKeywords($('keywords-input').value));
  renderKeywordPills();
}

// Sets kw's Location via POST /api/keywords/location (creating kw if it's
// new), writing immediately rather than waiting for Apply. Returns whether
// it succeeded, having already alerted if not.
async function saveKeywordLocation(kw, lat, lon, alt) {
  const res = await fetch('/api/keywords/location', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword: kw, lat, lon, alt }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert(`Failed to save location for "${kw}": ${body.error || res.statusText}`);
    return false;
  }
  replaceKnownKeywords(await res.json());
  return true;
}

function findKnownKeyword(kw) {
  return knownKeywords.find((k) => k.name === kw);
}

// Pills double as a legend for what's already in the field: one already
// present in keywords-input renders .active, and clicking it again removes
// it from the field (toggle), keeping the pill and the field in sync.
// Located keywords render in the Location section (they're its saved-place
// picker), with a pin marker; plain keywords in the Keywords section.
// Renaming/deleting a keyword and editing its Location live on the
// manage-view instead of on the pill itself (see "Manage keywords…").
function renderKeywordPills() {
  const current = new Set(parseKeywords($('keywords-input').value));
  const pill = (kw) => {
    const active = current.has(kw.name) ? ' active' : '';
    const esc = escapeHtml(kw.name);
    const pin = kw.location ? '📍 ' : '';
    return `<button type="button" class="keyword-pill${active}" data-keyword="${esc}">${pin}${esc}</button>`;
  };
  $('located-keyword-pills').innerHTML = knownKeywords.filter((kw) => kw.location).map(pill).join('');
  $('keyword-pills').innerHTML = knownKeywords.filter((kw) => !kw.location).map(pill).join('');
}

// Adding a located keyword also snaps the map to its Location and makes it
// the file's name -- but only on add: clicking an already-active pill to
// remove it leaves the map untouched, since removing a keyword says nothing
// about where the photo actually is.
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
      snappedLocatedKeyword = known.name;
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
  if (changed) renderKeywordPills();
}

// Deletes kw from the known-keywords list and strips it from every photo in
// the source directory that currently has it (not just the one on screen),
// via DELETE /api/keywords -- see internal/server/session.go's
// DeleteKeyword. Confirmed first since, unlike the rest of this form, it
// writes to disk immediately rather than waiting for Apply. Called from the
// manage-view's "Delete" button (see "---- Keyword management ----" below).
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
  if (editingKeyword === kw) closeLocationEditor();
  renderKeywordPills();
  renderManageKeywordsList();
}

// Renames kw to a new name everywhere -- every photo in the folder carrying
// it, and the known-keywords list itself (preserving its Location) -- via
// POST /api/keywords/rename (internal/server/session.go's RenameKeyword).
// Prompts for the new name rather than an inline editable field, matching
// this app's existing lightweight alert()/confirm() interaction style
// instead of adding per-row input-field state. A cancelled prompt (null) or
// one left unchanged/blank is a silent no-op.
async function renameKeyword(kw) {
  const newName = prompt(`Rename "${kw}" to:`, kw);
  if (newName === null) return;
  const trimmed = newName.trim();
  if (trimmed === '' || trimmed === kw) return;

  const res = await fetch('/api/keywords/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldKeyword: kw, newKeyword: trimmed }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert(`Failed to rename "${kw}": ${body.error || res.statusText}`);
    return;
  }
  const renamed = await res.json();
  // If the field being edited still has the old name queued (not yet
  // Applied), carry the rename into it too, rather than leaving a now-
  // nonexistent keyword sitting in the current photo's field. Done before
  // replaceKnownKeywords, which would otherwise merge the old name back in.
  formState.applyProgrammaticUpdate(() => {
    const current = parseKeywords($('keywords-input').value);
    const idx = current.indexOf(kw);
    if (idx !== -1) {
      current[idx] = trimmed;
      $('keywords-input').value = current.join(', ');
    }
  });
  replaceKnownKeywords(renamed);
  if (editingKeyword === kw) closeLocationEditor();
  renderManageKeywordsList();
}

// Both pill groups toggle the same way; only where they render differs.
function onPillClick(e) {
  const btn = e.target.closest('.keyword-pill');
  if (!btn) return;
  toggleKeyword(btn.dataset.keyword);
}
$('keyword-pills').addEventListener('click', formState.guardedField(onPillClick));
$('located-keyword-pills').addEventListener('click', formState.guardedField(onPillClick));

// The name row is rarely needed, so it stays collapsed behind a small
// toggle until asked for, and collapses again after a save or on the next
// photo.
$('save-located-keyword-toggle').addEventListener('click', () => {
  const row = $('save-located-keyword-row');
  row.hidden = !row.hidden;
  if (!row.hidden) $('located-keyword-name-input').focus();
});

// "Save pin as located keyword": captures the current pin (and altitude)
// as a keyword's Location -- creating the keyword if it's new, or
// (re)locating an existing one.
$('save-located-keyword-button').addEventListener('click', formState.guarded(async () => {
  if (!marker) {
    alert('Drop a pin on the map first.');
    return;
  }
  const name = $('located-keyword-name-input').value.trim();
  if (!name) {
    alert('Enter a name for this located keyword.');
    return;
  }
  const altVal = $('altitude-input').value;
  if (altVal === '') {
    alert('Altitude is still loading — wait a moment, or enter it manually, then try again.');
    return;
  }
  const ll = marker.getLatLng();
  if (await saveKeywordLocation(name, ll.lat, ll.lng, parseFloat(altVal))) {
    $('located-keyword-name-input').value = '';
    $('save-located-keyword-row').hidden = true;
  }
}));

// ---- Keyword management (rename/delete) ----

// Renders a row per known keyword in the manage-view: its name and a
// Rename/Delete pair. Kept as its own full-page view (reached via "Manage
// keywords…" from the start screen or the tagging form) rather than inline
// per-pill controls, since deleting or renaming a keyword acts on every
// photo in the folder, not just the one on screen -- worth a deliberate
// destination rather than a stray click on a quick-pick pill.
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
    alert('Click the map to place a pin first.');
    return;
  }
  const ll = manageMarker.getLatLng();
  const alt = editingAlt !== null ? editingAlt : await lookupAltitude(ll.lat, ll.lng);
  if (await saveKeywordLocation(kw, ll.lat, ll.lng, alt)) {
    renderManageKeywordsList();
    closeLocationEditor();
  }
});

$('manage-location-clear-button').addEventListener('click', async () => {
  const kw = editingKeyword;
  if (!kw) return;
  const res = await fetch('/api/keywords/location', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword: kw }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert(`Failed to clear location for "${kw}": ${body.error || res.statusText}`);
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
        snappedLocatedKeyword = prev.locatedKeyword || '';
        // Location and its located keyword travel together: carry the
        // keyword across too, unless it's already in the field.
        const kws = parseKeywords($('keywords-input').value);
        if (snappedLocatedKeyword && !kws.includes(snappedLocatedKeyword)) {
          kws.push(snappedLocatedKeyword);
          $('keywords-input').value = kws.join(', ');
          formState.touch('keywords');
          renderKeywordPills();
        }
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
  $('save-located-keyword-row').hidden = true;

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
    $('keywords-input').value = (ex.keywords || []).join(', ');
    $('caption-input').value = ex.caption || '';
  });
  mergeKnownKeywords(ex.keywords || []);
  renderKeywordPills();

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
