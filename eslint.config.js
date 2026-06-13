const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

module.exports = [
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  js.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        dfu: 'writable',
        dfuse: 'writable',
        saveAs: 'writable',
        FileSaver: 'writable',
        gtag: 'readonly',
        posthog: 'readonly',
        module: 'readonly',
        define: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { vars: 'all', args: 'none', ignoreRestSiblings: true }],
      'no-undef': 'error',
      'no-redeclare': 'off',
      'no-useless-assignment': 'off',
      'no-prototype-builtins': 'off',
    },
  },
];
