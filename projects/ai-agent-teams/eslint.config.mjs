import globals from 'globals';

const rules = {
  'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  'no-undef': 'error',
  'no-redeclare': 'error',
  'no-unreachable': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
};

export default [
  {
    ignores: ['dist/**', 'node_modules/**', '参考/**', '历史/**', '归档/**', 'assets/**'],
  },
  {
    files: ['src/**/*.mjs', 'scripts/**/*.mjs', 'test/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.node,
    },
    rules,
  },
  {
    files: ['ui-src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.browser,
    },
    rules,
  },
];
