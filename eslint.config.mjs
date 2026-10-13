// Configuration ESLint (flat config)
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error'
    }
  },
  // Règles avec information de type (sources TypeScript de l'application) : promesses non attendues
  // ou passées là où un résultat synchrone est attendu, switch non exhaustif (audit Q-01)
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true, allowDefaultCaseForExhaustiveSwitch: true }
      ]
    }
  },
  // Process principal, preload, scripts et configs : environnement Node
  {
    files: ['src/main/**', 'src/preload/**', 'scripts/**', '*.config.*', 'tests/**'],
    languageOptions: { globals: { ...globals.node } }
  },
  // Renderer React
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Contenus importés (labs, fichiers .slab) : jamais injectés comme HTML brut
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'HTML brut interdit : afficher le contenu avec des éléments React.'
        }
      ]
    }
  },
  // Moteur pur : aucune dépendance UI / Electron / Node
  {
    files: ['src/engine/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react-*', 'react/*'],
              message: 'Le moteur doit rester indépendant de React.'
            },
            { group: ['electron', 'electron/*'], message: 'Le moteur doit rester indépendant d’Electron.' },
            {
              group: ['node:*', 'fs', 'path', 'os', 'child_process'],
              message: 'Le moteur ne doit pas dépendre de Node.'
            },
            {
              group: ['@xyflow/*', 'zustand', 'zustand/*', 'lucide-react'],
              message: 'Dépendance UI interdite dans le moteur.'
            },
            {
              group: ['@renderer/*', '../renderer/*', '../main/*'],
              message: 'Le moteur ne doit pas importer l’UI.'
            }
          ]
        }
      ],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'Pas de DOM dans le moteur.' },
        { name: 'document', message: 'Pas de DOM dans le moteur.' }
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Moteur déterministe : utiliser state.seq.' },
        { object: 'Date', property: 'now', message: 'Moteur déterministe : utiliser state.clock.' }
      ]
    }
  },
  prettier
)
