// MV3 service worker. Deliberately thin: it owns no board state.
//
// Service workers have no localStorage and are killed aggressively, so the sync
// engine lives in the pages instead. This worker only handles the things that
// must exist outside a page: keyboard commands, first-run, answering a couple
// of queries from the popup -- and, since 1.9, noting when tabs open and close
// so learned routines can be spotted even when no board tab is open. That
// record is device-local (see lib/routines.js) and never touches the board.
//
// Also hosts the lightweight tab observer for the memory system.

import { recordTabLoaded, recordTabClosed } from './lib/routines.js'
import { createTabObserver } from './lib/memory/tab-observer.js'
import { TemporaryMemory } from './lib/memory/temporary-memory.js'

const BOARD_URL = chrome.runtime.getURL('src/newtab/newtab.html')

// --- Memory: tab observation + temporary browsing context -------------------

const tempMemory = new TemporaryMemory()

const tabObserver = createTabObserver((event, meta) => {
  tempMemory.record(event, meta)
})

// Rehydrate from storage each time the service worker boots (it may restart).
tempMemory.init().then(() => {
  tabObserver.attach()
}).catch(() => {
  // If init fails (storage error), still attach — entries start empty.
  tabObserver.attach()
})

// A tab counts once it has finished loading a real page; routines.js filters
// out extension pages and chrome:// itself. Failures are swallowed on purpose:
// a hiccup here must never surface as anything the person can see.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return
  recordTabLoaded(tabId, tab).catch(() => {})
})
chrome.tabs.onRemoved.addListener((tabId) => {
  recordTabClosed(tabId).catch(() => {})
})

// --- Core service worker logic ----------------------------------------------
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.tabs.create({ url: BOARD_URL })
})

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'open_board') openBoard()
  if (command === 'toggle_sidepanel') {
    // sidePanel.open() only counts as user-gesture-driven while the command
    // handler is still on the stack, so there must be no `await` before it.
    // The command event hands us the active tab, which already carries the
    // window id -- awaiting chrome.windows.getCurrent() to find it was what
    // made this throw "user gesture required" every time.
    const windowId = tab?.windowId
    const opening = windowId != null
      ? chrome.sidePanel.open({ windowId })
      : chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT })
    Promise.resolve(opening).catch(() => { /* panel already open, or no window */ })
  }
})

/** Focus an existing board tab if there is one, otherwise open a new one. */
async function openBoard() {
  const tabs = await chrome.tabs.query({ url: `${BOARD_URL}*` })
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true })
    await chrome.windows.update(tabs[0].windowId, { focused: true })
  } else {
    await chrome.tabs.create({ url: BOARD_URL })
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Memory queries from board / side panel pages
  if (message?.type === 'memory:get') {
    sendResponse(tempMemory.get(message.url))
    return false
  }
  if (message?.type === 'memory:all') {
    sendResponse(tempMemory.all())
    return false
  }
  if (message?.type === 'memory:markSaved') {
    tempMemory.markSaved(message.url)
    sendResponse({ ok: true })
    return false
  }
  // Board open
  if (message?.type === 'open-board') {
    openBoard().then(() => sendResponse({ ok: true }))
    return true
  }
  return false
})
