// Folder headers and sticky notes put dark text directly on these colours, so
// a swatch that is too dark makes its title unreadable. Checked here rather
// than by eye, because the palettes are long and easy to extend carelessly.
import test from 'node:test'
import assert from 'node:assert/strict'

import { FOLDER_COLORS, STICKER_COLORS } from '../src/lib/model.js'

/** WCAG relative luminance. */
function luminance(hex) {
  const channel = (v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const r = channel(parseInt(hex.slice(1, 3), 16))
  const g = channel(parseInt(hex.slice(3, 5), 16))
  const b = channel(parseInt(hex.slice(5, 7), 16))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// The on-colour used for folder headers and sticker text.
const INK = '#0e1116'

test('every colour is a valid six-digit hex', () => {
  for (const c of [...FOLDER_COLORS, ...STICKER_COLORS]) {
    assert.match(c, /^#[0-9A-Fa-f]{6}$/, `${c} is not a hex colour`)
  }
})

test('folder colours carry dark text at AA contrast', () => {
  for (const c of FOLDER_COLORS) {
    const ratio = contrast(c, INK)
    assert.ok(ratio >= 4.5, `${c} gives only ${ratio.toFixed(2)}:1 against the header text`)
  }
})

test('sticker colours carry dark text at AA contrast', () => {
  for (const c of STICKER_COLORS) {
    const ratio = contrast(c, INK)
    assert.ok(ratio >= 4.5, `${c} gives only ${ratio.toFixed(2)}:1 against the note text`)
  }
})

test('there are no duplicate swatches within a palette', () => {
  for (const [name, palette] of [['folder', FOLDER_COLORS], ['sticker', STICKER_COLORS]]) {
    const lower = palette.map((c) => c.toLowerCase())
    assert.equal(new Set(lower).size, lower.length, `${name} palette repeats a colour`)
  }
})

test('the palettes are big enough to be worth calling a choice', () => {
  assert.ok(FOLDER_COLORS.length >= 20, `only ${FOLDER_COLORS.length} folder colours`)
  assert.ok(STICKER_COLORS.length >= 20, `only ${STICKER_COLORS.length} sticker colours`)
})
