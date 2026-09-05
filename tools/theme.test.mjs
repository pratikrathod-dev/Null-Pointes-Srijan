// Reads the real stylesheet and checks both themes are actually legible.
// A dark mode where cards and the page are the same black is the failure this
// exists to catch — it is easy to introduce and hard to notice while editing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src/newtab/newtab.css'),
  'utf8',
)

function tokens(block) {
  return Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6});/g)]
    .map((m) => [m[1], m[2]]))
}

const LIGHT = tokens(CSS.split(':root {')[1].split('}')[0])
const DARK = tokens(CSS.split("data-theme='dark'")[1].split('}')[0])

function luminance(hex) {
  const channel = (pair) => {
    const c = parseInt(pair, 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(hex.slice(1, 3))
    + 0.7152 * channel(hex.slice(3, 5))
    + 0.0722 * channel(hex.slice(5, 7))
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const THEMES = [['light', LIGHT], ['dark', DARK]]

test('both themes define every surface the layout uses', () => {
  const needed = ['surface', 'surface-lowest', 'surface-low', 'surface-container',
    'surface-high', 'surface-highest', 'card-bg', 'card-border',
    'on-surface', 'on-surface-variant', 'on-surface-muted', 'primary']
  for (const [name, t] of THEMES) {
    for (const key of needed) {
      assert.ok(t[key], `${name} theme is missing --${key}`)
    }
  }
})

test('a folder card is distinguishable from the page behind it', () => {
  for (const [name, t] of THEMES) {
    const ratio = contrast(t['card-bg'], t.surface)
    assert.ok(ratio >= 1.10,
      `${name}: card ${t['card-bg']} on page ${t.surface} is only ${ratio.toFixed(3)}:1 — they read as one surface`)
  }
})

test('a card has a visible edge as well as a fill', () => {
  for (const [name, t] of THEMES) {
    const ratio = contrast(t['card-border'], t['card-bg'])
    assert.ok(ratio >= 1.12,
      `${name}: border ${t['card-border']} on card ${t['card-bg']} is only ${ratio.toFixed(2)}:1`)
  }
})

test('the container ladder always steps in one direction', () => {
  // `surface` is the page, a separate role — it is not part of this ladder.
  for (const [name, t] of THEMES) {
    const stack = ['surface-lowest', 'surface-low', 'surface-container', 'surface-high', 'surface-highest']
      .map((k) => luminance(t[k]))
    const rising = stack.every((v, i) => i === 0 || v >= stack[i - 1])
    const falling = stack.every((v, i) => i === 0 || v <= stack[i - 1])
    assert.ok(rising || falling, `${name}: the container ladder is not monotonic — ${stack.map((v) => v.toFixed(3))}`)
  }
})

test('body text meets AA against every surface it sits on', () => {
  for (const [name, t] of THEMES) {
    for (const surface of ['surface', 'card-bg', 'surface-container', 'surface-high']) {
      const ratio = contrast(t['on-surface'], t[surface])
      assert.ok(ratio >= 4.5,
        `${name}: text ${t['on-surface']} on --${surface} ${t[surface]} is ${ratio.toFixed(2)}:1`)
    }
  }
})

test('secondary text meets AA on the main surfaces', () => {
  for (const [name, t] of THEMES) {
    for (const surface of ['surface', 'card-bg']) {
      const ratio = contrast(t['on-surface-variant'], t[surface])
      assert.ok(ratio >= 4.5,
        `${name}: secondary text ${t['on-surface-variant']} on --${surface} is ${ratio.toFixed(2)}:1`)
    }
  }
})

test('muted text stays readable at large-text AA', () => {
  for (const [name, t] of THEMES) {
    const ratio = contrast(t['on-surface-muted'], t.surface)
    assert.ok(ratio >= 3.0, `${name}: muted text is only ${ratio.toFixed(2)}:1`)
  }
})

test('the accent is usable as a link colour on both surfaces', () => {
  for (const [name, t] of THEMES) {
    for (const surface of ['surface', 'card-bg']) {
      const ratio = contrast(t.primary, t[surface])
      assert.ok(ratio >= 3.0,
        `${name}: primary ${t.primary} on --${surface} is only ${ratio.toFixed(2)}:1`)
    }
  }
})

test('menus float above dialogs', () => {
  const zOf = (selector) => {
    const block = CSS.split(`${selector} {`)[1].split('}')[0]
    return Number(block.match(/z-index:\s*(\d+)/)?.[1] ?? 0)
  }
  assert.ok(zOf('.menu') > zOf('.overlay'),
    'a menu opened inside a dialog would render behind the backdrop')
})

test('the bundled fonts are declared with a format Chrome accepts', () => {
  const formats = [...CSS.matchAll(/format\('([^']+)'\)/g)].map((m) => m[1])
  assert.ok(formats.length >= 2, 'both bundled fonts should be declared')
  for (const f of formats) {
    // 'woff2-variations' is non-standard: Chrome skips the whole src entry and
    // silently falls back to a system font.
    assert.equal(f, 'woff2', `unrecognised font format "${f}" — the font will not load`)
  }
})
