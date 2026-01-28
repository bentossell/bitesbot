import js from '@eslint/js'
import globals from 'globals'
import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'

export default [
	{ ignores: ['dist/**'] },
	js.configs.recommended,
	{
		files: ['**/*.ts'],
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				project: ['./tsconfig.json', './tsconfig.test.json'],
				sourceType: 'module',
			},
			globals: {
				...globals.node,
				...globals.browser,
			},
		},
		plugins: {
			'@typescript-eslint': tsPlugin,
		},
		rules: {
			...tsPlugin.configs.recommended.rules,
			'no-undef': 'off',
		},
	},
]
