// Builds the .zip to upload to the Chrome Web Store.
//
// The source folder is not the same thing as the package: assets/, tools/, the
// README and package.json are all development scaffolding, and assets/ alone is
// several megabytes. Uploading the folder wholesale ships all of it. This walks
// the manifest instead and takes only what the extension actually loads.
//
//   node tools/package.mjs
//
// It also runs the checks the store cares about before writing anything, so a
// broken manifest or a missing icon fails here rather than after an upload.

import { readFileSync, existsSync, statSync, mkdirSync, rmSync, cpSync, readdirSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'dist')

// Everything the extension loads at runtime. Anything not listed is scaffolding.
const SHIPPED = ['manifest.json', 'icons', 'src']

// Development files that must never reach the store, even inside a shipped dir.
const EXCLUDE = new Set(['.DS_Store', 'Thumbs.db'])

// UTF-8 bytes that got decoded as single-byte text and re-encoded leave a
// signature behind. There are two variants and both have to be caught:
//   cp1252:   an em dash becomes "\u00e2\u20ac\u201d"   (0x80 -> euro, 0x94 -> right quote)
//   latin-1:  an em dash becomes "\u00e2\u0080\u0094"   (the C1 controls survive as-is)
// C1 controls (U+0080-U+009F) never legitimately appear in a manifest, so
// their presence alone is proof. This project shipped a manifest reading
// "Tabspace \u00e2\u20ac\u201d tabs, finally sorted" for exactly this reason.
const MOJIBAKE = /[\u0080-\u009f]|\u00e2\u20ac|[\u00c3\u00c2][\u00a0-\u00bf]/

const problems = []
const notes = []

// --- the manifest must be valid, and say what we think it says --------------
const manifestPath = path.join(ROOT, 'manifest.json')
let manifest
try {
  const raw = readFileSync(manifestPath, 'utf8')
  manifest = JSON.parse(raw)

  // A UTF-8 file misread as Latin-1 produces these. The store shows the result
  // verbatim as the extension's name, which is how a tagline turns into
  // mojibake on the listing page.
  if (MOJIBAKE.test(raw)) {
    problems.push('manifest.json contains mojibake - it is not clean UTF-8')
  }
} catch (err) {
  problems.push(`manifest.json is not valid JSON: ${err.message}`)
}

if (manifest) {
  if (!manifest.name || manifest.name.length > 75) problems.push('name must be 1-75 characters')
  if (!manifest.description) problems.push('description is required')
  else if (manifest.description.length > 132) {
    problems.push(`description is ${manifest.description.length} characters; the store allows 132`)
  }
  if (!/^\d+(\.\d+){0,3}$/.test(manifest.version ?? '')) problems.push('version must be one to four dot-separated numbers')

  // Every path the manifest names must exist, or the upload is rejected.
  const referenced = [
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
    manifest.action?.default_popup,
    manifest.background?.service_worker,
    manifest.side_panel?.default_path,
    ...Object.values(manifest.chrome_url_overrides ?? {}),
  ].filter(Boolean)

  for (const rel of referenced) {
    if (!existsSync(path.join(ROOT, rel))) problems.push(`manifest references a missing file: ${rel}`)
  }

  // The package version and package.json drifting apart is how a build gets
  // uploaded under the wrong version number.
  try {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    if (pkg.version !== manifest.version) {
      notes.push(`package.json is ${pkg.version} but the manifest is ${manifest.version}`)
    }
  } catch { /* package.json is not shipped, so this is only a note */ }
}

if (problems.length) {
  console.error('\nCannot package:\n')
  for (const p of problems) console.error(`  - ${p}`)
  console.error('')
  process.exit(1)
}

// --- stage only the shipped files ------------------------------------------
//
// Staging happens in the OS temp directory, never inside the project. A staged
// copy under dist/ leaves a second manifest.json in the source tree, and the
// Web Store rejects any upload that contains more than one:
//
//   More than one manifest found in package:
//     tabspace/dist/tabspace/manifest.json, tabspace/manifest.json
//
// That is what zipping the project folder by hand produces while a staged build
// is sitting inside it. dist/ now holds the .zip and nothing else, so the
// mistake is not available to make.
const stageRoot = mkdtempSync(path.join(tmpdir(), 'tabspace-pkg-'))
const stage = path.join(stageRoot, 'tabspace')
rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
mkdirSync(OUT_DIR, { recursive: true })

for (const entry of SHIPPED) {
  const from = path.join(ROOT, entry)
  if (!existsSync(from)) { console.error(`  missing: ${entry}`); process.exit(1) }
  cpSync(from, path.join(stage, entry), {
    recursive: true,
    filter: (src) => !EXCLUDE.has(path.basename(src)),
  })
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    return e.isDirectory() ? walk(full) : [full]
  })
}

const staged = walk(stage)
const bytes = staged.reduce((sum, f) => sum + statSync(f).size, 0)

// Check the store's own rule here rather than discovering it after an upload:
// exactly one manifest, and it must sit at the top level of the package.
const manifests = staged.filter((f) => path.basename(f) === 'manifest.json')
if (manifests.length !== 1 || path.dirname(manifests[0]) !== stage) {
  console.error('')
  console.error('  Refusing to write a package the store would reject.')
  console.error(`  Found ${manifests.length} manifest.json in the staged tree:`)
  for (const m of manifests) {
    console.error(`    - ${path.relative(stage, m).split(path.sep).join('/')}`)
  }
  console.error('')
  rmSync(stageRoot, { recursive: true, force: true })
  process.exit(1)
}

// --- zip it ----------------------------------------------------------------
const zipPath = path.join(OUT_DIR, `tabspace-${manifest.version}.zip`)
try {
  // PowerShell ships with Windows; zip covers the rest.
  if (process.platform === 'win32') {
    execFileSync('powershell', [
      '-NoProfile', '-Command',
      `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zipPath}' -Force`,
    ], { stdio: 'pipe' })
  } else {
    execFileSync('zip', ['-r', '-q', zipPath, '.'], { cwd: stage, stdio: 'pipe' })
  }
} catch (err) {
  console.error(`\n  Could not create the zip: ${err.message}`)
  console.error(`  Staged files are at ${stage} - zip that folder's contents by hand.\n`)
  process.exit(1)
}

const zipped = statSync(zipPath).size
rmSync(stageRoot, { recursive: true, force: true })
const kb = (n) => `${(n / 1024).toFixed(0)} KB`

console.log(`\n  Packaged ${manifest.name} ${manifest.version}`)
console.log(`  ${staged.length} files, ${kb(bytes)} unpacked, ${kb(zipped)} zipped`)
console.log(`\n  Upload:  ${zipPath}`)
console.log('\n  Note: the zip contains the manifest at its top level, which is what')
console.log('  the Developer Dashboard expects.')
for (const n of notes) console.log(`\n  ! ${n}`)
console.log('')
