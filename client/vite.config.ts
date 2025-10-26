import path from 'path';

import react from '@vitejs/plugin-react-swc';
import { defineConfig } from 'vite';

// https://vitejs.dev/config/
export default defineConfig({
	plugins: [react()],
	server: {
		open: true,
		host: '0.0.0.0',
		port: 5173
	},
	resolve: {
		alias: {
			'@': path.resolve(__dirname, './src')
		}
	}
});
