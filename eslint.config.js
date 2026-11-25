/**
 * ESLint 9 Flat Config for LingXi Engine
 * Migrated from legacy .eslintrc for ESLint 9.x
 */
import js from '@eslint/js';
import typescriptEslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';

export default [
  // Ignore patterns
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'workspace/**',
      'bench/**',
      'src/core/index.ts',
      'src/router.ts',
      'src/index.ts',
      'src/tests/**',
      '_*.ts',
      '_*.js',
      'mobile-dist/**',
      'stage/**',
      'mobile-app/**',
      'app/**',
      'stages/**',
      'backup*/**',
      'backups/**',
      'rollback_*/**',
      'archive*/**',
      '_archive*/**',
      '_trash_*/**',
      '_trash_*/**',
      'archives/**',
      'backup_pre_*/**',
      'backup_sync_*/**',
      '*.bak*',
      '_tmp_*/**',
      '_data_*/**',
      'data-e2e*/**',
      '_release-*/**',
      '_recheck*/**',
      '_patch*/**',
      '_verify*/**',
      '_social*/**',
      'deploy/**',
      '_check*/**',
      '_find*/**',
      '_fix*/**',
      'check-*/**',
      'deploy-*/**',
      'diff-*/**',
      'e2e*/**',
      'extract_*/**',
      'find_*/**',
      'fix_*/**',
      'probe-*/**',
      'ERR',
      'ConnectTimeout=8',
      '*.config.js',
      '*.config.mjs',
      '*.config.cjs',
      '*.cjs',
      '*.mjs',
      '*.md',
      '*.json',
      '*.yml',
      '*.yaml',
      '*.toml',
      '*.lock',
      '*.log',
      '*.sqlite',
      '*.db',
      '*.sqlite3',
      '*.wasm',
      '*.map',
      '*.min.js',
      '*.min.css',
      'web/js/app.js',
      'web/js/relay-shim.js',
      'web/js/i18n.js',
      'scripts/**',
      'web/**/*.js',
      'web/**/*.css',
      'web/**/*.html',
      'web/**/*.svg',
      'web/**/*.png',
      'web/**/*.jpg',
      'web/**/*.jpeg',
      'web/**/*.gif',
      'web/**/*.webp',
      'web/**/*.ico',
      'web/**/*.woff',
      'web/**/*.woff2',
      'web/**/*.ttf',
      'web/**/*.eot',
      'web/**/*.map',
    ],
  },

  // Base JS/TS recommended rules
  js.configs.recommended,

  // TypeScript recommended rules
  ...typescriptEslint.configs.recommended,

  // Prettier compatibility (disable conflicting rules)
  prettierConfig,

  // Custom rules for TypeScript files
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { import: importPlugin },
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TypeScript specific
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-misused-promises': 'warn',
      '@typescript-eslint/require-await': 'warn',
      '@typescript-eslint/no-unnecessary-condition': 'warn',

      // General
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-debugger': 'warn',
      'no-alert': 'warn',
      'no-duplicate-imports': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': ['warn', { checkLoops: false }],
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': 'error',
      'prefer-arrow-callback': 'error',
      'prefer-template': 'error',
      'template-curly-spacing': 'error',

      // Async/await
      'require-await': 'warn',

      // Imports
      'import/order': ['error', {
        groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
        pathGroups: [
          { pattern: '@/**', group: 'internal' },
          { pattern: './**', group: 'sibling' },
        ],
        pathGroupsExcludedImportTypes: ['builtin'],
        alphabetize: { order: 'asc', caseInsensitive: true },
      }],
    },
  },

  // Config files (JS/CJS/MJS)
  {
    files: ['*.config.js', '*.config.mjs', '*.config.cjs', '*.cjs', '*.mjs'],
    languageOptions: {
      globals: {
        module: 'readonly',
        require: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        global: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-var-requires': 'off',
    },
  },

  // Test files
  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**/*.ts'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        vi: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
];