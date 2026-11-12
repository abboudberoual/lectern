import globals from 'globals';

export default [
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.webextensions, chrome: 'readonly' },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-redeclare': 'error',
      'no-use-before-define': ['error', { functions: false, classes: false, variables: false }],
    },
  },
  // content.js runs as a classic script on youtube.com
  { files: ['src/content.js'], languageOptions: { sourceType: 'script' } },
];
