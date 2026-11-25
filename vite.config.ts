import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'
import { buildManifest, isTarget, type Target } from './manifest.config.ts'

// Main build: options page (Vue) + background script (ES module), plus manifest.json for the target
// browser. The content script is built separately (vite.content.config.ts) as a standalone IIFE.
// The target is the Vite mode: `vite build --mode chrome` → dist/chrome, `--mode firefox` → dist/firefox.
export default defineConfig(({ mode }) => {
  const target: Target = isTarget(mode) ? mode : 'chrome'
  return {
    plugins: [vue(), manifest(target)],
    publicDir: false,
    build: {
      outDir: `dist/${target}`,
      emptyOutDir: true,
      modulePreload: { polyfill: false },
      rollupOptions: {
        input: {
          popup: resolve(import.meta.dirname, 'popup.html'),
          background: resolve(import.meta.dirname, 'src/background/index.ts'),
        },
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  }
})

function manifest(target: Target): Plugin {
  return {
    name: 'extension-manifest',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: JSON.stringify(buildManifest(target), null, 2) })
    },
  }
}
