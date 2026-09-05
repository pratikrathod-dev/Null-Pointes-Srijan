# Tabspace

**Tab hoarder? Same.** This is a board for them.

Spaces hold folders, folders hold bookmarks, and you save a tab by dragging it
out of the sidebar. Tag anything, collapse anything, stick a note anywhere on
the board, and sign in once so the whole thing follows you to your other laptop.

No limits on any of it — spaces, folders, bookmarks, tags, notes. The honest way
to implement "unlimited" is to not write the limit, so there isn't one.

**There is no build step.** Plain ES modules: edit a file, hit refresh, see the
change.

---

## Load it in developer mode

1. Open `chrome://extensions`
2. Turn on **Developer mode** (toggle, top-right)
3. Click **Load unpacked**
4. Choose this folder — the one containing `manifest.json`
5. Open a new tab

### After you edit something

| What you changed | What to do |
|---|---|
| `src/newtab/*`, `src/popup/*`, `src/lib/*` | Just reload the page (`F5`) |
| `manifest.json`, `src/background.js` | Click ↻ on the card at `chrome://extensions`, then reload the page |

If a change seems not to apply, hard-reload with `Ctrl+Shift+R` — Chrome caches
extension pages fairly aggressively.

### Debugging

- **Board / popup** — right-click → Inspect, as with any page.
- **Service worker** — on `chrome://extensions`, click the "service worker" link
  on the Tabspace card. It sleeps after ~30s of inactivity; that is normal, and
  clicking the link wakes it.
- **Stored data** — DevTools → Application → Storage → Extension storage, or run
  `chrome.storage.local.get(console.log)` in the board's console.

> One extension ID can only be loaded once. If you also have a store-installed
> tab manager enabled and it overrides the new tab page, Chrome will ask which
> one wins — disable the other to get Tabspace's board.

---

## AI news (MiMo)

The sidebar has a second view, **AI news**: the ten hottest stories in AI and
tech for today or this week, ranked by Xiaomi's `mimo-v2.5-pro`. Switch with the
pills under the logo, or the newspaper button in the top bar.

How it works, and why every story can be trusted:

1. The extension fetches fourteen real feeds itself — OpenAI, Google AI, Google
   DeepMind, Hugging Face, TechCrunch, The Verge, Ars Technica, Hacker News,
   Simon Willison, The Hacker News, MIT Technology Review, MarkTechPost, The
   Decoder and MIT News.
2. MiMo picks the ten that matter most, merges duplicates, writes a one-line
   summary, tags a category (release, free, open source, product, research,
   funding, security, policy) and gives each a heat score.
3. Anything MiMo returns that cannot be traced back to a fetched story is
   dropped. The link on every card is the publisher's own page.

Set it up in **Settings → MiMo API key** (`sk-…` from platform.xiaomimimo.com,
or a `tp-…` Token Plan key), then **Save & test**. The key is stored only in
this browser's local extension storage — never synced, never exported. Results
are cached for four hours (today) or a day (this week); the refresh button
forces a new run. Without a key, "Show newest without AI" lists the feeds'
newest stories unranked.

**MiMo web search** (Settings) lets the model add a story the feeds missed;
only links the API actually cited are kept. Direct `sk-` keys only, with the
Web Search plugin enabled in the MiMo console.

---

## Keyboard

| Key | Does |
|---|---|
| `Alt+S` | Save the current tab (opens the popup) |
| `Alt+B` | Jump to the board |
| `Alt+E` | Open the side panel |
| `/` | Focus the search box |
| `Ctrl/Cmd + Z` | Undo · `Shift` to redo |
| `Shift`-click a tab | Extend the selection, then drag them all at once |
| `Shift`-click a bookmark | Select it, then right-click to group the selection |
| `Ctrl/Cmd`-click a bookmark | Open opposite to your "open in new tab" setting |
| Double-click empty board | Drop a sticky note there |

Rename a folder or group by double-clicking its title. Right-click anything for
its menu.

---

## Layout

```
manifest.json          MV3 manifest
src/
  background.js        service worker — commands and first run only, owns no state
  lib/
    util.js            ids, ordering, favicons, a tiny DOM builder
    model.js           the data shape and every mutation; also import/export
    store.js           local persistence, undo/redo, cross-tab updates
    sync.js            chunked chrome.storage.sync engine
    supabase-sync.js   email + code sign-in, the recommended backend
    mimo.js            Xiaomi MiMo client; the key lives in local storage only
    news.js            feed fetching, MiMo ranking, and the news cache
    supabase-config.js the two values you paste in
  newtab/              the board (newtab override)
  sidepanel/           vertical tab strip + saved folders, in Chrome's side panel
  popup/               toolbar popup — save the current tab to a folder
tools/
  gen-icons.mjs        regenerates icons/*.png (npm run icons)
  model.test.mjs       logic tests (npm test) — no browser needed
  groups.test.mjs      groups, stickers and the v2 import path
```

### How state flows

```
        dispatch(name, payload)
                 │
      ┌──────────▼──────────┐
      │  Store              │  clone → mutate → keep snapshot for undo
      │  state (in memory)  │
      └──┬───────────────┬──┘
         │               │
   chrome.storage    SyncEngine ──► chrome.storage.sync (chunked, debounced 4s)
      .local                              │
   (authoritative,                        ▼
    complete)                    other signed-in devices
```

`chrome.storage.local` is always the complete, authoritative copy. Sync is a
mirror layered on top — never a gate in front. If sync is off, failing, or out of
room, every edit still works; only the status pill changes.

### Features and where they live

| Feature | Where it lives |
|---|---|
| Unlimited bookmarks | `model.js` — `addItem` has no count check |
| Unlimited spaces | `model.js` — `addSpace` has no count check |
| Unlimited tags | `model.js` — `addTag` de-duplicates but never caps |
| Unlimited sticky notes | `model.js` — `addSticker` has no count check |
| Collapsable folders | `folder.collapsed`, `toggleFolderCollapsed`, `setAllFoldersCollapsed` |
| Groups inside folders | `type: 'group'` items with `groupItems`, one level deep |
| Sticky notes on a canvas | `space.widgets[]` with x/y; canvas layer in `newtab.js` |
| Side panel | `src/sidepanel/` |
| Sort tabs / close duplicates | `sortTabs`, `closeDuplicateTabs` in `newtab.js` |
| Repair broken favicons | `mutations.repairFavicons` |
| Cross-device sync | `sync.js` |

The unlimited ones are unlimited because nothing counts them — the honest way to
implement "unlimited" is to not write the limit.

### Groups and stickers

A **group** is an item inside a folder that holds bookmarks of its own. It
collapses independently of its folder and nests exactly one level — a group
never contains another group, which `moveItem` enforces. Shift-click a few
bookmarks and right-click to make one.

A **sticker** belongs to the space rather than to any folder, and carries its own
x/y, so it floats anywhere on the board background. Double-click empty space to
drop one. They render on a layer above the folder grid that ignores pointer
events except on a sticker itself, so the board underneath stays clickable. The
layer sits inside a `position: relative` wrapper sized by the grid, which is what
lets a sticker below the fold stay where it was put.



---

## Sync

Two backends run side by side; neither replaces the other. The local
copy in `chrome.storage.local` is always complete and authoritative — sync is a
mirror on top, never a gate in front.

| | Setup by you | What a user does | Private | Cross-browser |
|---|---|---|---|---|
| **Supabase** | already set up | Type an email and a password | Yes | Yes |
| Chrome profile sync | none | nothing | Yes | Chrome only |

### Supabase — the recommended route

Users type an email address and a password. That is the whole experience: no
token to generate, no developer console, no Google account, and it works in
Chrome, Edge and Firefox alike.

A password rather than a magic link because a confirmation link cannot redirect
back into an extension -- the link opens an ordinary web page and strands you
there. Addresses used before are remembered and offered back, ranked by how
often each account is actually used, so a returning user picks instead of
typing.

You do this once:

1. **Create a project.** supabase.com -> New project. Free plan, no card.

2. **Create the table.** SQL Editor -> paste this -> Run:

   ```sql
   create table public.boards (
     user_id    uuid primary key references auth.users on delete cascade default auth.uid(),
     rev        bigint      not null default 0,
     device     text,
     state      jsonb       not null,
     updated_at timestamptz not null default now()
   );

   alter table public.boards enable row level security;

   create policy "own board only"
     on public.boards for all
     using (auth.uid() = user_id)
     with check (auth.uid() = user_id);
   ```

   That policy is the important line: the database itself refuses to let one
   account read or write another's row. It is not enforced by the extension, so
   a bug here cannot leak one user's board to another.

3. **Turn off email confirmation.** Authentication -> Sign In / Providers ->
   Email -> uncheck **Confirm email**. Otherwise Supabase sends a confirmation
   link on sign-up, and a link cannot return to an extension, so the new account
   is created but never activated.

4. **Copy two values.** Settings -> API -> Project URL and the anon/public key.

5. **Paste them** into `src/lib/supabase-config.js` and reload the extension.

The anon key belongs in the client — it is designed to be public. Row-level
security is what actually separates accounts.

**Does this get cluttered with many users?** No. Every account gets exactly one
row, keyed to its own user id, and can only ever see that row. Ten users mean
ten isolated rows. The free tier covers 50,000 monthly active users and 500 MB,
which a personal board will never approach.

> Free Supabase projects pause after about a week with no traffic. They resume
> from the dashboard; a board in daily use never idles that long.

---

## The other three backends

### Chrome profile sync (on by default, nothing to set up)

Rides Chrome Sync, using whatever Google account this browser is already signed
into. That is why it never asks you to log in — and why it does nothing at all
if Chrome itself is signed out. Limited to ~100 KB (roughly 900 bookmarks), and
Chrome-only.


---

## About the Chrome-profile backend

`chrome.storage.sync` rides on the Chrome profile you are already signed in to.
No account, no server, no cost. It is small, though:

| Limit | Value |
|---|---|
| Total | 102,400 bytes |
| Per key | 8,192 bytes |
| Keys | 512 |
| Writes | 1,800/hour, 120/minute |

`sync.js` works within that:

- **Compact encoding** — short keys, and favicons are dropped entirely because
  Chrome regenerates them locally. In practice ~110 bytes per bookmark, so the
  quota holds roughly **900 bookmarks**. The status bar shows exactly where you
  are.
- **Chunking** — the payload is split across `c0`, `c1`, … under the per-key
  ceiling, with a small `m` meta record holding the revision, device and count.
  Stale chunks are removed when the state shrinks.
- **Debounced writes** — 4 seconds, which keeps a busy session far under the
  write quota.
- **Conflicts** — last-write-wins on a revision counter. Each write stamps the
  device that made it, so a device ignores the echo of its own push.
- **Over quota** — sync pauses and says so. Local editing is never blocked.

If you outgrow it, `sync.js` is the only file that needs to change: swap the
chunked-storage calls for a real backend and everything above it stays as it is.

---

## Importing

Settings → Import handles:

- **Another manager's JSON export** — spaces, folders, colours, collapsed state, tags,
  bookmarks, groups (kept as groups, not flattened) and sticker widgets with
  their positions. Fractional-index ordering is read and preserved
  before being renumbered onto our own scheme.
- **Tabspace backup** — the same reader handles our own export.
- **HTML bookmarks** — the Netscape format every browser and most tab managers
  export.
- **Chrome bookmarks** — read straight from the browser, one folder per tree
  folder.

Imports always *add* — nothing you already have is overwritten, and there is a
preview with counts before anything is written.

---

## Tests

```
npm run check    # every import in every source file resolves to a real export
npm test         # 113 logic tests, no browser required
npm run test:ui  # 72 checks driving the real board in jsdom
npm run test:all # all three, in order
npm run icons    # regenerate icons/*.png
```

`npm test` covers the mutations, the sync encode/decode round trip, the
importers, export escaping, URL and colour sanitising, and the ranked account
history. If a board export sits next to this folder it is used as a real
fixture; otherwise that one test skips.

`npm run test:ui` loads `newtab.html` into jsdom and drives it the way a person
would -- opening menus, tagging, filtering, signing in -- so a runtime error
surfaces here instead of only in the browser. It needs jsdom once:

```
npm install --no-save jsdom
```

## Packaging for the Chrome Web Store

```
npm run package
```

This writes `dist/tabspace-<version>.zip`, containing only what the extension
actually loads. It deliberately does not zip the folder wholesale: `assets/`,
`tools/`, the README and `package.json` are development scaffolding, and
`assets/` alone is several megabytes.

**Upload `dist/tabspace-<version>.zip` itself. Do not zip the project folder.**
The store refuses a package containing more than one manifest:

```
More than one manifest found in package:
  tabspace/dist/tabspace/manifest.json, tabspace/manifest.json
```

A hand-made zip of the whole folder sweeps up anything sitting in it. `dist/`
therefore holds the .zip and nothing else -- staging happens in a temp directory
-- and the packager refuses to write a package unless there is exactly one
manifest, at the top level.

Before writing anything it also checks the rest of what the store rejects
uploads for: invalid JSON, a name or description over the length limit, a
malformed version, a manifest pointing at a file that is not there, and
mojibake. That last one is not hypothetical: this extension once shipped a
manifest whose name read `Tabspace â€” tabs, finally sorted`, because the em
dash in the tagline was written as UTF-8 and read back as single-byte text. The
name is now plain `Tabspace`, and the tagline lives in the description.

Upload at
[chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole).

**One thing to know before you submit.** Chrome removed `--load-extension` from
branded stable builds, so the packaged zip cannot be smoke-tested from a script
any more. Load the **project folder** (the one containing `manifest.json`)
through **Load unpacked** once and click through the board, the popup and the
side panel before uploading.

**Permissions, if the reviewer asks.** `tabs` reads the open tab list the
sidebar shows; `bookmarks` is read-only and used solely by the one-off importer;
`favicon` serves icons from Chrome's own cache; `storage` and `unlimitedStorage`
hold the board, which has no size limit by design; `sidePanel` opens the panel.
The Supabase host permissions are the sync backend. The two public favicon
services are the only requests that leave the machine, and Settings can turn
them off.
