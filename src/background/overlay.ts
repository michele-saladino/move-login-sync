/**
 * Injected into the active tab with chrome.scripting.executeScript({ func }). It is serialised, so it
 * must stay fully self-contained (no imports or outer variables).
 *
 * The menu is an <iframe> of the extension's popup.html floating over the page. The glass effect
 * (backdrop blur + tint) is applied to the iframe *element*: backdrop-filter inside the iframe would
 * only see the iframe's own content, not the page behind it.
 */
export function toggleOverlay(popupUrl: string): void {
  const ID = 'move-login-sync-overlay'
  const existing = document.getElementById(ID) as (HTMLIFrameElement & { __close?: () => void }) | null
  if (existing) {
    existing.__close?.()
    return
  }

  const dark = matchMedia('(prefers-color-scheme: dark)').matches
  const frame = document.createElement('iframe') as HTMLIFrameElement & { __close?: () => void }
  frame.id = ID
  frame.src = `${popupUrl}#host=${encodeURIComponent(location.hostname)}`
  frame.setAttribute('allowtransparency', 'true')
  const css: Record<string, string> = {
    all: 'initial',
    position: 'fixed',
    top: '12px',
    right: '12px',
    width: '400px',
    'max-width': 'calc(100vw - 24px)',
    height: '220px',
    'z-index': '2147483647',
    border: dark ? '1px solid rgba(255,255,255,.14)' : '1px solid rgba(0,0,0,.1)',
    'border-radius': '14px',
    background: dark ? 'rgba(24,24,27,.5)' : 'rgba(255,255,255,.5)',
    'backdrop-filter': 'blur(22px) saturate(170%)',
    '-webkit-backdrop-filter': 'blur(22px) saturate(170%)',
    'box-shadow': '0 12px 40px rgba(0,0,0,.22)',
    // Must equal the iframe document's color-scheme, otherwise Chrome paints an opaque backdrop.
    'color-scheme': 'dark light',
    opacity: '0',
    transform: 'translateY(-6px)',
    transition: 'opacity .15s, transform .15s, height .15s',
  }
  for (const [k, v] of Object.entries(css)) frame.style.setProperty(k, v, 'important')

  const close = () => {
    window.removeEventListener('message', onMessage)
    document.removeEventListener('keydown', onKey, true)
    document.removeEventListener('pointerdown', onDown, true)
    frame.remove()
  }
  const onMessage = (e: MessageEvent) => {
    if (e.source !== frame.contentWindow) return
    const d = e.data as { type?: string; height?: number } | null
    if (d?.type === 'mls-close') close()
    else if (d?.type === 'mls-height' && typeof d.height === 'number')
      frame.style.setProperty('height', Math.min(d.height, window.innerHeight - 24) + 'px', 'important')
  }
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
  const onDown = (e: Event) => e.target !== frame && close()

  frame.__close = close
  window.addEventListener('message', onMessage)
  document.addEventListener('keydown', onKey, true)
  document.addEventListener('pointerdown', onDown, true)
  document.documentElement.appendChild(frame)
  requestAnimationFrame(() => {
    frame.style.setProperty('opacity', '1', 'important')
    frame.style.setProperty('transform', 'none', 'important')
  })
}
