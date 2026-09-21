module.exports = {
	env: {
		browser: true,
		es2021: true,
		node: true
	},
	extends: [
		'eslint:recommended',
		'plugin:react/recommended',
		'plugin:@typescript-eslint/recommended',
		'plugin:react/jsx-runtime'
	],
	overrides: [],
	parser: '@typescript-eslint/parser',
	parserOptions: {
		ecmaVersion: 'latest',
		sourceType: 'module'
	},
	plugins: ['react', 'react-hooks', '@typescript-eslint', 'import'],
	rules: {
		'@typescript-eslint/no-unused-vars': 'off',
		'@typescript-eslint/no-non-null-assertion': 'off',
		'no-console': 'off',
		'no-mixed-spaces-and-tabs': 'off',
		'no-useless-catch': 'off',
		'import/order': 'off',
		eqeqeq: 'error',
		'prefer-const': [
			'error',
			{
				destructuring: 'any',
				ignoreReadBeforeAssign: false
			}
		],
	},
	settings: {
		react: {
			version: 'detect'
		}
	}
};
