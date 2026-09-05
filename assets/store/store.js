/* Builds one Chrome Web Store listing image from the config in window.SHOT.
 *
 * The board is assembled from the extension's own class names so newtab.css
 * styles it exactly as the product does; store.css only rescales it. Favicons
 * are lettered tiles rather than real site icons: the artwork has to render
 * offline and identically every time, and a screenshot that quietly fetches
 * thirty logos from the web is not something to ship in a store listing. */

const S = window.SHOT

const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

const ICONS = {
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  tag: '<path d="M20.6 13.4 12 4.8H4.8V12l8.6 8.6a2 2 0 0 0 2.8 0l4.4-4.4a2 2 0 0 0 0-2.8z"/><circle cx="8.5" cy="8.5" r="1.2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M4 12h2M18 12h2M12 4v2M12 18v2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M5 5l1.4 1.4M17.6 17.6 19 19M3 12h2M19 12h2M5 19l1.4-1.4M17.6 6.4 19 5"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  check: '<path d="m5 13 4 4L19 7"/>',
  folder: '<path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 14 9 5 9-5"/>',
  cloud: '<path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.1 11 3.5 3.5 0 0 0 6.5 19z"/>',
  sort: '<path d="M4 7h13M4 12h9M4 17h5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  note: '<path d="M15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9l7-7V5a2 2 0 0 0-2-2z"/><path d="M14 21v-5a2 2 0 0 1 2-2h5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
}

function svg(name, cls, size = 12) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  n.setAttribute('viewBox', '0 0 24 24')
  // Explicit dimensions: an SVG with no width lays out at its default 300x150,
  // and the icons that sit outside a sized .icon-btn have nothing else to
  // constrain them.
  n.setAttribute('width', String(size))
  n.setAttribute('height', String(size))
  n.setAttribute('fill', 'none')
  n.setAttribute('stroke', 'currentColor')
  n.setAttribute('stroke-width', '1.8')
  n.setAttribute('stroke-linecap', 'round')
  n.setAttribute('stroke-linejoin', 'round')
  n.innerHTML = ICONS[name] ?? ''
  if (cls) n.setAttribute('class', cls)
  return n
}

/** A lettered favicon plate, coloured from the site name so it stays stable. */
function plate(name, small) {
  const hue = [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7)
  const wrap = el('span', `favicon${small ? ' favicon--sm' : ''}`)
  wrap.style.background = `hsl(${hue} 62% 52%)`
  wrap.style.color = '#fff'
  wrap.style.display = 'grid'
  wrap.style.placeItems = 'center'
  wrap.style.fontWeight = '700'
  wrap.style.fontSize = small ? '7px' : '9px'
  wrap.textContent = name[0].toUpperCase()
  return wrap
}

// ------------------------------------------------------------------ board ---

function folderCard(f) {
  const node = el('div', 'folder')
  node.style.setProperty('--folder-color', f.color)

  const head = el('div', 'folder__head')
  const caret = el('button', 'icon-btn icon-btn--sm folder__caret')
  caret.append(svg('chevronDown'))
  const heading = el('div', 'folder__heading')
  heading.append(el('span', 'folder__title', f.title))
  const more = el('button', 'icon-btn icon-btn--sm')
  more.append(svg('more'))
  head.append(caret, heading, el('span', 'folder__count', String(f.items.length)), more)

  const body = el('div', 'folder__body')
  for (const it of f.items) {
    const title = typeof it === 'string' ? it : it.title
    const open = typeof it === 'object' && it.open
    const row = el('a', `item${open ? ' is-open' : ''}`)
    const b = el('div', 'item__body')
    b.append(el('div', 'item__title', title))
    if (typeof it === 'object' && it.tag) {
      const tags = el('div', 'item__tags')
      tags.append(el('span', 'item__tag', it.tag))
      b.append(tags)
    }
    row.append(plate(title, true), b)
    if (open) {
      const x = el('button', 'icon-btn icon-btn--sm item__close')
      x.append(svg('close'))
      row.append(x)
    }
    const dots = el('button', 'icon-btn icon-btn--sm item__action')
    dots.append(svg('more'))
    row.append(dots)
    body.append(row)
  }

  node.append(head, body)
  return node
}

function buildBoard(host) {
  const b = S.board
  const app = el('div', `app${b.sidebar === false ? ' sidebar-collapsed' : ''}`)

  // sidebar
  const side = el('aside', 'sidebar')
  const brand = el('div', 'brand')
  const mark = el('span', 'brand__mark')
  const img = el('img')
  img.src = '../../icons/icon.svg'
  mark.append(img)
  brand.append(mark, el('span', 'brand__name', 'Tabspace'))
  const sect = el('div', 'section-head')
  sect.append(el('span', null, 'Open tabs'), el('span', 'section-head__count', String(b.tabs.length)))
  const tools = el('div', 'sidebar__tools')
  for (const t of ['Stash all', 'Sort', 'Dedupe']) tools.append(el('button', 'btn btn--quiet btn--sm', t))
  const hint = el('div', 'hint', 'Drag a tab onto a folder to save it. Shift-click to grab several at once.')
  const list = el('div', 'tab-list')
  for (const t of b.tabs) {
    const row = el('div', `row${t.saved ? ' is-saved' : ''}`)
    const body = el('div', 'row__body')
    body.append(el('div', 'row__title', t.title), el('div', 'row__sub', t.host))
    row.append(plate(t.title), body)
    if (t.saved) row.append(svg('check', 'icon row__saved', 10))
    list.append(row)
  }
  side.append(brand, sect, tools, hint, list)

  // main
  const main = el('main', 'main')
  const top = el('header', 'topbar')
  const sb = el('button', 'icon-btn'); sb.append(svg('sidebar'))
  const spaces = el('div', 'spaces')
  b.spaces.forEach((name, i) => spaces.append(el('button', `space-tab${i === b.activeSpace ? ' is-active' : ''}`, name)))
  const addSpace = el('button', 'icon-btn'); addSpace.append(svg('plus'))
  spaces.append(addSpace)
  const search = el('div', 'search')
  const field = el('input', 'field'); field.placeholder = 'Search everything'
  search.append(svg('search', 'icon'), field)
  const pill = el('span', 'sync-pill')
  pill.append(el('span', 'sync-dot'), el('span', 'sync-pill__label', 'Saved'))
  const acct = el('button', 'account account--in')
  acct.append(el('span', 'account__avatar', 'V'), el('span', null, 'vitthalpandit500'))
  top.append(sb, el('div', 'topbar__divider'), spaces, search, pill, acct, el('div', 'topbar__divider'))
  for (const n of ['tag', S.theme === 'dark' ? 'moon' : 'sun', 'settings']) {
    const btn = el('button', 'icon-btn'); btn.append(svg(n)); top.append(btn)
  }

  const tagbar = el('div', 'tagbar')
  for (const t of (b.tags ?? [])) {
    const c = el('button', `chip${t.active ? ' is-active' : ''}`)
    c.append(document.createTextNode(t.name), el('span', 'chip__count', String(t.count)))
    tagbar.append(c)
  }

  const scroll = el('div', 'board-scroll')
  const wrap = el('div', 'board-wrap')
  const board = el('div', 'board')

  const cards = b.folders.map(folderCard)
  if (b.addTile !== false) {
    const add = el('button', 'add-folder')
    add.append(svg('plus'), el('span', null, 'New folder'))
    cards.push(add)
  }
  const cols = b.columns ?? 4
  const buckets = Array.from({ length: cols }, () => [])
  const filled = new Array(cols).fill(0)
  cards.forEach((card, i) => {
    let s = 0
    for (let c = 1; c < cols; c += 1) if (filled[c] < filled[s]) s = c
    buckets[s].push(card)
    filled[s] += (b.folders[i]?.items.length ?? 1) * 15 + 26
  })
  for (const bucket of buckets) {
    const col = el('div', 'board__col')
    bucket.forEach((c) => col.append(c))
    board.append(col)
  }

  const canvas = el('div', 'canvas-layer')
  for (const n of (b.notes ?? [])) {
    const s = el('div', 'sticker', n.text)
    s.style.left = `${n.x}px`; s.style.top = `${n.y}px`; s.style.background = n.color
    canvas.append(s)
  }

  wrap.append(board, canvas)
  scroll.append(wrap)

  const status = el('footer', 'statusbar')
  status.append(el('button', 'btn btn--quiet btn--sm', 'New folder'),
                el('button', 'btn btn--quiet btn--sm', 'New note'))

  main.append(top, tagbar, scroll, status)
  app.append(side, main)
  host.append(app)
}

// -------------------------------------------------------------------- page ---

document.body.className = `shot shot--${S.theme}`
document.documentElement.dataset.theme = S.theme

const deco = el('div', 'deco')
for (const d of (S.deco ?? [])) {
  const n = el('div', d.dots ? 'deco__dots' : 'deco__blob')
  Object.assign(n.style, d.style)
  deco.append(n)
}
document.body.append(deco)

const copy = el('div', 'copy')
const lock = el('div', 'lockup')
const lockImg = el('img'); lockImg.src = '../../icons/icon.svg'
lock.append(lockImg, el('span', null, 'Tabspace'))
const h = el('h1', 'headline')
if (S.headlineSize) h.style.fontSize = S.headlineSize
h.innerHTML = S.headline
const sub = el('p', 'sub')
sub.innerHTML = S.sub
copy.append(lock, h, sub)

if (S.feats) {
  const feats = el('div', 'feats')
  for (const f of S.feats) {
    const row = el('div', 'feat')
    const ico = el('div', 'feat__icon')
    ico.style.background = f.bg
    ico.style.color = f.fg
    ico.append(svg(f.icon))
    const body = el('div')
    const t = el('div', 'feat__title', f.title)
    t.style.color = f.fg
    body.append(t, el('div', 'feat__desc', f.desc))
    row.append(ico, body)
    feats.append(row)
  }
  copy.append(feats)
}
document.body.append(copy)

const frame = el('div', 'frame')
Object.assign(frame.style, S.frame)
if (S.macBar) {
  const bar = el('div', 'frame__bar')
  for (const c of ['#ff5f57', '#febc2e', '#28c840']) {
    const dot = el('span', 'frame__dot'); dot.style.background = c; bar.append(dot)
  }
  frame.append(bar)
}
const inner = el('div', 'frame__body')
buildBoard(inner)
frame.append(inner)
document.body.append(frame)

if (S.chips) {
  const chips = el('div', 'chips')
  for (const c of S.chips) {
    const card = el('div', 'chip-card')
    card.style.background = c.bg
    const ico = el('div', 'chip-card__icon')
    ico.style.background = c.iconBg
    ico.style.color = c.fg
    ico.append(svg(c.icon))
    const body = el('div')
    body.append(el('div', 'chip-card__title', c.title), el('div', 'chip-card__desc', c.desc))
    card.append(ico, body)
    chips.append(card)
  }
  document.body.append(chips)
}

if (S.callout) {
  const c = el('div', 'callout')
  Object.assign(c.style, S.callout.style)
  const head = el('div', 'callout__head')
  head.append(el('span', 'callout__title', S.callout.title))
  const plus = el('span'); plus.style.color = '#7e8794'; plus.append(svg('plus'))
  plus.style.width = '16px'; plus.style.height = '16px'; plus.style.display = 'block'
  head.append(plus)
  c.append(head)
  for (const r of S.callout.rows) {
    const row = el('div', 'callout__row')
    const dot = el('span', 'callout__dot'); dot.style.background = r.color
    row.append(dot, el('span', 'callout__name', r.name), el('span', 'callout__count', String(r.count)))
    c.append(row)
  }
  if (S.callout.note) {
    const note = el('div', 'callout__note')
    note.append(el('b', null, S.callout.note.title), el('span', null, S.callout.note.desc))
    c.append(note)
  }
  document.body.append(c)
}

document.body.dataset.ready = '1'
