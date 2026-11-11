import { DEFAULT_CONFIG, type LogEntry, type SyncConfig } from './types'

export async function getConfig(): Promise<SyncConfig> {
  const { config } = await chrome.storage.local.get('config')
  return { ...DEFAULT_CONFIG, ...(config as Partial<SyncConfig> | undefined) }
}

export async function saveConfig(cfg: SyncConfig): Promise<void> {
  await chrome.storage.local.set({ config: cfg })
}

const MAX_LOG = 100
let logQueue: Promise<void> = Promise.resolve()

export function log(level: LogEntry['level'], msg: string): void {
  logQueue = logQueue.then(async () => {
    const { log: cur = [] } = (await chrome.storage.local.get('log')) as { log?: LogEntry[] }
    cur.push({ t: Date.now(), level, msg })
    await chrome.storage.local.set({ log: cur.slice(-MAX_LOG) })
  })
}
