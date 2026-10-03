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
    this.dataset = {};
    this.classList = new FakeClassList();
    this._listeners = {};
  }
  get value() { return this._value; }
  set value(v) { this._value = v; }
  addEventListener(evt, cb) { (this._listeners[evt] = this._listeners[evt] || []).push(cb); }
  dispatchEvent(evt) {
    (this._listeners[evt.type] || []).slice().forEach((cb) => cb(evt));
  }
  // Minimal stand-in for Element.closest -- this fake DOM never parses
  // innerHTML into real child nodes, so it only ever matches itself. That's
  // enough to drive app.js's event-delegated click target (see
  // clickKeywordPill below), which is always the delegation target itself.
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
  'start-view': [], 'tag-view': [], 'done-view': [], 'start-summary': [],
  'mode-count-all': [], 'mode-count-non-tagged': [], 'mode-count-tagged': [],
  'geo-count-all': [], 'geo-count-missing-gps': [],
  'start-button': ['BUTTON'],
  'favourite-select': ['SELECT'],
  'save-favourite-button': ['BUTTON'],
  'favourite-name-input': ['INPUT', 'text'],
  'datetime-input': ['INPUT', 'datetime-local'],
  'offset-input': ['INPUT', 'text'],
  'altitude-input': ['INPUT', 'number'],
  'keywords-input': ['INPUT', 'text'],
  'keyword-pills': [],
  'keyword-locations-list': [],
  'caption-input': ['TEXTAREA'],
  'additional-details': [], 'additional-required-badge': [],
  'tag-progress': [], 'tag-relpath': [], 'preview-img': [],
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
    map: () => {
      const handlers = {};
      const mapObj = {
        lastView: null,
        setView(latlng, zoom) { this.lastView = { latlng, zoom }; return this; },
        getZoom() { return this.lastView ? this.lastView.zoom : 6; },
        on(evt, cb) { (handlers[evt] = handlers[evt] || []).push(cb); },
        removeLayer() {},
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
        addTo() { return markerObj; },
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
  const { document, elements, modeRadios, geoRadios } = buildDom();
  const { L, created } = buildFakeLeaflet();
  const fetchMock = buildFetchMock();
  const alerts = [];
  const confirms = [];
  // deleteKeyword's confirm() gate defaults to "OK" so tests that don't care
  // about the prompt (most of them) aren't forced to set this up -- tests
  // covering the cancel path set it to false via the returned confirm object.
  const confirmState = { result: true };

  const sandbox = {
    document,
    L,
    fetch: fetchMock,
    alert: (msg) => alerts.push(msg),
    confirm: (msg) => { confirms.push(msg); return confirmState.result; },
    console,
    Date, JSON, Math, parseFloat, parseInt, Object, Array, Promise, setTimeout, clearTimeout, setImmediate,
  };
  vm.createContext(sandbox);
  // Loaded as two separate scripts sharing one global scope, mirroring
  // index.html's <script src="/formstate.js"> before <script src="/app.js">.
  vm.runInContext(formStateSrc, sandbox, { filename: FORM_STATE_JS });
  vm.runInContext(src, sandbox, { filename: APP_JS });

  return { elements, fetchMock, alerts, confirms, confirmState, created, document, modeRadios, geoRadios };
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

// Simulates clicking a specific rendered keyword pill. app.js renders pills
// into #keyword-pills' innerHTML (a plain string in this fake DOM, with no
// real child elements to query), so this builds a stand-in target carrying
// just what the delegated click handler reads off it -- the .keyword-pill
// class and data-keyword -- and dispatches through the container exactly as
// a real nested click would bubble.
function clickKeywordPill(elements, keyword) {
  const pill = new FakeElement(`keyword-pill-${keyword}`, 'BUTTON');
  pill.classList.add('keyword-pill');
  pill.dataset.keyword = keyword;
  elements['keyword-pills'].dispatchEvent({ type: 'click', target: pill });
}

// Same as clickKeywordPill, but for a pill's × delete button.
function clickKeywordDeletePill(elements, keyword) {
  const btn = new FakeElement(`keyword-pill-delete-${keyword}`, 'BUTTON');
  btn.classList.add('keyword-pill-delete');
  btn.dataset.keyword = keyword;
  elements['keyword-pills'].dispatchEvent({ type: 'click', target: btn });
}

// Simulates clicking a keyword-location-management row's "Set to current
// pin" button -- same stand-in-target pattern as clickKeywordPill, for
// app.js's #keyword-locations-list delegated click handler.
function clickKeywordLocationSet(elements, keyword) {
  const btn = new FakeElement(`kw-loc-set-${keyword}`, 'BUTTON');
  btn.classList.add('kw-loc-set');
  btn.dataset.keyword = keyword;
  elements['keyword-locations-list'].dispatchEvent({ type: 'click', target: btn });
}

// Same as clickKeywordLocationSet, but for a row's "Clear" button.
function clickKeywordLocationClear(elements, keyword) {
  const btn = new FakeElement(`kw-loc-clear-${keyword}`, 'BUTTON');
  btn.classList.add('kw-loc-clear');
  btn.dataset.keyword = keyword;
  elements['keyword-locations-list'].dispatchEvent({ type: 'click', target: btn });
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
async function startSession() {
  const app = loadApp();
  const { fetchMock } = app;

  click(app.elements['start-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/start', { ok: true });
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/favourites', []);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/keywords', []);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/photo/current', photoResponse(0));
  await flushMicrotasks();

  return app;
}

module.exports = {
  buildDom, buildFakeLeaflet, buildFetchMock, flushMicrotasks, FakeElement,
  loadApp, loadFormStateModule, click, clickKeywordPill, clickKeywordDeletePill,
  clickKeywordLocationSet, clickKeywordLocationClear, keydown, photoResponse, startSession,
};
