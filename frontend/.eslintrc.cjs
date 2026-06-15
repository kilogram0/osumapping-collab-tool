module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs'],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  rules: {
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      },
    ],
    '@typescript-eslint/no-explicit-any': 'off',
    'no-constant-condition': ['error', { checkLoops: false }],
    'no-console': ['error', { allow: ['warn', 'error'] }],
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
  },
  overrides: [
    {
      files: [
        'src/components/resourceIcons.tsx',
        'src/contexts/*.tsx',
        'src/hooks/*.tsx',
      ],
      rules: {
        'react-refresh/only-export-components': 'off',
      },
    },
  ],
};
