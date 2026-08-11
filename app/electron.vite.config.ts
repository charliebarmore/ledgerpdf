import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const devConnectSrc = {
  name: 'ledgerpdf-dev-connect-src',
  apply: 'serve' as const,
  transformIndexHtml(html: string): string {
    return html.replace(
      "connect-src 'self';",
      "connect-src 'self' ws://localhost:* http://localhost:*;"
    )
  }
}

export default defineConfig({
  main: {
    // Packaging intentionally excludes node_modules. The lock implementation
    // is runtime code used by Electron main, so bundle it into out/main rather
    // than leaving a require() that works in dev and fails only after install.
    plugins: [externalizeDepsPlugin({ exclude: ['proper-lockfile'] })],
    build: { rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') } }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), devConnectSrc],
    build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } }
  }
})
