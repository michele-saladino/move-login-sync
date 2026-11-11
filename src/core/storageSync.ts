import { log } from './config'
import { matchesFilter, originPattern } from './match'
import type { BgToContent, Group, LsChange } from './types'

/**
 * localStorage is per-origin and only reachable from a page, so a content script in every tab of
 * the group's domains reports diffs to the background. The background keeps the last known value
 * of every key (per group) in chrome.storage.local — this lets a tab that opens later catch up
 * even when no other tab of the group is open any more.
 */
interface Entry {
  v: string | null // null = tombstone
  t: number
}
type Shared = Record<string, Entry>

const PREFIX = 'shared_ls:'
const sharedKey = (groupId: string) => PREFIX + groupId

// The service worker handles messages concurrently; serialise read-modify-write on shared state.
let chain: Promise<unknown> = Promise.resolve()
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.catch(() => undefined)
  return run
}

async function readShared(groupId: string): Promise<Shared> {
  const k = sharedKey(groupId)
  return ((await chrome.storage.local.get(k))[k] as Shared | undefined) ?? {}
}
const writeShared = (groupId: string, s: Shared) => chrome.storage.local.set({ [sharedKey(groupId)]: s })

/** Drops remembered state of groups that no longer exist. */
export async function pruneShared(existingIds: string[]): Promise<void> {
  const all = await chrome.storage.local.get(null)
  const stale = Object.keys(all).filter((k) => k.startsWith(PREFIX) && !existingIds.includes(k.slice(PREFIX.length)))
  if (stale.length) await chrome.storage.local.remove(stale)
}

async function broadcast(group: Group, exceptBase: string, changes: LsChange[]): Promise<void> {
  if (!changes.length) return
  const urls = group.domains.filter((d) => d !== exceptBase).map(originPattern)
  const tabs = await chrome.tabs.query({ url: urls })
  const msg: BgToContent = { type: 'ls-apply', changes }
  await Promise.all(
    tabs.filter((t) => t.id != null).map((t) => chrome.tabs.sendMessage(t.id!, msg).catch(() => undefined)),
  )
}

/** Changes reported by a tab on `base`: remember them and forward them to the group's other domains. */
export function applyChanges(
  group: Group,
  base: string,
  changes: LsChange[],
  opts: { force?: boolean } = {},
): Promise<number> {
  return exclusive(async () => {
    const shared = await readShared(group.id)
    const relevant = changes.filter((c) => matchesFilter(group.storageFilter, c.key))
    const applied: LsChange[] = []
    for (const ch of relevant) {
      const cur = shared[ch.key]?.v
      if (!opts.force && (cur === ch.value || (cur === undefined && ch.value === null))) continue
      shared[ch.key] = { v: ch.value, t: Date.now() }
      applied.push(ch)
    }
    if (applied.length) {
      await writeShared(group.id, shared)
      log('info', `localStorage: ${applied.length} change(s) from ${base}`)
    }
    await broadcast(group, base, opts.force ? relevant : applied)
    return applied.length
  })
}

/** A freshly loaded page reports its full state and gets back whatever it is missing. */
export function handleHello(group: Group, base: string, snapshot: Record<string, string>): Promise<LsChange[]> {
  return exclusive(async () => {
    const shared = await readShared(group.id)
    const out: LsChange[] = []
    const pushed: LsChange[] = []

    for (const [key, value] of Object.entries(snapshot)) {
      if (!matchesFilter(group.storageFilter, key)) continue
      const e = shared[key]
      if (e && e.v === value) continue
      if (e) out.push({ key, value: e.v }) // remembered state wins
      else {
        shared[key] = { v: value, t: Date.now() }
        pushed.push({ key, value })
      }
    }
    for (const [key, e] of Object.entries(shared)) {
      if (e.v !== null && !(key in snapshot) && matchesFilter(group.storageFilter, key)) out.push({ key, value: e.v })
    }
    if (pushed.length) {
      await writeShared(group.id, shared)
      await broadcast(group, base, pushed) // keys this tab introduced must reach the already open tabs
    }
    return out
  })
}

/** One-shot copy: read the localStorage of an open tab on `from` and push it to the other domains. */
export async function copyAllStorage(group: Group, from: string): Promise<number> {
  const tabs = await chrome.tabs.query({ url: originPattern(from) })
  for (const tab of tabs) {
    if (tab.id == null) continue
    try {
      const res = (await chrome.tabs.sendMessage(tab.id, { type: 'ls-snapshot' } satisfies BgToContent)) as {
        snapshot: Record<string, string>
      }
      const changes = Object.entries(res.snapshot).map(([key, value]) => ({ key, value }))
      await applyChanges(group, from, changes, { force: true })
      return changes.filter((c) => matchesFilter(group.storageFilter, c.key)).length
    } catch {
      /* tab has no content script yet, try the next one */
    }
  }
  throw new Error(`No open tab on ${from} — open it (and reload) first`)
}
