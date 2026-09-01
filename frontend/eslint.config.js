import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import reactCompiler from 'eslint-plugin-react-compiler'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Excluded from tsconfig.app.json (it imports reef/admin-ui, which the
  // frontend Docker build context doesn't contain), so type-aware linting
  // can't parse it either. CI runs it under vitest with the whole repo.
  globalIgnores(['dist', 'src/components/reef/envApplyParity.test.ts']),
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-compiler': reactCompiler,
    },
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Allow void to mark intentionally ignored promises
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      // Allow unused vars prefixed with _
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Relax for React event handlers that return void
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      // The React Compiler family flags code the compiler declines to optimize
      // (a ref read during render, a setState inside an effect), not code that
      // is wrong — and where the effect IS the right tool, the "fix" is a
      // contortion. Advisory: visible in the editor, never blocking CI.
      'react-compiler/react-compiler': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      // Numbers read fine inside a template literal.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // `||` is deliberate wherever an empty string means "absent" (display
      // names, handles, stored drafts) — `??` would keep the "".
      '@typescript-eslint/prefer-nullish-coalescing': ['error', { ignorePrimitives: { string: true } }],
      // `arr[i]!` after a bounds check is the idiomatic escape from
      // noUncheckedIndexedAccess; spelling it out adds noise, not safety.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Off because it can't see through a boolean mutated inside a closure:
      // every `cancelled` teardown flag reads as permanently false, so its
      // "always truthy/falsy" reports would have us delete live guards.
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },
  // Relax rules for shadcn generated components and hooks
  {
    files: ['src/components/ui/**/*.tsx', 'src/hooks/**/*.ts'],
    rules: {
      'react-refresh/only-export-components': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },
])
