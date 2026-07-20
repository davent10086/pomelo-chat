module.exports = {
	root: true,
	env: {
		browser: true,
		commonjs: true,
		es2021: true,
		node: true
	},
	overrides: [
		{
			files: ['**/*.ts'],
			parser: '@typescript-eslint/parser',
			parserOptions: {
				ecmaVersion: 'latest',
				sourceType: 'module'
			},
			plugins: ['@typescript-eslint'],
			extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
			rules: {
				'no-console': 'error',
				'@typescript-eslint/no-explicit-any': 'off',
				'@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
				'@typescript-eslint/no-var-requires': 'off'
			}
		},
		{
			files: ['.eslintrc.{js,cjs}'],
			env: { node: true },
			parserOptions: { sourceType: 'script' }
		}
	],
	parserOptions: {
		ecmaVersion: 'latest'
	},
	rules: {
		'no-console': 'error',
		eqeqeq: 'error',
		'prefer-const': [
			'error',
			{
				destructuring: 'any',
				ignoreReadBeforeAssign: false
			}
		]
	}
};
