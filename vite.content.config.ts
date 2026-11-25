import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { isTarget } from './manifest.config.ts'

export default defineConfig(({ mode }) => ({
  publicDir: false,
  build: {
    outDir: `dist/${isTarget(mode) ? mode : 'chrome'}`,
    emptyOutDir: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/content/index.ts'),
      formats: ['iife'],
      name: 'MoveLoginSyncContent',
      fileName: () => 'content.js',
    },
  },
}))
