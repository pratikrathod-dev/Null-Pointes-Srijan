// Generates the extension icons as PNGs with no image library — plain zlib.
// Run: node tools/gen-icons.mjs
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons')
mkdirSync(OUT, { recursive: true })

const BG = [79, 70, 229]          // --accent indigo
const FG = [255, 255, 255]

function crc32(buf) {
  let c = ~0
  for (const byte of buf) {
    c ^= byte
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function png(size, pixel) {
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0                        // filter: none
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixel(x, y, size)
      const o = y * (stride + 1) + 1 + x * 4
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8      // bit depth
  ihdr[9] = 6      // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Rounded square with three stacked bars — a little board of folders. */
function icon(x, y, size) {
  const r = size * 0.22
  const inside = (px, py) => {
    const cx = Math.min(Math.max(px, r), size - r)
    const cy = Math.min(Math.max(py, r), size - r)
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r
  }
  if (!inside(x + 0.5, y + 0.5)) return [0, 0, 0, 0]

  const pad = size * 0.22
  const barH = size * 0.11
  const gap = size * 0.09
  for (let i = 0; i < 3; i += 1) {
    const top = pad + i * (barH + gap)
    const width = i === 2 ? (size - pad * 2) * 0.55 : size - pad * 2
    if (y >= top && y < top + barH && x >= pad && x < pad + width) return [...FG, 255]
  }
  return [...BG, 255]
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(OUT, `icon_${size}.png`), png(size, icon))
  console.log(`icons/icon_${size}.png`)
}
