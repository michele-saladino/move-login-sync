import { describe, expect, it } from 'vitest'
import { canPropagateFrom, findConflict, findGroup, hostMatches, isValidHost, mapDomain, matchesFilter, normalizeHost } from './match'
import { newGroup } from './types'

const group = (name: string, domains: string[]) => ({ ...newGroup(name), domains })

describe('match', () => {
  it('normalizes hosts', () => {
    expect(normalizeHost('https://Www.Example.com:8080/a?b')).toBe('www.example.com')
    expect(normalizeHost('*.example.com')).toBe('example.com')
  })
  it('validates hosts', () => {
    expect(isValidHost('a.example.com')).toBe(true)
    expect(isValidHost('localhost')).toBe(true)
    expect(isValidHost('not a host')).toBe(false)
    expect(isValidHost('')).toBe(false)
  })
  it('matches subdomains only on label boundary', () => {
    expect(hostMatches('.app.a.com', 'a.com')).toBe(true)
    expect(hostMatches('a.com', 'a.com')).toBe(true)
    expect(hostMatches('nota.com', 'a.com')).toBe(false)
  })
  it('maps domains', () => {
    expect(mapDomain('.app.a.com', 'a.com', 'b.org')).toBe('.app.b.org')
    expect(mapDomain('a.com', 'a.com', 'b.org')).toBe('b.org')
  })
  it('filters with wildcards', () => {
    expect(matchesFilter('', 'x')).toBe(true)
    expect(matchesFilter('sess*, token', 'session_id')).toBe(true)
    expect(matchesFilter('sess*, token', 'tokens')).toBe(false)
  })
  it('finds the owning group, ignoring inactive ones', () => {
    const g = group('G', ['a.com', 'b.org'])
    expect(findGroup([g], '.app.b.org')?.base).toBe('b.org')
    expect(findGroup([g], 'c.net')).toBeNull()
    expect(findGroup([{ ...g, enabled: false }], 'a.com')).toBeNull()
    expect(findGroup([group('Solo', ['a.com'])], 'a.com')).toBeNull()
  })
  it('only the starred domain propagates', () => {
    const g = group('G', ['a.com', 'b.org'])
    expect(canPropagateFrom(g, 'b.org')).toBe(true)
    const starred = { ...g, primary: 'a.com' }
    expect(canPropagateFrom(starred, 'a.com')).toBe(true)
    expect(canPropagateFrom(starred, 'b.org')).toBe(false)
    expect(canPropagateFrom({ ...g, primary: 'gone.com' }, 'b.org')).toBe(true)
  })
  it('detects duplicate and nested domains across groups', () => {
    const groups = [group('G', ['a.com']), group('H', ['b.org'])]
    expect(findConflict(groups, 'a.com')).toMatch(/already in/)
    expect(findConflict(groups, 'app.a.com')).toMatch(/overlaps/)
    expect(findConflict(groups, 'c.net')).toBeNull()
  })
})
