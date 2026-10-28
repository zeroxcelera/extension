import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const BANNED_SYNTAX = [
  {
    selector: 'MemberExpression[property.name=/^(innerHTML|outerHTML)$/]',
    message: 'Token data is untrusted: build DOM with text nodes, never HTML strings.',
  },
  {
    selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
    message: 'Token data is untrusted: build DOM with text nodes, never HTML strings.',
  },
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: 'Token data is untrusted: never render raw HTML.',
  },
  { selector: "NewExpression[callee.name='Function']", message: 'No dynamic code.' },
];

export default tseslint.config(
  { ignores: ['.output/', '.wxt/', 'node_modules/', 'coverage/', 'contracts/'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-restricted-syntax': ['error', ...BANNED_SYNTAX],
      // Nothing derived from wallet state may be logged; easiest rule: no console at all.
      'no-console': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['tests/**'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off', 'no-console': 'off' },
  },
);
