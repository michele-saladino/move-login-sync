<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { getConfig, saveConfig } from '../core/config'
import { findConflict, normalizeHost, originPattern, primaryOf } from '../core/match'
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

// Embedded = floating over a page (see background/overlay.ts); otherwise a standalone window.
const embedded = window.parent !== window
const close = () => window.parent.postMessage({ type: 'mls-close' }, '*')
const hashHost = new URLSearchParams(location.hash.slice(1)).get('host') ?? ''
const cleanHost = (h: string) => normalizeHost(h.replace(/^www\./, ''))

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

  if (!embedded) document.documentElement.classList.add('standalone')
  if (hashHost) currentHost.value = cleanHost(hashHost)
  else {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
      if (tab?.url && /^https?:/.test(tab.url)) currentHost.value = cleanHost(new URL(tab.url).hostname)
    } catch {
      /* no active tab */
    }
  }
  if (embedded) {
    // Let the overlay size the iframe to its content.
    new ResizeObserver(() => window.parent.postMessage({ type: 'mls-height', height: document.body.offsetHeight }, '*')).observe(document.body)
    window.addEventListener('keydown', (e) => e.key === 'Escape' && close())
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
    // If the browser closes the menu for its prompt, the background still picks the grant up.
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
  if (g.primary === d) g.primary = null
  g.domains = g.domains.filter((x) => x !== d)
}

/** Star / unstar. Starring makes the domain the source of truth and mirrors it to the others right away. */
async function toggleStar(g: Group, d: string) {
  g.primary = g.primary === d ? null : d
  window.clearTimeout(timer)
  await saveConfig(JSON.parse(JSON.stringify(cfg))) // the background needs the new mode before it copies
  if (g.primary && g.enabled && g.domains.length > 1) await copyFrom(g, d)
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
      <div class="h-actions">
        <button class="primary" @click="createGroup">+ New group</button>
        <button v-if="embedded" class="icon" title="Close (Esc)" @click="close">✕</button>
      </div>
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

      <p class="mode">
        <template v-if="primaryOf(g)">★ <b>{{ primaryOf(g) }}</b> mirrors to the other sites; they don't write back.</template>
        <template v-else>All sites stay aligned both ways. Star one to make it the source.</template>
      </p>

      <ul class="domains">
        <li v-for="d in g.domains" :key="d">
          <button class="icon star" :class="{ on: primaryOf(g) === d }" :disabled="busy" :title="primaryOf(g) === d ? 'Source of truth — click to unstar' : 'Star: mirror this site to all the others'" @click="toggleStar(g, d)">{{ primaryOf(g) === d ? '★' : '☆' }}</button>
          <span class="host">{{ d }}</span>
          <button v-if="granted[d] === false" class="warn" title="Browser access is needed to sync this site" @click="requestAccess([d])">
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
/* Minimal: neutral greys on a clear background, flat hairline borders, one quiet accent. */
:root {
  color-scheme: dark light;
  --fg: rgba(255, 255, 255, .92); --muted: rgba(255, 255, 255, .5);
  --layer: rgba(255, 255, 255, .06); --layer-hi: rgba(255, 255, 255, .12);
  --edge: rgba(255, 255, 255, .14); --field: rgba(0, 0, 0, .18);
  --accent: rgba(255, 255, 255, .92); --on-accent: #111; --fallback: #1b1b1d;
  --err: #e08a8a; --ok: #8ccaa0; --warn: #d9b27a; --star: #e6c36a;
}
@media (prefers-color-scheme: light) {
  :root {
    --fg: rgba(0, 0, 0, .86); --muted: rgba(0, 0, 0, .5);
    --layer: rgba(255, 255, 255, .32); --layer-hi: rgba(255, 255, 255, .55);
    --edge: rgba(0, 0, 0, .12); --field: rgba(255, 255, 255, .4);
    --accent: rgba(0, 0, 0, .85); --on-accent: #fff; --fallback: #f4f4f5;
    --err: #b54545; --ok: #3f8a5c; --warn: #9a6b1f; --star: #b98600;
  }
}
* { box-sizing: border-box; }
html, body { background: transparent; }
.standalone body { background: var(--fallback); min-width: 380px; } /* Firefox popups size to their content */
body { margin: 0; color: var(--fg); font: 13px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif; }
main { padding: 14px; }
html { scrollbar-width: thin; scrollbar-color: var(--edge) transparent; }

header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.h-actions { display: flex; gap: 4px; align-items: center; }
h1 { font-size: 13px; font-weight: 600; margin: 0; letter-spacing: .02em; }

.group, .status, .activity {
  position: relative; margin: 0 0 10px; padding: 10px; border-radius: 12px;
  background: var(--layer); border: 1px solid var(--edge);
}
.group.off { opacity: .65; }
.status { padding: 8px 10px; font-size: 12px; }
.status.ok { color: var(--ok); } .status.error { color: var(--err); }

button {
  font: inherit; padding: 5px 11px; border-radius: 8px; color: var(--fg); cursor: pointer;
  background: transparent; border: 1px solid var(--edge); transition: background .12s;
}
button:hover:not(:disabled) { background: var(--layer-hi); }
button:disabled { opacity: .35; cursor: not-allowed; }
button:focus-visible, input:focus-visible { outline: 1px solid var(--fg); outline-offset: 1px; }
button.primary { background: var(--accent); color: var(--on-accent); border-color: transparent; font-weight: 500; }
button.primary:hover:not(:disabled) { background: var(--accent); opacity: .85; }
button.full { width: 100%; margin-bottom: 8px; color: var(--muted); border-style: dashed; }
button.full:hover:not(:disabled) { color: var(--fg); }
button.icon { padding: 2px 6px; border-color: transparent; color: var(--muted); }
button.icon:hover:not(:disabled) { color: var(--fg); background: var(--layer-hi); }
button.danger:hover:not(:disabled) { color: var(--err); }
button.warn { color: var(--warn); border-color: var(--warn); padding: 0 7px; font-size: 11px; }
button.link { background: none; border: none; padding: 6px 0 0; color: var(--muted); font-size: 12px; }
button.link:hover { background: none; color: var(--fg); }
.star { font-size: 14px; }
.star.on { color: var(--star); }

input:not([type='checkbox']) {
  font: inherit; padding: 6px 9px; width: 100%; color: var(--fg); border-radius: 8px;
  background: var(--field); border: 1px solid var(--edge);
}
input::placeholder { color: var(--muted); }
input:disabled { opacity: .4; }
.name { font-weight: 600; background: transparent !important; border-color: transparent !important; padding-left: 4px !important; }
.name:hover, .name:focus { border-color: var(--edge) !important; }

.g-head { display: flex; gap: 6px; align-items: center; margin-bottom: 4px; }
.mode { margin: 0 0 8px; padding: 0 4px; font-size: 12px; color: var(--muted); }
.mode b { color: var(--fg); font-weight: 500; }
.domains { list-style: none; margin: 0 0 8px; padding: 0; }
.domains li { display: flex; align-items: center; gap: 2px; padding: 3px 0; border-top: 1px solid var(--edge); }
.domains li:first-child { border-top: none; }
.host { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12px ui-monospace, 'SF Mono', monospace; }
.add { display: flex; gap: 6px; }
.add input { flex: 1; }
.opts { display: grid; gap: 6px; margin-top: 6px; }
.check { display: flex; gap: 6px; align-items: center; }
.check input { accent-color: currentColor; }
.empty, .hint { color: var(--muted); font-size: 12px; margin: 6px 4px; }
.domains .hint { margin: 2px 4px; }

.activity { padding: 8px 10px; }
.activity summary { cursor: pointer; color: var(--muted); font-size: 12px; }
.activity ul { list-style: none; margin: 6px 0 0; padding: 0; max-height: 120px; overflow: auto; font: 11px/1.6 ui-monospace, monospace; }
.activity li.error { color: var(--err); }
.activity time { color: var(--muted); margin-right: 4px; }

.switch { position: relative; width: 30px; height: 18px; flex: none; }
.switch input { opacity: 0; width: 100%; height: 100%; position: absolute; margin: 0; cursor: pointer; z-index: 1; }
.slider { position: absolute; inset: 0; border-radius: 9px; background: var(--layer-hi); border: 1px solid var(--edge); transition: background .15s; }
.slider::before { content: ''; position: absolute; width: 12px; height: 12px; left: 2px; top: 2px; border-radius: 50%; background: var(--muted); transition: transform .15s, background .15s; }
.switch input:checked + .slider { background: var(--accent); border-color: transparent; }
.switch input:checked + .slider::before { background: var(--on-accent); transform: translateX(12px); }
</style>
