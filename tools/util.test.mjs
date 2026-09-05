// Tests for the shared helpers — the favicon fallback and the DOM builder's
// attribute handling, both of which have caused real bugs.
import test from 'node:test'
import assert from 'node:assert/strict'

import { genericTile, hostnameOf, nextPosition, positionBetween, debounce, safeUrl } from '../src/lib/util.js'

test('the fallback icon is a real image, not lettering', () => {
  const tile = genericTile()
  assert.ok(tile.startsWith('data:image/svg+xml'), 'should be an inline SVG')

  const svg = decodeURIComponent(tile)
  assert.ok(svg.includes('<circle'), 'draws a globe')
  assert.ok(!svg.includes('<text'), 'must never contain a text glyph')
  assert.ok(!/font-size/.test(svg), 'must not style any lettering')
})

test('the fallback icon is identical for every site', () => {
  // It carries no site-derived content at all, so there is nothing to vary.
  assert.equal(genericTile(), genericTile())
})

test('hostnameOf strips www and survives junk', () => {
  assert.equal(hostnameOf('https://www.example.com/path'), 'example.com')
  assert.equal(hostnameOf('not a url'), 'not a url')
})

test('positions order correctly and can always be split', () => {
  const list = [{ position: 1000 }, { position: 2000 }]
  assert.equal(nextPosition(list), 3000)
  const middle = positionBetween(list[0], list[1])
  assert.ok(middle > 1000 && middle < 2000)
  assert.ok(positionBetween(null, list[0]) < 1000)
  assert.ok(positionBetween(list[1], null) > 2000)
  assert.equal(positionBetween(null, null), 1000)
})

test('debounce can be flushed and cancelled', async () => {
  let calls = 0
  const fn = debounce(() => { calls += 1 }, 50)

  fn()
  assert.equal(fn.pending(), true)
  fn.flush()
  assert.equal(calls, 1)
  assert.equal(fn.pending(), false)

  fn()
  fn.cancel()
  assert.equal(fn.pending(), false)
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(calls, 1, 'a cancelled call must never fire')
})

// safeUrl guards every navigation out of the board. Bookmarks arrive from
// imported HTML and shared backups, so the scheme cannot be assumed friendly.

test('ordinary web addresses pass through unchanged', () => {
  assert.equal(safeUrl('https://example.com/a?b=c#d'), 'https://example.com/a?b=c#d')
  assert.equal(safeUrl('http://example.com'), 'http://example.com')
  assert.equal(safeUrl('mailto:someone@example.com'), 'mailto:someone@example.com')
})

test('a scheme-less bookmark is read as https, not as an attack', () => {
  assert.equal(safeUrl('example.com'), 'https://example.com/')
  assert.equal(safeUrl('  example.com/path  '), 'https://example.com/path')
})

test('script-bearing schemes are refused', () => {
  for (const hostile of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '  javascript:alert(1)  ',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
  ]) {
    assert.equal(safeUrl(hostile), '', `${hostile} must not be followable`)
  }
})

test('local and privileged schemes are refused', () => {
  for (const url of ['file:///etc/passwd', 'chrome://settings', 'chrome-extension://abc/page.html']) {
    assert.equal(safeUrl(url), '', `${url} must not be followable`)
  }
})

test('junk resolves to nothing rather than throwing', () => {
  for (const junk of ['', '   ', null, undefined, 'http://', '://nope']) {
    assert.equal(safeUrl(junk), '')
  }
})
