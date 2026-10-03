'use strict';
// Checks web/static/index.html itself, which the other tests never load
// (they stub every element app.js looks up -- see testutil.js): that every
// id app.js looks up exists in the real markup, and the form's labelling --
// icon-only "same as previous" buttons that still name their group, and a
// Date & time section headed once.
//
// Run with: node --test web/apptest/markup.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.resolve(__dirname, '../static/index.html'), 'utf8');
const appJs = fs.readFileSync(path.resolve(__dirname, '../static/app.js'), 'utf8');

test('every element id app.js looks up exists in index.html', () => {
  const ids = new Set([...appJs.matchAll(/\$\('([\w-]+)'\)|L\.map\('([\w-]+)'\)/g)].map((m) => m[1] || m[2]));
  const missing = [...ids].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, []);
});

test('each "same as previous" button is an icon naming its group for screen readers and on hover', () => {
  const buttons = [...html.matchAll(/<button[^>]*class="same-as-prev"[^>]*>([^<]*)<\/button>/g)];
  assert.equal(buttons.length, 4);
  const groups = { location: 'location', dateTime: 'date & time', keywords: 'keywords', caption: 'caption' };
  for (const [tag, text] of buttons) {
    assert.equal(text, '↩');
    const group = tag.match(/data-group="(\w+)"/)[1];
    const label = `Same as previous (${groups[group]})`.replace('&', '&amp;');
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
