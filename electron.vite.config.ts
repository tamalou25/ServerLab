import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/** Alias communs aux différents process. */
const alias = {
  '@engine': resolve(__dirname, 'src/engine'),
  '@shared': resolve(__dirname, 'src/shared'),
  '@renderer': resolve(__dirname, 'src/renderer/src')
}

/** CSP stricte en production (frame-ancestors est ignoré dans une balise meta, donc absent). */
const CSP_PROD = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

/** CSP de développement : assouplie uniquement pour le HMR de Vite (scripts/styles injectés, websocket). */
const CSP_DEV = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws://localhost:* http://localhost:*",
  "object-src 'none'",
  "base-uri 'none'"
].join('; ')

/** Injecte la balise meta CSP adaptée au mode (dev ou build). */
function cspPlugin(): Plugin {
  let isDev = false
  return {
    name: 'serverlab-csp',
    configResolved(config) {
      isDev = config.command === 'serve'
    },
    transformIndexHtml(html) {
      const csp = isDev ? CSP_DEV : CSP_PROD
      return html.replace('%CSP%', csp)
    }
  }
}

export default defineConfig({
  main: {
    resolve: { alias }
  },
  preload: {
    resolve: { alias }
  },
  renderer: {
    resolve: { alias },
    plugins: [react(), tailwindcss(), cspPlugin()],
    build: {
      // Aucune ressource inlinée en data: (polices comprises) : la CSP n'autorise que 'self'
      assetsInlineLimit: 0,
      // Bundle minifié : moins de code à analyser au démarrage (audit P-02)
      minify: 'esbuild'
    }
  }
})
