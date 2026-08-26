import globals from 'globals'
import pluginJs from '@eslint/js'

export default [
  pluginJs.configs.recommended,
  {
    ignores: [
      'coverage/**'
    ]
  },
  {
    languageOptions: {
      globals: {
        ...globals.node
      }
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    },
    plugins: {
      jest: {
        extends: ['eslint:recommended'],
        rules: {
          'jest/no-disabled-tests': 'error',
          'jest/no-focused-tests': 'error',
          'jest/no-identical-title': 'error',
          'jest/prefer-to-have-length': 'error',
          'jest/valid-expect': 'error'
        }
      }
    }
  }
]
