import type { Group } from './types'

/** "https://www.Example.com:8080/path" -> "www.example.com" */
export function normalizeHost(input: string): string {
  let s = input.trim().toLowerCase()
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  s = s.replace(/^\*?\./, '')
  s = s.split(/[/?#]/)[0].replace(/:\d+$/, '')
  return s
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
export const isValidHost = (h: string) => HOST_RE.test(h)

/** True when `host` is `base` or one of its subdomains. Leading dots (cookie domains) are ignored. */
export function hostMatches(host: string, base: string): boolean {
  const h = host.replace(/^\./, '').toLowerCase()
  return !!base && (h === base || h.endsWith('.' + base))
}

/** Replace the `from` suffix of a domain with `to` (keeps a leading dot and any subdomain prefix). */
export function mapDomain(domain: string, from: string, to: string): string {
  const dot = domain.startsWith('.') ? '.' : ''
  const bare = domain.replace(/^\./, '')
  return dot + bare.slice(0, bare.length - from.length) + to
}

/** Comma separated wildcard list. Empty list matches everything. */
export function matchesFilter(filter: string, name: string): boolean {
  const patterns = filter
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  if (!patterns.length) return true
  return patterns.some((p) => {
    const re = new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
    return re.test(name)
  })
}

export const originPattern = (host: string) => `*://*.${host}/*`

/** The starred domain of the group, if it is still a member. */
export const primaryOf = (g: Group) => (g.primary && g.domains.includes(g.primary) ? g.primary : null)

/** With a starred domain only that one is a source; without one every domain is. */
export const canPropagateFrom = (g: Group, base: string) => {
  const p = primaryOf(g)
  return !p || p === base
}

export const isGroupActive = (g: Group) => g.enabled && g.domains.length >= 2

/** The active group that owns `host` (a page host or a cookie domain) and which of its domains matched. */
export function findGroup(groups: Group[], host: string): { group: Group; base: string } | null {
  for (const group of groups) {
    if (!isGroupActive(group)) continue
    const base = group.domains.find((d) => hostMatches(host, d))
    if (base) return { group, base }
  }
  return null
}

/**
 * A domain may live in one group only, and domains must not be nested (a.com + app.a.com),
 * otherwise it is ambiguous which one a cookie or page belongs to. Returns a message or null.
 */
export function findConflict(groups: Group[], host: string): string | null {
  if (!isValidHost(host)) return `"${host}" is not a valid domain.`
  for (const g of groups) {
    for (const d of g.domains) {
      if (d === host) return `${host} is already in "${g.name}".`
      if (hostMatches(d, host) || hostMatches(host, d))
        return `${host} overlaps with ${d} (in "${g.name}"). Subdomains are already included.`
    }
  }
  return null
}
