import path from 'path';

import react from '@vitejs/plugin-react-swc';
import { defineConfig } from 'vite';

// https://vitejs.dev/config/
export default defineConfig({
	plugins: [react()],
	// The upload worker loads this lazily; prebundle it before serving pages so
	// first upload cannot trigger dependency optimization and a full-page reload.
	optimizeDeps: { include: ['spark-md5'] },
	server: {
		open: process.env.POMELO_DESKTOP_DEV !== '1',
		host: '0.0.0.0',
		port: 5173
	},
	resolve: {
		alias: {
			'@': path.resolve(__dirname, './src')
		}
	},
	build: {
		rollupOptions: {
			output: {
				manualChunks: {
					react: ['react', 'react-dom', 'react-router-dom'],
					vendor: ['axios', 'dayjs', 'spark-md5']
				}
			}
		}
	}
});
