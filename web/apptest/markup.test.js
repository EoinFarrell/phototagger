'use strict';
// Checks web/static/index.html itself, which the other tests never load
// (they stub every element app.js looks up -- see testutil.js): that every
// id app.js looks up exists in the real markup, the form's labelling, and
// the button hierarchy and shortcut hints from issue #15's UI review.
//
// Run with: node --test web/apptest/markup.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.resolve(__dirname, '../static/index.html'), 'utf8');
const appJs = fs.readFileSync(path.resolve(__dirname, '../static/app.js'), 'utf8');
const css = fs.readFileSync(path.resolve(__dirname, '../static/style.css'), 'utf8');

function buttonTag(id) {
  const m = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>([\\s\\S]*?)</button>`));
  assert.ok(m, `no <button id="${id}">`);
  return { tag: m[0].slice(0, m[0].indexOf('>') + 1), text: m[1] };
}

test('every element id app.js looks up exists in index.html', () => {
  const ids = new Set([...appJs.matchAll(/\$\('([\w-]+)'\)|L\.map\('([\w-]+)'\)/g)].map((m) => m[1] || m[2]));
  const missing = [...ids].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, []);
});

test('each "same as previous" button says what it does and names its group for screen readers and on hover', () => {
  const buttons = [...html.matchAll(/<button[^>]*class="same-as-prev[^"]*"[^>]*>([^<]*)<\/button>/g)];
  assert.equal(buttons.length, 4);
  const groups = { location: 'location', dateTime: 'date & time', keywords: 'keywords', caption: 'caption' };
  for (const [tag, text] of buttons) {
    assert.equal(text, '↩ Same as last');
    const group = tag.match(/data-group="(\w+)"/)[1];
    const label = `Same as last (${groups[group]})`.replace('&', '&amp;');
    assert.match(tag, new RegExp(`aria-label="${label.replace(/[()]/g, '\\$&')}"`));
    assert.match(tag, new RegExp(`title="${label.replace(/[()]/g, '\\$&')}"`));
  }
});

test('the Date & time section is headed once, with the input labelled for screen readers', () => {
  assert.doesNotMatch(html, /Date\/time/);
  assert.match(html, /<input type="datetime-local" id="datetime-input"[^>]*aria-label="Date &amp; time"/);
});

test('the Favourite picker and the keyword-locations panel are gone', () => {
  assert.doesNotMatch(html, /favourite/i);
  assert.doesNotMatch(html, /keyword-locations/);
});

test('Apply & Next is the only filled primary button in the footer', () => {
  assert.doesNotMatch(buttonTag('apply-button').tag, /class=/);
  assert.match(buttonTag('prev-button').tag, /class="[^"]*secondary/);
  assert.match(buttonTag('skip-button').tag, /class="[^"]*secondary/);
});

test('the footer buttons show their keyboard shortcuts', () => {
  assert.match(buttonTag('prev-button').text, /<kbd>←<\/kbd>/);
  assert.match(buttonTag('skip-button').text, /<kbd>→<\/kbd>/);
  assert.match(buttonTag('apply-button').text, /<kbd>⏎<\/kbd>/);
});

test('both start-screen buttons are type="button", with Manage keywords secondary', () => {
  assert.match(buttonTag('start-button').tag, /type="button"/);
  assert.match(buttonTag('manage-keywords-start-button').tag, /type="button"[^>]*class="secondary"|class="secondary"[^>]*type="button"/);
});

test('the save-pin name row starts collapsed behind its toggle', () => {
  assert.match(html, /<div id="save-located-keyword-row"[^>]*hidden/);
  buttonTag('save-located-keyword-toggle');
});

test('the keyword location editor is a <dialog>', () => {
  assert.match(html, /<dialog id="manage-location-editor"/);
});

test('the class-based jade Pico build is linked, for its button variants and accent', () => {
  assert.match(html, /@picocss\/pico@2\.1\.1\/css\/pico\.jade\.min\.css/);
});

test('style.css takes its reds from the theme, not a hard-coded colour', () => {
  assert.doesNotMatch(css, /#d63535/i);
});

test('app.js uses in-page dialogs and messages, never alert/confirm/prompt', () => {
  assert.doesNotMatch(appJs, /\b(alert|confirm|prompt)\(/);
});

test('the shared confirm/rename dialog is a <dialog>, and the tagging error banner is announced', () => {
  assert.match(html, /<dialog id="ask-dialog"/);
  assert.match(html, /id="tag-error"[^>]*role="alert"|role="alert"[^>]*id="tag-error"/);
});

test('the keyword tag input is a combobox wired to its suggestion listbox, replacing the old field and pills', () => {
  assert.match(html, /<input[^>]*id="keyword-entry"[^>]*>/);
  const entry = html.match(/<input[^>]*id="keyword-entry"[^>]*>/)[0];
  assert.match(entry, /role="combobox"/);
  assert.match(entry, /aria-controls="keyword-suggestions"/);
  assert.match(entry, /aria-expanded="false"/);
  assert.match(html, /<ul id="keyword-suggestions" role="listbox"[^>]*hidden/);
  assert.doesNotMatch(html, /id="keywords-input"|id="keyword-pills"|id="located-keyword-pills"/);
});
