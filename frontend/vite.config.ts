/// <reference types="vitest/config" />
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

function offlineShell(): Plugin {
  return {
    name: 'lexicona-offline-shell',
    apply: 'build',
    generateBundle: {
      order: 'post',
      handler(_, bundle) {
        const shell = bundle['index.html']
        if (shell?.type !== 'asset') this.error('Offline shell requires index.html')
        const worker = readFileSync(new URL('./service-worker.js', import.meta.url), 'utf8')
        const files = [
          '/index.html',
          '/manifest.webmanifest',
          '/icons/apple-touch-icon.png',
          '/icons/icon-192.png',
          '/icons/icon-512.png',
          '/icons/icon-maskable-512.png',
          ...Object.keys(bundle)
            .filter((file) => file.startsWith('assets/'))
            .sort()
            .map((file) => `/${file}`),
        ]
        const version = createHash('sha256')
          .update(shell.source)
          .update(worker)
          .update(JSON.stringify(files))
          .digest('hex')
        this.emitFile({
          type: 'asset',
          fileName: 'service-worker.js',
          source: `const version = ${JSON.stringify(version)}\nconst publicFiles = ${JSON.stringify(files)}\n${worker}`,
        })
      },
    },
  }
}

export default defineConfig({
  plugins: [react(), offlineShell()],
  server: {
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
})
