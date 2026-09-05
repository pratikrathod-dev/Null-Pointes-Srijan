// Renders the extension's PNG icons from the vector masters in assets/.
//
//   node tools/make-icons.mjs
//
// The icons used to be resampled from a 512px screenshot of an app-icon mockup,
// which is why they carried its drop shadow and its white card's rounded corners
// on top of their own. They are drawn from assets/icon.svg now, so every size is
// rendered rather than resized, and 16 and 32 come from assets/icon-small.svg --
// a cut-down mark, because the full one is mush at that size.
//
// Chrome does the rasterising: it is the renderer the icons are actually judged
// in, and it saves the project a native image dependency. Any Chrome or Chromium
// will do; set CHROME to point at one the script cannot find by itself.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'icons')

// 16 and 32 are the toolbar; 48 is the extensions page; 128 is the Web Store
// tile and what the board itself draws as the brand mark.
const SIZES = [
  { size: 16, art: 'icon-tiny.svg' },
  { size: 32, art: 'icon-small.svg' },
  { size: 48, art: 'icon.svg' },
  { size: 128, art: 'icon.svg' },
]

const CANDIDATES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)

const chrome = CANDIDATES.find((p) => existsSync(p))
if (!chrome) {
  console.error('No Chrome found. Set CHROME to a Chrome or Chromium binary and run again.')
  process.exit(1)
}

mkdirSync(OUT, { recursive: true })
const work = join(tmpdir(), `tabspace-icons-${process.pid}`)
mkdirSync(work, { recursive: true })

try {
  for (const { size, art } of SIZES) {
    // The SVG goes in an <img> at exactly the target size, on a page with no
    // margin, so the screenshot is the icon and nothing else.
    const page = join(work, `${size}.html`)
    writeFileSync(page, `<style>html,body{margin:0;padding:0;background:transparent}`
      + `img{display:block;width:${size}px;height:${size}px}</style>`
      + `<img src="${pathToFileURL(join(ROOT, 'assets', art)).href}">`)

    const out = join(OUT, `icon_${size}.png`)
    rmSync(out, { force: true })
    execFileSync(chrome, [
      '--headless', '--disable-gpu', '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--default-background-color=00000000',   // transparent, not white
      `--window-size=${size},${size}`,
      `--screenshot=${out}`,
      '--virtual-time-budget=2000',
      pathToFileURL(page).href,
    ], { stdio: 'ignore' })

    if (!existsSync(out)) throw new Error(`Chrome produced no icons/icon_${size}.png`)
    console.log(`  icons/icon_${size}.png   from assets/${art}`)
  }

  // The vector ships too. assets/ is development scaffolding and never reaches
  // the store (see tools/package.mjs), but the board draws its own brand mark at
  // 30px, and a 30px sample of the 128 PNG is soft where the SVG is exact.
  copyFileSync(join(ROOT, 'assets', 'icon.svg'), join(OUT, 'icon.svg'))
  console.log('  icons/icon.svg           copied for the in-app brand mark')
  console.log('')
  console.log('Reload the extension at chrome://extensions to see the new icons.')
} finally {
  rmSync(work, { recursive: true, force: true })
}
