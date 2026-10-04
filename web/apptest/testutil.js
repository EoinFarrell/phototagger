'use strict';
// Minimal dependency-free DOM/Leaflet/fetch stubs, plus shared test-drive
// helpers, sufficient to load and run the real web/static/app.js under
// Node's vm module. Not part of the served app (kept out of web/static so
// //go:embed never picks it up).

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_JS = path.resolve(__dirname, '../static/app.js');
const FORM_STATE_JS = path.resolve(__dirname, '../static/formstate.js');

class FakeClassList {
  constructor() { this._set = new Set(); }
  add(c) { this._set.add(c); }
  remove(c) { this._set.delete(c); }
  contains(c) { return this._set.has(c); }
  toggle(c, force = !this._set.has(c)) {
    if (force) this._set.add(c); else this._set.delete(c);
    return force;
  }
}

class FakeElement {
  constructor(id, tagName = 'DIV', type) {
    this.id = id;
    this.tagName = tagName;
    if (type !== undefined) this.type = type;
    this._value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.hidden = false;
    this.disabled = false;
    this.required = false;
    this.src = '';
    this.open = false;
    this.dataset = {};
    this.classList = new FakeClassList();
    this._listeners = {};
  }
  get value() { return this._value; }
  set value(v) { this._value = v; }
  setAttribute(name, value) { (this._attrs = this._attrs || {})[name] = String(value); }
  getAttribute(name) { return this._attrs && name in this._attrs ? this._attrs[name] : null; }
  removeAttribute(name) { if (this._attrs) delete this._attrs[name]; }
  // <dialog> methods, for the manage-view's location editor.
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
  // Like the real HTMLElement.click(), a disabled button ignores it.
  click() { if (!this.disabled) this.dispatchEvent({ type: 'click', target: this }); }
  addEventListener(evt, cb) { (this._listeners[evt] = this._listeners[evt] || []).push(cb); }
  dispatchEvent(evt) {
    (this._listeners[evt.type] || []).slice().forEach((cb) => cb(evt));
  }
  // Minimal stand-in for Element.closest -- this fake DOM never parses
  // innerHTML into real child nodes, so it only ever matches itself. That's
  // enough to drive app.js's event-delegated click target (see
  // pickKeyword below), which is always the delegation target itself.
  closest(selector) {
    return this.classList.contains(selector.replace(/^\./, '')) ? this : null;
  }
}

// Single source of truth for every stubbed element id, and (where it
// matters) its tagName/type -- mirroring web/static/index.html closely
// enough for the keyboard-shortcut guards (isFreeTextField/isFormControl in
// app.js) to tell real form controls apart from everything else, the same
// way a real DOM would. Ids with no entry here fall back to a plain DIV,
// which is fine for elements the shortcut guards never inspect.
const ELEMENT_META = {
  'start-view': [], 'tag-view': [], 'manage-view': [], 'done-view': [], 'start-summary': [],
  'mode-count-all': [], 'mode-count-non-tagged': [], 'mode-count-tagged': [],
  'geo-count-all': [], 'geo-count-missing-gps': [],
  'start-button': ['BUTTON'],
  'done-summary': [],
  'done-back-button': ['BUTTON'],
  'manage-keywords-start-button': ['BUTTON'],
  'manage-keywords-tag-button': ['BUTTON'],
  'manage-back-button': ['BUTTON'],
  'manage-keywords-list': [],
  'manage-location-editor': [],
  'manage-location-keyword': [],
  'manage-location-status': [],
  'manage-location-save-button': ['BUTTON'],
  'manage-location-clear-button': ['BUTTON'],
  'manage-location-cancel-button': ['BUTTON'],
  'save-located-keyword-toggle': ['BUTTON'],
  'save-located-keyword-row': [],
  'save-located-keyword-button': ['BUTTON'],
  'save-located-keyword-cancel': ['BUTTON'],
  'located-keyword-name-input': ['INPUT', 'text'],
  'datetime-input': ['INPUT', 'datetime-local'],
  'offset-input': ['INPUT', 'text'],
  'altitude-input': ['INPUT', 'number'],
  'keyword-field': [], 'keyword-chips': [], 'keyword-status': [],
  'keyword-entry': ['INPUT', 'text'],
  'keyword-suggestions': [],
  'caption-input': ['TEXTAREA'],
  'additional-details': [], 'additional-required-badge': [],
  'tag-home-button': ['BUTTON'],
  'tag-progress': [], 'tag-progress-bar': ['PROGRESS'], 'tag-relpath': [], 'preview-img': [],
  'photo-facts': [],
  'toast': [],
  'tag-error': [], 'tag-error-message': [], 'tag-error-dismiss': ['BUTTON'],
  'located-keyword-error': [],
  'manage-location-error': [],
  'ask-dialog': [], 'ask-title': [], 'ask-message': [],
  'ask-input': ['INPUT', 'text'], 'ask-error': [], 'ask-working': [],
  'ask-cancel-button': ['BUTTON'], 'ask-confirm-button': ['BUTTON'],
  'skip-button': ['BUTTON'],
  'prev-button': ['BUTTON'],
  'apply-button': ['BUTTON'],
};

function buildDom() {
  const elements = {};
  Object.keys(ELEMENT_META).forEach((id) => {
    const [tagName, type] = ELEMENT_META[id];
    elements[id] = new FakeElement(id, tagName, type);
  });

  const sameAsPrevButtons = ['location', 'dateTime', 'keywords', 'caption'].map((g) => {
    const el = new FakeElement(`same-prev-${g}`, 'BUTTON');
    el.dataset.group = g;
    return el;
  });

  // Mirrors index.html's #mode-select radios (non-tagged checked by default)
  // so app.js's `document.querySelector('input[name="mode"]:checked')` on
  // Start resolves the same way it would against the real DOM.
  const modeRadios = ['non-tagged', 'tagged', 'all'].map((value, i) => {
    const el = new FakeElement(`mode-radio-${value}`, 'INPUT', 'radio');
    el.name = 'mode';
    el.value = value;
    el.checked = i === 0;
    return el;
  });

  // Mirrors index.html's #geo-select radios ("all" checked by default).
  const geoRadios = ['all', 'missing-gps'].map((value, i) => {
    const el = new FakeElement(`geo-radio-${value}`, 'INPUT', 'radio');
    el.name = 'geo';
    el.value = value;
    el.checked = i === 0;
    return el;
  });

  const docListeners = {};
  const document = {
    getElementById: (id) => {
      if (!elements[id]) throw new Error(`no stub element for id="${id}"`);
      return elements[id];
    },
    querySelectorAll: (sel) => (sel === '.same-as-prev' ? sameAsPrevButtons : []),
    querySelector: (sel) => {
      if (sel === 'input[name="mode"]:checked') return modeRadios.find((r) => r.checked) || null;
      if (sel === 'input[name="geo"]:checked') return geoRadios.find((r) => r.checked) || null;
      return null;
    },
    addEventListener: (evt, cb) => { (docListeners[evt] = docListeners[evt] || []).push(cb); },
    dispatchEvent: (evt) => { (docListeners[evt.type] || []).slice().forEach((cb) => cb(evt)); },
  };

  return { document, elements, sameAsPrevButtons, modeRadios, geoRadios };
}

// ---- Fake Leaflet ----
function buildFakeLeaflet() {
  const created = { maps: [], markers: [] };

  const L = {
    map: (containerId) => {
      const handlers = {};
      const mapObj = {
        containerId,
        lastView: null,
        invalidateSize() {},
        setView(latlng, zoom) { this.lastView = { latlng, zoom }; return this; },
        getZoom() { return this.lastView ? this.lastView.zoom : 6; },
        on(evt, cb) { (handlers[evt] = handlers[evt] || []).push(cb); },
        removeLayer(layer) { if (layer) layer.map = null; },
        addLayer() {},
        // test helper: simulate a real user map click
        _simulateClick(lat, lng) {
          (handlers.click || []).forEach((cb) => cb({ latlng: { lat, lng } }));
        },
      };
      created.maps.push(mapObj);
      return mapObj;
    },
    tileLayer: () => ({ addTo: () => {} }),
    marker: (latlng) => {
      let lat = latlng[0];
      let lng = latlng[1];
      const markerObj = {
        getLatLng() { return { lat, lng }; },
        setLatLng(ll) {
          if (Array.isArray(ll)) { lat = ll[0]; lng = ll[1]; } else { lat = ll.lat; lng = ll.lng; }
        },
        addTo(m) { markerObj.map = m; return markerObj; },
        on() {},
      };
      created.markers.push(markerObj);
      return markerObj;
    },
  };
  return { L, created };
}

// ---- Fake fetch with externally-controllable resolution timing ----
function buildFetchMock() {
  const pending = [];
  const log = [];

  function fetchMock(url, opts) {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    let body;
    try { body = opts && opts.body ? JSON.parse(opts.body) : undefined; } catch { body = opts && opts.body; }
    const entry = { url, method: (opts && opts.method) || 'GET', body, resolve, settled: false };
    pending.push(entry);
    log.push(entry);
    return promise;
  }

  fetchMock.pending = pending;
  fetchMock.log = log;

  // Resolve the oldest still-pending request matching urlSubstr.
  fetchMock.resolveMatching = (urlSubstr, jsonData, { ok = true } = {}) => {
    const entry = pending.find((e) => !e.settled && e.url.includes(urlSubstr));
    if (!entry) throw new Error(`no pending fetch matching "${urlSubstr}"`);
    entry.settled = true;
    entry.resolve({ ok, statusText: ok ? 'OK' : 'Error', json: async () => jsonData });
    return entry;
  };

  fetchMock.countPending = (urlSubstr) => pending.filter((e) => !e.settled && e.url.includes(urlSubstr)).length;

  return fetchMock;
}

async function flushMicrotasks(n = 10) {
  for (let i = 0; i < n; i++) {
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  }
}

// ---- App loading + driving helpers, shared across test files ----

function loadApp() {
  const formStateSrc = fs.readFileSync(FORM_STATE_JS, 'utf8');
  const src = fs.readFileSync(APP_JS, 'utf8');
  const { document, elements, sameAsPrevButtons, modeRadios, geoRadios } = buildDom();
  const { L, created } = buildFakeLeaflet();
  const fetchMock = buildFetchMock();

  // No alert/confirm/prompt: app.js uses in-page dialogs and messages
  // (issue #18), so a stray call throws here instead of passing silently.
  const sandbox = {
    document,
    L,
    fetch: fetchMock,
    console,
    Date, JSON, Math, parseFloat, parseInt, Object, Array, Promise, setTimeout, clearTimeout, setImmediate,
  };
  vm.createContext(sandbox);
  // Loaded as two separate scripts sharing one global scope, mirroring
  // index.html's <script src="/formstate.js"> before <script src="/app.js">.
  vm.runInContext(formStateSrc, sandbox, { filename: FORM_STATE_JS });
  vm.runInContext(src, sandbox, { filename: APP_JS });

  return {
    elements, fetchMock, created, document, sameAsPrevButtons, modeRadios, geoRadios,
  };
}

// Loads formstate.js alone, without app.js or any DOM/Leaflet stubs, so its
// state-machine behaviour can be tested directly through its own function
// interface -- the "tests hit a function interface instead of a fake DOM"
// win from issue #10. requestElevation (issue #12) is formstate.js's one
// dependency on a Web API rather than the DOM, so callers that exercise it
// pass a fetch mock in `sandboxExtra`; everything else needs no sandbox at
// all.
function loadFormStateModule(sandboxExtra = {}) {
  const src = fs.readFileSync(FORM_STATE_JS, 'utf8');
  const sandbox = { ...sandboxExtra };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: FORM_STATE_JS });
  return sandbox.createFormState;
}

function click(el) {
  el.dispatchEvent({ type: 'click', target: el });
}

// ---- Keyword tag input (issue #16) ----
// Chips and suggestions render through innerHTML (a plain string in this
// fake DOM), so these read them back with a regex, and clicks on them go
// through a stand-in target dispatched to the delegating container, the
// same way a real nested click would bubble.

function unescapeHtml(s) {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e]));
}

// The photo's keywords, in order, as the rendered chips show them.
function chipKeywords(elements) {
  return [...elements['keyword-chips'].innerHTML.matchAll(/class="keyword-chip-remove" data-keyword="([^"]*)"/g)]
    .map((m) => unescapeHtml(m[1]));
}

// The suggestion list's keywords, in order (empty while it's hidden).
function suggestionKeywords(elements) {
  if (elements['keyword-suggestions'].hidden) return [];
  return [...elements['keyword-suggestions'].innerHTML.matchAll(/class="keyword-suggestion[^"]*"[^>]*data-keyword="([^"]*)"/g)]
    .map((m) => unescapeHtml(m[1]));
}

// The highlighted suggestion's keyword, or null.
function activeSuggestion(elements) {
  const m = elements['keyword-suggestions'].innerHTML.match(/class="keyword-suggestion active"[^>]*data-keyword="([^"]*)"/);
  return m ? unescapeHtml(m[1]) : null;
}

// Clicks into the entry, which opens the suggestion list.
function openKeywordSuggestions(elements) {
  const el = elements['keyword-entry'];
  el.dispatchEvent({ type: 'click', target: el });
}

function typeInKeywordEntry(elements, text) {
  const el = elements['keyword-entry'];
  el.value = text;
  el.dispatchEvent({ type: 'input', target: el });
}

function pressInKeywordEntry(elements, key) {
  const el = elements['keyword-entry'];
  let defaultPrevented = false;
  el.dispatchEvent({ type: 'keydown', key, target: el, preventDefault: () => { defaultPrevented = true; } });
  return { defaultPrevented };
}

// Opens the suggestion list and clicks kw in it.
function pickKeyword(elements, kw) {
  openKeywordSuggestions(elements);
  const opt = new FakeElement(`keyword-suggestion-${kw}`, 'LI');
  opt.classList.add('keyword-suggestion');
  opt.dataset.keyword = kw;
  elements['keyword-suggestions'].dispatchEvent({ type: 'click', target: opt });
}

// Clicks the × on kw's chip.
function removeKeywordChip(elements, kw) {
  const btn = new FakeElement(`keyword-chip-remove-${kw}`, 'BUTTON');
  btn.classList.add('keyword-chip-remove');
  btn.dataset.keyword = kw;
  elements['keyword-chips'].dispatchEvent({ type: 'click', target: btn });
}

// Simulates clicking a manage-view row's "Rename" button -- same
// stand-in-target pattern as pickKeyword, for app.js's
// #manage-keywords-list delegated click handler.
function clickManageRename(elements, keyword) {
  const btn = new FakeElement(`manage-keyword-rename-${keyword}`, 'BUTTON');
  btn.classList.add('manage-keyword-rename');
  btn.dataset.keyword = keyword;
  elements['manage-keywords-list'].dispatchEvent({ type: 'click', target: btn });
}

// Same as clickManageRename, but for a row's "Delete" button.
function clickManageDelete(elements, keyword) {
  const btn = new FakeElement(`manage-keyword-delete-${keyword}`, 'BUTTON');
  btn.classList.add('manage-keyword-delete');
  btn.dataset.keyword = keyword;
  elements['manage-keywords-list'].dispatchEvent({ type: 'click', target: btn });
}

// Same as clickManageRename, but for a row's "Edit location" button.
function clickManageEditLocation(elements, keyword) {
  const btn = new FakeElement(`manage-keyword-location-${keyword}`, 'BUTTON');
  btn.classList.add('manage-keyword-location');
  btn.dataset.keyword = keyword;
  elements['manage-keywords-list'].dispatchEvent({ type: 'click', target: btn });
}

// Simulates a keydown bubbling up to the document, the same path app.js's
// global keyboard-shortcut listener observes. `target` should be the
// FakeElement that has focus (or omitted, mirroring focus sitting on
// <body>/nothing in particular).
function keydown(doc, key, target) {
  let defaultPrevented = false;
  doc.dispatchEvent({ type: 'keydown', key, target, preventDefault: () => { defaultPrevented = true; } });
  return { defaultPrevented };
}

function photoResponse(index, existing) {
  return {
    done: false,
    index,
    total: 3,
    relPath: `photo${index}.jpg`,
    ext: 'jpg',
    isHeic: false,
    existing: existing || {},
    previous: {},
    previewUrl: '/api/photo/preview',
  };
}

// Drives the app through the start screen up to the first photo being
// rendered, resolving each fetch it issues along the way in order.
// `firstPhoto` overrides the /api/photo/current response.
async function startSession(firstPhoto = photoResponse(0)) {
  const app = loadApp();
  const { fetchMock } = app;

  click(app.elements['start-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/start', { ok: true });
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords', []);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/photo/current', firstPhoto);
  await flushMicrotasks();

  return app;
}

// GET /api/keywords (and the set/clear-location/rename responses that echo
// the same shape) return [{name, location}, ...]; most tests don't care
// about Location, so this lets them keep passing plain name strings.
function toKeywordObjs(keywords) {
  return keywords.map((k) => (typeof k === 'string' ? { name: k, location: null } : k));
}

// Drives the app through the start screen with a given set of already-known
// keywords, mirroring startSession() above but letting the test control the
// /api/keywords response and, optionally, the first photo's existing
// fields (e.g. keywords already in that photo's EXIF).
async function startSessionWithKeywords(keywords, existing) {
  const app = loadApp();
  const { fetchMock } = app;

  click(app.elements['start-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/start', { ok: true });
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords', toKeywordObjs(keywords));
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/photo/current', photoResponse(0, existing));
  await flushMicrotasks();

  return app;
}

module.exports = {
  buildDom, buildFakeLeaflet, buildFetchMock, flushMicrotasks, FakeElement,
  loadApp, loadFormStateModule, click,
  chipKeywords, suggestionKeywords, activeSuggestion, openKeywordSuggestions,
  typeInKeywordEntry, pressInKeywordEntry, pickKeyword, removeKeywordChip,
  clickManageEditLocation,
  clickManageRename, clickManageDelete, keydown, photoResponse, startSession,
  toKeywordObjs, startSessionWithKeywords,
};
