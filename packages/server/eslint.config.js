const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const prettierPlugin = require('eslint-plugin-prettier');
const prettierConfig = require('eslint-config-prettier');

module.exports = [
  {
    ignores: ['dist', 'eslint.config.js'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: __dirname,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      prettier: prettierPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...prettierConfig.rules,
      ...prettierPlugin.configs.recommended.rules,
      '@typescript-eslint/interface-name-prefix': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      // `@ts-nocheck` suppresses entire-file type checking and is banned;
      // prefer precise types or a scoped `@ts-expect-error`/`@ts-ignore` note.
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-nocheck': true,
          'ts-ignore': false,
          'ts-expect-error': false,
        },
      ],
      // `require()` is intentionally used for lazy/circular dependency loading
      // in Objection.js models and `import = require()` in e2e specs.
      '@typescript-eslint/no-require-imports': 'off',
      // Money is rounded with the shared helper (@bigcapital/utils), never
      // with toFixed() or Math.round(x * 100), which keep the float error.
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='toFixed']",
          message:
            "toFixed() rounds the float error (1.005 -> '1.00'). For money use roundMoney / formatNumber.",
        },
        {
          selector:
            "CallExpression[callee.object.name='Math'][callee.property.name='round'] > BinaryExpression[operator='*'][right.value=100]",
          message:
            'Math.round(x * 100) is ad-hoc money rounding. Use roundMoney / toCents / moneyEq from @bigcapital/utils.',
        },
        {
          selector:
            "CallExpression[callee.object.name='Math'][callee.property.name='round'] > BinaryExpression[operator='*'][right.value=1000]",
          message:
            'Math.round(x * 1000) is ad-hoc money rounding. Use roundMoney / toCents / moneyEq from @bigcapital/utils.',
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Tests may sum expectations with ad-hoc rounding.
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts', 'test/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
];
