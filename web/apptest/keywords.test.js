'use strict';
// Covers the Keywords tag input (issue #16): the photo's keywords as chips,
// a text entry that suggests known keywords as you type, and the keyboard
// rules -- Enter or comma picks the highlighted suggestion (or adds the
// typed text when nothing is highlighted), Backspace in an empty entry
// removes the last chip, the arrow keys move the highlight and Escape
// closes the list. Located keywords' map behaviour is covered in
// located-keywords.test.js.
//
// Run with: node --test web/apptest/keywords.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  flushMicrotasks, click, startSessionWithKeywords, photoResponse,
  chipKeywords, suggestionKeywords, activeSuggestion, openKeywordSuggestions,
  typeInKeywordEntry, pressInKeywordEntry, pickKeyword, removeKeywordChip,
} = require('./testutil');

const CONCERT = { name: 'concert', location: { lat: 40.7128, lon: -74.006, alt: 10 } };

async function applyBody(elements, fetchMock) {
  click(elements['apply-button']);
  await flushMicrotasks();
  return fetchMock.log.find((e) => e.url.includes('/api/photo/apply')).body;
}

test('the photo\'s existing keywords render as chips, located ones with a pin', async () => {
  const { elements } = await startSessionWithKeywords([CONCERT, 'beach'], { keywords: ['beach', 'concert'] });

  assert.deepEqual(chipKeywords(elements), ['beach', 'concert']);
  assert.match(elements['keyword-chips'].innerHTML, /📍<\/span><span class="visually-hidden">located keyword <\/span>concert/);
  assert.doesNotMatch(elements['keyword-chips'].innerHTML, /📍[^]*beach/);
});

test('clicking into the entry opens the suggestions; tabbing into it doesn\'t', async () => {
  const { elements } = await startSessionWithKeywords(['beach']);

  elements['keyword-entry'].dispatchEvent({ type: 'focus', target: elements['keyword-entry'] });
  assert.deepEqual(suggestionKeywords(elements), []);

  openKeywordSuggestions(elements);
  assert.deepEqual(suggestionKeywords(elements), ['beach']);
});

test('focusing the entry suggests every known keyword not already on the photo, located ones first', async () => {
  const { elements } = await startSessionWithKeywords(['beach', CONCERT, 'family'], { keywords: ['family'] });

  openKeywordSuggestions(elements);

  assert.deepEqual(suggestionKeywords(elements), ['concert', 'beach']);
  assert.match(elements['keyword-suggestions'].innerHTML, /📍<\/span>[^]*concert/);
});

test('typing filters the suggestions, ignoring case', async () => {
  const { elements } = await startSessionWithKeywords(['Beach', 'bear', 'family']);

  typeInKeywordEntry(elements, 'EA');

  assert.deepEqual(suggestionKeywords(elements), ['Beach', 'bear']);
});

test('Enter picks the suggestion the typed text starts, clears the entry, and touches Keywords', async () => {
  const { elements, fetchMock } = await startSessionWithKeywords(['beach']);

  typeInKeywordEntry(elements, 'bea');
  assert.equal(activeSuggestion(elements), 'beach');
  const { defaultPrevented } = pressInKeywordEntry(elements, 'Enter');

  assert.equal(defaultPrevented, true);
  assert.deepEqual(chipKeywords(elements), ['beach']);
  assert.equal(elements['keyword-entry'].value, '');
  const body = await applyBody(elements, fetchMock);
  assert.equal(body.keywordsTouched, true);
  assert.deepEqual(body.keywords, ['beach']);
});

test('nothing is highlighted when the typed text only appears mid-word, so Enter adds the text itself', async () => {
  const { elements } = await startSessionWithKeywords(['beach']);

  typeInKeywordEntry(elements, 'each');
  assert.equal(activeSuggestion(elements), null);
  pressInKeywordEntry(elements, 'Enter');

  assert.deepEqual(chipKeywords(elements), ['each']);
});

test('comma picks the highlighted suggestion, like Enter', async () => {
  const { elements } = await startSessionWithKeywords(['beach']);

  typeInKeywordEntry(elements, 'bea');
  const { defaultPrevented } = pressInKeywordEntry(elements, ',');

  assert.equal(defaultPrevented, true);
  assert.deepEqual(chipKeywords(elements), ['beach']);
});

test('Escape drops the highlight, so Enter then adds exactly what was typed', async () => {
  const { elements } = await startSessionWithKeywords(['beach']);

  typeInKeywordEntry(elements, 'bea');
  pressInKeywordEntry(elements, 'Escape');
  pressInKeywordEntry(elements, 'Enter');

  assert.deepEqual(chipKeywords(elements), ['bea']);
});

test('typed text matching a known keyword in another case adds the known keyword', async () => {
  const { elements } = await startSessionWithKeywords(['Beach']);

  typeInKeywordEntry(elements, 'beach');
  pressInKeywordEntry(elements, 'Escape');
  pressInKeywordEntry(elements, 'Enter');

  assert.deepEqual(chipKeywords(elements), ['Beach']);
});

test('pasted comma-separated text adds each keyword', async () => {
  const { elements } = await startSessionWithKeywords([]);

  typeInKeywordEntry(elements, 'sunset, beach ,,  dog ');
  pressInKeywordEntry(elements, 'Enter');

  assert.deepEqual(chipKeywords(elements), ['sunset', 'beach', 'dog']);
});

test('picking a suggestion after earlier comma-separated text adds that text too', async () => {
  const { elements } = await startSessionWithKeywords(['concert']);

  typeInKeywordEntry(elements, 'gig, con');
  pressInKeywordEntry(elements, 'Enter');

  assert.deepEqual(chipKeywords(elements), ['gig', 'concert']);
});

test('the arrow keys move the highlight, and Enter picks it', async () => {
  const { elements } = await startSessionWithKeywords(['beach', 'family', 'dog']);

  openKeywordSuggestions(elements);
  assert.equal(activeSuggestion(elements), null);
  assert.equal(pressInKeywordEntry(elements, 'ArrowDown').defaultPrevented, true);
  assert.equal(activeSuggestion(elements), 'beach');
  pressInKeywordEntry(elements, 'ArrowDown');
  pressInKeywordEntry(elements, 'ArrowDown');
  pressInKeywordEntry(elements, 'ArrowDown'); // stops at the last
  assert.equal(activeSuggestion(elements), 'dog');
  pressInKeywordEntry(elements, 'ArrowUp');
  pressInKeywordEntry(elements, 'Enter');

  assert.deepEqual(chipKeywords(elements), ['family']);
});

test('Escape closes the suggestions', async () => {
  const { elements } = await startSessionWithKeywords(['beach']);

  openKeywordSuggestions(elements);
  pressInKeywordEntry(elements, 'Escape');

  assert.equal(elements['keyword-suggestions'].hidden, true);
  assert.equal(elements['keyword-entry'].getAttribute('aria-expanded'), 'false');
});

test('Enter in an empty entry with nothing highlighted does nothing', async () => {
  const { elements } = await startSessionWithKeywords(['beach'], { keywords: ['family'] });

  pressInKeywordEntry(elements, 'Enter');

  assert.deepEqual(chipKeywords(elements), ['family']);
});

test('Backspace in an empty entry removes the last chip; with text in the entry it just edits the text', async () => {
  const { elements, fetchMock } = await startSessionWithKeywords([], { keywords: ['beach', 'family'] });

  typeInKeywordEntry(elements, 'x');
  assert.equal(pressInKeywordEntry(elements, 'Backspace').defaultPrevented, false);
  assert.deepEqual(chipKeywords(elements), ['beach', 'family']);

  typeInKeywordEntry(elements, '');
  assert.equal(pressInKeywordEntry(elements, 'Backspace').defaultPrevented, true);
  assert.deepEqual(chipKeywords(elements), ['beach']);
  const body = await applyBody(elements, fetchMock);
  assert.equal(body.keywordsTouched, true);
});

test('clicking a suggestion adds it', async () => {
  const { elements } = await startSessionWithKeywords(['beach']);

  pickKeyword(elements, 'beach');

  assert.deepEqual(chipKeywords(elements), ['beach']);
  assert.deepEqual(suggestionKeywords(elements), [], 'nothing left to suggest');
});

test('a chip\'s × removes it and touches Keywords', async () => {
  const { elements, fetchMock } = await startSessionWithKeywords([], { keywords: ['beach', 'family'] });

  removeKeywordChip(elements, 'beach');

  assert.deepEqual(chipKeywords(elements), ['family']);
  const body = await applyBody(elements, fetchMock);
  assert.equal(body.keywordsTouched, true);
  assert.deepEqual(body.keywords, ['family']);
});

test('adding a keyword the photo already has doesn\'t duplicate it', async () => {
  const { elements } = await startSessionWithKeywords([], { keywords: ['beach'] });

  typeInKeywordEntry(elements, 'BEACH');
  pressInKeywordEntry(elements, ',');

  assert.deepEqual(chipKeywords(elements), ['beach']);
});

test('Apply adds text still sitting in the entry, as Enter would', async () => {
  const { elements, fetchMock } = await startSessionWithKeywords(['beach'], { keywords: ['family'] });

  typeInKeywordEntry(elements, 'bea'); // highlights "beach"
  const body = await applyBody(elements, fetchMock);

  assert.deepEqual(body.keywords, ['family', 'beach']);
  assert.equal(body.keywordsTouched, true);
});

test('a brand-new keyword just Applied is suggested straight away, without a fresh /api/keywords fetch', async () => {
  const { elements, fetchMock } = await startSessionWithKeywords([]);

  typeInKeywordEntry(elements, 'sunset');
  pressInKeywordEntry(elements, 'Enter');
  click(elements['apply-button']);
  await flushMicrotasks();
  fetchMock.resolveMatching('/api/photo/apply', photoResponse(1));
  await flushMicrotasks();
  openKeywordSuggestions(elements);

  assert.deepEqual(suggestionKeywords(elements), ['sunset']);
});

test('a keyword added and removed again before Apply isn\'t suggested later', async () => {
  const { elements } = await startSessionWithKeywords([]);

  typeInKeywordEntry(elements, 'sunst');
  pressInKeywordEntry(elements, 'Enter');
  removeKeywordChip(elements, 'sunst');
  openKeywordSuggestions(elements);

  assert.deepEqual(suggestionKeywords(elements), []);
});

test('adding and removing a keyword is announced', async () => {
  const { elements } = await startSessionWithKeywords([]);

  typeInKeywordEntry(elements, 'sunset');
  pressInKeywordEntry(elements, 'Enter');
  assert.equal(elements['keyword-status'].textContent, 'Added sunset');

  removeKeywordChip(elements, 'sunset');
  assert.equal(elements['keyword-status'].textContent, 'Removed sunset');
});

test('Keywords "Same as last" copies the previous keywords and clears any half-typed text', async () => {
  const app = await startSessionWithKeywords([]);
  click(app.elements['skip-button']);
  await flushMicrotasks();
  app.fetchMock.resolveMatching('/api/photo/skip', { ...photoResponse(1), previous: { keywords: { keywords: ['gig', 'family'] } } });
  await flushMicrotasks();
  typeInKeywordEntry(app.elements, 'stray');

  click(app.sameAsPrevButtons.find((b) => b.dataset.group === 'keywords'));

  assert.deepEqual(chipKeywords(app.elements), ['gig', 'family']);
  assert.equal(app.elements['keyword-entry'].value, '');
  const body = await applyBody(app.elements, app.fetchMock);
  assert.deepEqual(body.keywords, ['gig', 'family']);
  assert.equal(body.keywordsTouched, true);
});

test('a keyword already on the photo (e.g. tagged outside this tool) becomes known as soon as the photo loads', async () => {
  const { elements } = await startSessionWithKeywords([], { keywords: ['archive'] });

  removeKeywordChip(elements, 'archive');
  openKeywordSuggestions(elements);

  assert.deepEqual(suggestionKeywords(elements), ['archive']);
});
