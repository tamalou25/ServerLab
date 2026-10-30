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
    environment: 'node',
    // npm run test:coverage : couverture du moteur (cible ≥ 80 % des lignes), rapport dans coverage/
    coverage: {
      provider: 'v8',
      include: ['src/engine/**'],
      reporter: ['text-summary', 'html'],
      reportsDirectory: 'coverage',
      // Garde-fou CI : niveau mesuré sur main (lignes 93,14, branches 77,98, fonctions 94,53, instructions 89,89) moins 0,5 point ; la CI échoue si la couverture baisse
      thresholds: { lines: 92.6, branches: 77.4, functions: 94.0, statements: 89.4 }
    }
  }
})
