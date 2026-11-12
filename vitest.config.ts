import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@engine': resolve(__dirname, 'src/engine'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    include: ['tests/engine/**/*.test.ts', 'tests/shared/**/*.test.ts'],
    // Les tests longs (*.long.test.ts) ont leur commande : npm run test:long
    exclude: ['**/node_modules/**', '**/*.long.test.ts'],
    environment: 'node',
    // npm run test:coverage : couverture du moteur (cible ≥ 80 % des lignes), rapport dans coverage/
    coverage: {
      provider: 'v8',
      include: ['src/engine/**'],
      reporter: ['text-summary', 'html'],
      reportsDirectory: 'coverage'
    }
  }
})
