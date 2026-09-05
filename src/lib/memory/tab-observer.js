// Tab Observer: lightweight tracking of browsing activity.
//
// Listens to chrome.tabs events and records metadata for every tab that opens.
// This is a passive observer — it never modifies tab behaviour or the board
// state. Data feeds into TemporaryMemory for importance scoring.

import { domainOf } from './types.js'

/**
 * Observe tab lifecycle events and feed metadata into a callback.
 *
 * Call `attach()` once from the background service worker. The callback
 * receives `(eventType, meta)` where meta is a plain object with tab info.
 *
 * @param {(event: string, meta: object) => void} onEvent
 * @returns {{ attach: () => void, detach: () => void }}
 */
export function createTabObserver(onEvent) {
  const listeners = []

  function listen(target, event, fn) {
    target?.addListener(fn)
    listeners.push({ target, fn })
  }

  function tabMeta(tab) {
    return {
      tabId: tab.id,
      title: tab.title || '',
      url: tab.url || '',
      domain: domainOf(tab.url || ''),
      favIconUrl: tab.favIconUrl || '',
      windowId: tab.windowId,
      pinned: Boolean(tab.pinned),
    }
  }

  function attach() {
    // Tab created
    listen(chrome.tabs.onCreated, 'created', (tab) => {
      onEvent('created', tabMeta(tab))
    })

    // Tab updated (url change, title change, load complete)
    listen(chrome.tabs.onUpdated, 'updated', (tabId, changeInfo, tab) => {
      if (changeInfo.status === 'complete' || changeInfo.url || changeInfo.title) {
        onEvent('updated', {
          ...tabMeta(tab),
          changeInfo: {
            url: changeInfo.url || null,
            title: changeInfo.title || null,
            status: changeInfo.status || null,
          },
        })
      }
    })

    // Tab activated (user switched to it)
    listen(chrome.tabs.onActivated, 'activated', async (info) => {
      try {
        const tab = await chrome.tabs.get(info.tabId)
        onEvent('activated', tabMeta(tab))
      } catch { /* tab may have closed */ }
    })

    // Tab removed
    listen(chrome.tabs.onRemoved, 'removed', (tabId, removeInfo) => {
      onEvent('removed', { tabId, windowId: removeInfo.windowId })
    })

    // Tab replaced (e.g. prerender swap)
    listen(chrome.tabs.onReplaced, 'replaced', (addedTabId, removedTabId) => {
      onEvent('replaced', { tabId: addedTabId, oldTabId: removedTabId })
    })
  }

  function detach() {
    for (const { target, fn } of listeners) {
      try { target?.removeListener(fn) } catch { /* ok */ }
    }
    listeners.length = 0
  }

  return { attach, detach }
}
