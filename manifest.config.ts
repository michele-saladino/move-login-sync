/**
 * Builds manifest.json for each target browser. Both get the same pages and scripts; they differ only
 * in how the background runs (Chrome: service worker, Firefox: event page) and in Firefox's gecko block.
 */
import pkg from './package.json' with { type: 'json' }

export type Target = 'chrome' | 'firefox'
export const TARGETS: Target[] = ['chrome', 'firefox']

export function isTarget(mode: string): mode is Target {
  return (TARGETS as string[]).includes(mode)
}

export function buildManifest(target: Target): Record<string, unknown> {
  const base = {
    manifest_version: 3,
    name: 'Move Login Sync',
    version: pkg.version,
    description: 'Keeps cookies and localStorage aligned across groups of domains.',
    permissions: ['cookies', 'storage', 'scripting', 'activeTab'],
    optional_host_permissions: ['*://*/*'],
  }

  if (target === 'chrome')
    return {
      ...base,
      // No default_popup: the icon click floats the menu over the page (background/overlay.ts).
      action: { default_title: 'Move Login Sync' },
      web_accessible_resources: [{ resources: ['popup.html'], matches: ['<all_urls>'] }],
      background: { service_worker: 'background.js', type: 'module' },
    }

  return {
    ...base,
    // A regular popup instead of the floating overlay: in Firefox an extension page framed inside a web
    // page only gets the content-script APIs (no permissions, tabs or cookies), so the menu could not
    // ask for host access. popup.html then needs no web_accessible_resources either.
    action: { default_title: 'Move Login Sync', default_popup: 'popup.html' },
    // Firefox has no extension service workers: the same module runs as a non-persistent event page.
    background: { scripts: ['background.js'], type: 'module' },
    browser_specific_settings: {
      gecko: {
        id: 'move-login-sync@movesolutions.it',
        // 140 is the current ESR and the first release that understands data_collection_permissions.
        strict_min_version: '140.0',
        data_collection_permissions: { required: ['none'] },
      },
      // Firefox for Android reads data_collection_permissions only from 142 on.
      gecko_android: { strict_min_version: '142.0' },
    },
  }
}
