/** A group of domains whose cookies / localStorage are all kept aligned with each other. */
export interface Group {
  id: string
  name: string
  enabled: boolean
  domains: string[]
  /** When set, this domain is the source of truth: it mirrors to the others and they never write back. */
  primary: string | null
  syncCookies: boolean
  syncLocalStorage: boolean
  /** Comma separated wildcard patterns (e.g. "session*, token"). Empty = everything. */
  cookieFilter: string
  storageFilter: string
}

export interface SyncConfig {
  groups: Group[]
}

export const DEFAULT_CONFIG: SyncConfig = { groups: [] }

/**
 * Random id. Not crypto.randomUUID(): it only exists in secure contexts, and Firefox treats the menu
 * iframe as insecure when it floats over an http:// page.
 */
export function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function newGroup(name: string): Group {
  return {
    id: randomId(),
    name,
    enabled: true,
    domains: [],
    primary: null,
    syncCookies: true,
    syncLocalStorage: true,
    cookieFilter: '',
    storageFilter: '',
  }
}

export interface LsChange {
  key: string
  /** null = key removed */
  value: string | null
}

export type ContentToBg =
  | { type: 'ls-hello'; snapshot: Record<string, string> }
  | { type: 'ls-changes'; changes: LsChange[] }

export type BgToContent = { type: 'ls-apply'; changes: LsChange[] } | { type: 'ls-snapshot' }

/** Copy everything from `from` (a domain of the group) to all the other domains of the group. */
export type UiToBg = { type: 'copy'; groupId: string; from: string }

export interface LogEntry {
  t: number
  level: 'info' | 'error'
  msg: string
}
