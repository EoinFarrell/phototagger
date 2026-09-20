'use strict';
// Minimal dependency-free DOM/Leaflet/fetch stubs, plus shared test-drive
// helpers, sufficient to load and run the real web/static/app.js under
// Node's vm module. Not part of the served app (kept out of web/static so
// //go:embed never picks it up).

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_JS = path.resolve(__dirname, '../static/app.js');

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
}

// Single source of truth for every stubbed element id, and (where it
// matters) its tagName/type -- mirroring web/static/index.html closely
// enough for the keyboard-shortcut guards (isFreeTextField/isFormControl in
// app.js) to tell real form controls apart from everything else, the same
// way a real DOM would. Ids with no entry here fall back to a plain DIV,
// which is fine for elements the shortcut guards never inspect.
const ELEMENT_META = {
  'start-view': [], 'tag-view': [], 'done-view': [], 'start-summary': [],
  'start-button': ['BUTTON'],
  'favourite-select': ['SELECT'],
  'save-favourite-button': ['BUTTON'],
  'favourite-name-input': ['INPUT', 'text'],
  'datetime-input': ['INPUT', 'datetime-local'],
  'offset-input': ['INPUT', 'text'],
  'altitude-input': ['INPUT', 'number'],
  'keywords-input': ['INPUT', 'text'],
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

  const docListeners = {};
  const document = {
    getElementById: (id) => {
      if (!elements[id]) throw new Error(`no stub element for id="${id}"`);
      return elements[id];
    },
    querySelectorAll: (sel) => (sel === '.same-as-prev' ? sameAsPrevButtons : []),
    querySelector: (sel) => (sel === 'input[name="mode"]:checked' ? (modeRadios.find((r) => r.checked) || null) : null),
    addEventListener: (evt, cb) => { (docListeners[evt] = docListeners[evt] || []).push(cb); },
    dispatchEvent: (evt) => { (docListeners[evt.type] || []).slice().forEach((cb) => cb(evt)); },
  };

  return { document, elements, sameAsPrevButtons, modeRadios };
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
  const src = fs.readFileSync(APP_JS, 'utf8');
  const { document, elements, modeRadios } = buildDom();
  const { L, created } = buildFakeLeaflet();
  const fetchMock = buildFetchMock();
  const alerts = [];

  const sandbox = {
    document,
    L,
    fetch: fetchMock,
    alert: (msg) => alerts.push(msg),
    console,
    Date, JSON, Math, parseFloat, parseInt, Object, Array, Promise, setTimeout, clearTimeout, setImmediate,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: APP_JS });

  return { elements, fetchMock, alerts, created, document, modeRadios };
}

function click(el) {
  el.dispatchEvent({ type: 'click', target: el });
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
  fetchMock.resolveMatching('/api/photo/current', photoResponse(0));
  await flushMicrotasks();

  return app;
}

module.exports = {
  buildDom, buildFakeLeaflet, buildFetchMock, flushMicrotasks, FakeElement,
  loadApp, click, keydown, photoResponse, startSession,
};
