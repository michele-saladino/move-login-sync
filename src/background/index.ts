import { getConfig, log } from '../core/config'
import { copyAllCookies, setupCookieSync } from '../core/cookies'
import { findGroup, isGroupActive, originPattern } from '../core/match'
import { applyChanges, copyAllStorage, handleHello, pruneShared } from '../core/storageSync'
import type { ContentToBg, UiToBg } from '../core/types'

const CONTENT_SCRIPT_ID = 'move-login-sync-content'

// Listeners must be registered synchronously at top level so the service worker wakes for them.
setupCookieSync()

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.config) void applyConfig()
})
// The popup may close while Chrome shows the permission prompt; pick the grant up here.
chrome.permissions.onAdded.addListener(() => void applyConfig())
chrome.permissions.onRemoved.addListener(() => void applyConfig())
chrome.runtime.onInstalled.addListener(() => void applyConfig())
chrome.runtime.onStartup.addListener(() => void applyConfig())

chrome.runtime.onMessage.addListener((msg: ContentToBg | UiToBg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then(sendResponse)
    .catch((e) => sendResponse({ error: e instanceof Error ? e.message : String(e) }))
  return true // async response
})

async function handleMessage(msg: ContentToBg | UiToBg, sender: chrome.runtime.MessageSender) {
  const { groups } = await getConfig()

  if (msg.type === 'copy') {
    const group = groups.find((g) => g.id === msg.groupId)
    if (!group || !isGroupActive(group)) throw new Error('Group is disabled or has fewer than 2 domains')
    const result: { cookies?: number; storage?: number; storageError?: string } = {}
    if (group.syncCookies) result.cookies = await copyAllCookies(group, msg.from)
    if (group.syncLocalStorage) {
      try {
        result.storage = await copyAllStorage(group, msg.from)
      } catch (e) {
        result.storageError = e instanceof Error ? e.message : String(e)
      }
    }
    log('info', `manual copy from ${msg.from} in "${group.name}": ${JSON.stringify(result)}`)
    return result
  }

  // Messages below come from content scripts.
  if (!sender.url) return { changes: [] }
  const hit = findGroup(groups, new URL(sender.url).hostname)
  if (!hit || !hit.group.syncLocalStorage) return { changes: [] }

  if (msg.type === 'ls-hello') return { changes: await handleHello(hit.group, hit.base, msg.snapshot) }
  if (msg.type === 'ls-changes') {
    await applyChanges(hit.group, hit.base, msg.changes)
    return {}
  }
}

async function applyConfig(): Promise<void> {
  const { groups } = await getConfig()
  await pruneShared(groups.map((g) => g.id))
  await registerContentScript(groups.filter((g) => isGroupActive(g) && g.syncLocalStorage).flatMap((g) => g.domains))
}

async function registerContentScript(domains: string[]): Promise<void> {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] })
  } catch {
    /* not registered */
  }
  // Only register for origins the user actually granted access to.
  const matches: string[] = []
  for (const d of new Set(domains)) {
    const p = originPattern(d)
    if (await chrome.permissions.contains({ origins: [p] })) matches.push(p)
  }
  if (!matches.length) return

  await chrome.scripting.registerContentScripts([
    { id: CONTENT_SCRIPT_ID, js: ['content.js'], matches, runAt: 'document_idle', persistAcrossSessions: true },
  ])
  // Tabs that were already open do not get registered scripts until reload, so inject right away.
  const tabs = await chrome.tabs.query({ url: matches })
  for (const t of tabs) {
    if (t.id != null)
      chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] }).catch(() => undefined)
  }
}
