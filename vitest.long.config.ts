import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/** Tests longs (`npm run test:long`) : fichiers *.long.test.ts, exclus de `npm test`. */
export default defineConfig({
  resolve: {
    alias: {
      '@engine': resolve(__dirname, 'src/engine'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: { include: ['tests/engine/**/*.long.test.ts'], environment: 'node' }
})
