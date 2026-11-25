import { getConfig, log } from './config'
import { canPropagateFrom, findGroup, hostMatches, mapDomain, matchesFilter } from './match'
import type { Group } from './types'

type Cookie = chrome.cookies.Cookie

function cookieUrl(c: { domain: string; path: string; secure: boolean }): string {
  return `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path}`
}

function isSame(a: Cookie, b: Cookie): boolean {
  return (
    a.value === b.value &&
    a.path === b.path &&
    a.secure === b.secure &&
    a.httpOnly === b.httpOnly &&
    a.sameSite === b.sameSite &&
    a.hostOnly === b.hostOnly &&
    a.session === b.session &&
    (a.session || Math.abs((a.expirationDate ?? 0) - (b.expirationDate ?? 0)) < 1)
  )
}

/**
 * Mirrors a cookie from one domain to another. Idempotent: if the target already holds an
 * identical cookie nothing is written, which is what stops echo loops between group members.
 */
export async function mirrorCookie(c: Cookie, from: string, to: string): Promise<boolean> {
  const domain = mapDomain(c.domain, from, to)
  const url = cookieUrl({ domain, path: c.path, secure: c.secure })
  const existing = await chrome.cookies.get({ url, name: c.name, storeId: c.storeId })
  if (existing && existing.domain === domain && isSame(existing, { ...c, domain })) return false

  await chrome.cookies.set({
    url,
    name: c.name,
    value: c.value,
    domain: c.hostOnly ? undefined : domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    expirationDate: c.session ? undefined : c.expirationDate,
    storeId: c.storeId,
  })
  return true
}

export async function mirrorRemoval(c: Cookie, from: string, to: string): Promise<boolean> {
  const domain = mapDomain(c.domain, from, to)
  const url = cookieUrl({ domain, path: c.path, secure: c.secure })
  const existing = await chrome.cookies.get({ url, name: c.name, storeId: c.storeId })
  if (!existing || existing.domain !== domain) return false
  await chrome.cookies.remove({ url, name: c.name, storeId: c.storeId })
  return true
}

export function setupCookieSync(): void {
  chrome.cookies.onChanged.addListener(async ({ cookie, removed, cause }) => {
    try {
      // Partitioned cookies belong to a third-party frame on some other site (Firefox partitions every
      // third-party cookie by default). Mirroring them as normal cookies would clobber real sessions.
      if (cookie.partitionKey) return
      const hit = findGroup((await getConfig()).groups, cookie.domain)
      if (!hit || !canPropagateFrom(hit.group, hit.base) || !hit.group.syncCookies || !matchesFilter(hit.group.cookieFilter, cookie.name)) return
      // "overwrite" is the delete half of an update; the set event follows. Only mirror real deletions.
      if (removed && cause !== 'explicit') return

      for (const to of hit.group.domains) {
        if (to === hit.base) continue
        try {
          const changed = removed
            ? await mirrorRemoval(cookie, hit.base, to)
            : await mirrorCookie(cookie, hit.base, to)
          if (changed) log('info', `cookie ${removed ? 'removed' : 'synced'}: ${cookie.name} (${hit.base} → ${to})`)
        } catch (e) {
          log('error', `cookie ${cookie.name} → ${to}: ${e instanceof Error ? e.message : e}`)
        }
      }
    } catch (e) {
      log('error', `cookie sync failed: ${e instanceof Error ? e.message : e}`)
    }
  })
}

/** One-shot copy of every matching cookie of `from` to the other domains of the group. */
export async function copyAllCookies(group: Group, from: string): Promise<number> {
  const cookies = await chrome.cookies.getAll({ domain: from })
  let n = 0
  for (const c of cookies) {
    if (!hostMatches(c.domain, from) || !matchesFilter(group.cookieFilter, c.name)) continue
    for (const to of group.domains) {
      if (to === from) continue
      try {
        if (await mirrorCookie(c, from, to)) n++
      } catch (e) {
        log('error', `copy ${c.name} → ${to}: ${e instanceof Error ? e.message : e}`)
      }
    }
  }
  return n
}
