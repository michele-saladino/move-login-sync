<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { getConfig, saveConfig } from '../core/config'
import { findConflict, normalizeHost, originPattern } from '../core/match'
import { newGroup, type Group, type LogEntry, type SyncConfig } from '../core/types'

const cfg = reactive<SyncConfig>({ groups: [] })
const loaded = ref(false)
const log = ref<LogEntry[]>([])
const status = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const busy = ref(false)
const currentHost = ref('')
const granted = reactive<Record<string, boolean>>({})
const manual = reactive<Record<string, string>>({})
const open = reactive<Record<string, boolean>>({})

const say = (kind: 'ok' | 'error', text: string) => (status.value = { kind, text })
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

// --- persistence (debounced; the background reacts to the storage change) ---
let timer: number | undefined
watch(
  cfg,
  () => {
    if (!loaded.value) return
    window.clearTimeout(timer)
    timer = window.setTimeout(() => saveConfig(JSON.parse(JSON.stringify(cfg))), 250)
  },
  { deep: true },
)

function onStorage(changes: Record<string, chrome.storage.StorageChange>, area: string) {
  if (area === 'local' && changes.log) log.value = (changes.log.newValue as LogEntry[]).slice().reverse()
}

async function refreshGranted() {
  for (const g of cfg.groups)
    for (const d of g.domains) granted[d] = await chrome.permissions.contains({ origins: [originPattern(d)] })
}

onMounted(async () => {
  Object.assign(cfg, await getConfig())
  loaded.value = true
  for (const g of cfg.groups) open[g.id] = false
  const { log: l = [] } = (await chrome.storage.local.get('log')) as { log?: LogEntry[] }
  log.value = l.slice().reverse()
  chrome.storage.onChanged.addListener(onStorage)

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab?.url && /^https?:/.test(tab.url)) currentHost.value = normalizeHost(new URL(tab.url).hostname.replace(/^www\./, ''))
  } catch {
    /* no active tab */
  }
  await refreshGranted()
})
onUnmounted(() => chrome.storage.onChanged.removeListener(onStorage))

// --- groups ---
function createGroup() {
  const g = newGroup(`Group ${cfg.groups.length + 1}`)
  cfg.groups.push(g)
  open[g.id] = false
}

function deleteGroup(g: Group) {
  cfg.groups = cfg.groups.filter((x) => x.id !== g.id)
}

async function requestAccess(domains: string[]): Promise<boolean> {
  try {
    // If Chrome closes the popup for its prompt, the background still picks the grant up.
    const ok = await chrome.permissions.request({ origins: domains.map(originPattern) })
    await refreshGranted()
    return ok
  } catch (e) {
    say('error', errMsg(e))
    return false
  }
}

async function addDomain(g: Group, raw: string) {
  status.value = null
  const host = normalizeHost(raw)
  if (!host) return
  const conflict = findConflict(cfg.groups, host)
  if (conflict) return say('error', conflict)
  g.domains.push(host)
  manual[g.id] = ''
  granted[host] = false
  if (!(await requestAccess([host]))) say('error', `Access to ${host} was not granted — it will not sync until you allow it.`)
}

async function toggleEnabled(g: Group) {
  if (g.enabled && g.domains.length && !(await requestAccess(g.domains))) say('error', 'Access not granted for all domains.')
}

function removeDomain(g: Group, d: string) {
  g.domains = g.domains.filter((x) => x !== d)
}

async function copyFrom(g: Group, from: string) {
  busy.value = true
  status.value = null
  try {
    const r = (await chrome.runtime.sendMessage({ type: 'copy', groupId: g.id, from })) as {
      cookies?: number
      storage?: number
      storageError?: string
      error?: string
    }
    if (r.error) throw new Error(r.error)
    const parts: string[] = []
    if (r.cookies != null) parts.push(`${r.cookies} cookie(s) written`)
    if (r.storage != null) parts.push(`${r.storage} localStorage key(s) pushed`)
    if (r.storageError) parts.push(r.storageError)
    say(r.storageError ? 'error' : 'ok', parts.join(' · ') || 'Nothing to copy.')
  } catch (e) {
    say('error', errMsg(e))
  } finally {
    busy.value = false
  }
}

const canAddCurrent = (g: Group) => !!currentHost.value && !g.domains.includes(currentHost.value)
const fmt = (t: number) => new Date(t).toLocaleTimeString()
const hasGroups = computed(() => cfg.groups.length > 0)
</script>

<template>
  <main>
    <header>
      <h1>Move Login Sync</h1>
      <button class="primary" @click="createGroup">+ New group</button>
    </header>

    <p v-if="loaded && !hasGroups" class="empty">
      Create a group, then add the sites whose cookies and localStorage should stay aligned.
    </p>

    <section v-for="g in cfg.groups" :key="g.id" class="group" :class="{ off: !g.enabled }">
      <div class="g-head">
        <input v-model="g.name" class="name" aria-label="Group name" />
        <label class="switch" :title="g.enabled ? 'Sync on' : 'Sync paused'">
          <input v-model="g.enabled" type="checkbox" @change="toggleEnabled(g)" />
          <span class="slider"></span>
        </label>
        <button class="icon danger" title="Delete group" @click="deleteGroup(g)">🗑</button>
      </div>

      <ul class="domains">
        <li v-for="d in g.domains" :key="d">
          <span class="host">{{ d }}</span>
          <button v-if="granted[d] === false" class="warn" title="Chrome access is needed to sync this site" @click="requestAccess([d])">
            Grant access
          </button>
          <button class="icon" :disabled="busy || g.domains.length < 2 || !g.enabled" title="Copy this site's cookies and localStorage to the other sites of the group" @click="copyFrom(g, d)">⇄</button>
          <button class="icon" title="Remove from group" @click="removeDomain(g, d)">✕</button>
        </li>
        <li v-if="!g.domains.length" class="hint">No sites yet.</li>
        <li v-else-if="g.domains.length < 2" class="hint">Add at least one more site to start syncing.</li>
      </ul>

      <button v-if="canAddCurrent(g)" class="full" @click="addDomain(g, currentHost)">+ Add current site ({{ currentHost }})</button>
      <form class="add" @submit.prevent="addDomain(g, manual[g.id] ?? '')">
        <input v-model="manual[g.id]" placeholder="Add a URL or domain…" spellcheck="false" />
        <button :disabled="!(manual[g.id] ?? '').trim()">Add</button>
      </form>

      <button class="link" @click="open[g.id] = !open[g.id]">{{ open[g.id] ? '▾' : '▸' }} Options</button>
      <div v-if="open[g.id]" class="opts">
        <label class="check"><input v-model="g.syncCookies" type="checkbox" /> Cookies</label>
        <input v-model="g.cookieFilter" :disabled="!g.syncCookies" placeholder="Names, e.g. session*, token (empty = all)" />
        <label class="check"><input v-model="g.syncLocalStorage" type="checkbox" /> localStorage</label>
        <input v-model="g.storageFilter" :disabled="!g.syncLocalStorage" placeholder="Keys, e.g. auth* (empty = all)" />
      </div>
    </section>

    <p v-if="status" class="status" :class="status.kind">{{ status.text }}</p>

    <details v-if="log.length" class="activity">
      <summary>Activity</summary>
      <ul>
        <li v-for="(e, i) in log" :key="i" :class="e.level"><time>{{ fmt(e.t) }}</time> {{ e.msg }}</li>
      </ul>
    </details>

    <p class="hint">Syncing cookies shares logged-in sessions between sites. Use it only with sites you trust.</p>
  </main>
</template>

<style>
:root {
  color-scheme: light dark;
  --bg: #fff; --fg: #1d2330; --muted: #6a7385; --line: #d9dde6; --accent: #3b5bdb; --err: #c92a2a; --ok: #2b8a3e; --card: #f6f7fa; --warn: #e8590c;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #14171f; --fg: #e6e9f0; --muted: #9099ad; --line: #2b3140; --accent: #7c93f5; --err: #ff8787; --ok: #69db7c; --card: #1c212c; --warn: #ffa94d; }
}
body { margin: 0; width: 400px; background: var(--bg); color: var(--fg); font: 13px/1.4 system-ui, sans-serif; }
main { padding: 12px; max-height: 560px; overflow-y: auto; box-sizing: border-box; }
header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
h1 { font-size: 15px; margin: 0; }
button { font: inherit; padding: 5px 10px; border-radius: 6px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; }
button:disabled { opacity: .4; cursor: not-allowed; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.full { width: 100%; margin-bottom: 6px; }
button.icon { padding: 2px 6px; background: none; border-color: transparent; }
button.icon:hover:not(:disabled) { border-color: var(--line); }
button.danger:hover { color: var(--err); }
button.warn { color: var(--warn); border-color: var(--warn); padding: 1px 6px; font-size: 11px; }
button.link { background: none; border: none; padding: 4px 0 0; color: var(--muted); }
input:not([type='checkbox']) { font: inherit; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); width: 100%; box-sizing: border-box; }
input:disabled { opacity: .5; }
.group { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px; margin-bottom: 10px; }
.group.off .domains, .group.off .add { opacity: .55; }
.g-head { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
.name { font-weight: 600; background: transparent !important; border-color: transparent !important; }
.name:focus { border-color: var(--line) !important; }
.domains { list-style: none; margin: 0 0 8px; padding: 0; }
.domains li { display: flex; align-items: center; gap: 4px; padding: 3px 0; border-bottom: 1px solid var(--line); }
.domains li:last-child { border-bottom: none; }
.host { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, monospace; font-size: 12px; }
.add { display: flex; gap: 6px; }
.opts { display: grid; gap: 6px; margin-top: 6px; }
.check { display: flex; gap: 6px; align-items: center; }
.empty, .hint { color: var(--muted); font-size: 12px; margin: 6px 0; }
.status { padding: 6px 10px; border-radius: 6px; border: 1px solid var(--line); margin: 0 0 8px; }
.status.ok { color: var(--ok); } .status.error { color: var(--err); }
.activity summary { cursor: pointer; color: var(--muted); font-size: 12px; }
.activity ul { list-style: none; margin: 6px 0; padding: 0; max-height: 120px; overflow: auto; font: 11px/1.6 ui-monospace, monospace; }
.activity li.error { color: var(--err); }
.activity time { color: var(--muted); margin-right: 4px; }
.switch { position: relative; width: 34px; height: 18px; flex: none; }
.switch input { opacity: 0; width: 100%; height: 100%; position: absolute; margin: 0; cursor: pointer; z-index: 1; }
.slider { position: absolute; inset: 0; background: var(--line); border-radius: 9px; transition: background .15s; }
.slider::before { content: ''; position: absolute; width: 14px; height: 14px; left: 2px; top: 2px; background: #fff; border-radius: 50%; transition: transform .15s; }
.switch input:checked + .slider { background: var(--accent); }
.switch input:checked + .slider::before { transform: translateX(16px); }
</style>
