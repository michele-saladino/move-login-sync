import type { BgToContent, ContentToBg, LsChange } from '../core/types'

// Runs in every tab of the two configured domains and mirrors localStorage via the background worker.
const w = window as unknown as { __moveLoginSync?: boolean }

if (!w.__moveLoginSync) {
  w.__moveLoginSync = true
  main()
}

function main() {
  const POLL_MS = 1000
  let last = snapshot()
  let timer: number | undefined

  function snapshot(): Record<string, string> {
    const out: Record<string, string> = {}
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)!
        out[k] = localStorage.getItem(k) ?? ''
      }
    } catch {
      /* storage blocked */
    }
    return out
  }

  function diff(prev: Record<string, string>, next: Record<string, string>): LsChange[] {
    const changes: LsChange[] = []
    for (const [key, value] of Object.entries(next)) if (prev[key] !== value) changes.push({ key, value })
    for (const key of Object.keys(prev)) if (!(key in next)) changes.push({ key, value: null })
    return changes
  }

  async function send<T = { changes?: LsChange[] }>(msg: ContentToBg): Promise<T | undefined> {
    try {
      return (await chrome.runtime.sendMessage(msg)) as T
    } catch {
      // Extension was reloaded/updated: this orphaned script must stop.
      window.clearInterval(timer)
      return undefined
    }
  }

  // Same-tab writes do not raise `storage` events, and a content script cannot hook the page's
  // setItem (isolated world), so we diff on a short interval and also on the cross-tab event.
  async function check() {
    const next = snapshot()
    const changes = diff(last, next)
    last = next
    if (changes.length) await send({ type: 'ls-changes', changes })
  }

  function apply(changes: LsChange[]) {
    for (const { key, value } of changes) {
      try {
        if (value === null) localStorage.removeItem(key)
        else if (localStorage.getItem(key) !== value) localStorage.setItem(key, value)
      } catch {
        /* quota / blocked */
      }
    }
    last = snapshot() // our own writes must not be reported back
  }

  chrome.runtime.onMessage.addListener((msg: BgToContent, _sender, respond) => {
    if (msg.type === 'ls-apply') {
      void check().then(() => apply(msg.changes))
    } else if (msg.type === 'ls-snapshot') {
      respond({ snapshot: snapshot() })
    }
  })

  window.addEventListener('storage', () => void check())
  document.addEventListener('visibilitychange', () => void check())
  timer = window.setInterval(() => void check(), POLL_MS)

  void send({ type: 'ls-hello', snapshot: last }).then((res) => {
    if (res?.changes?.length) apply(res.changes)
  })
}
