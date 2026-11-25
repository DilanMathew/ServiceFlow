import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: { port: 5173, proxy: { '/api': 'http://localhost:4000' } },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1200,
    rollupOptions: { output: { manualChunks(id: string) {
      if (!id.includes('node_modules')) return undefined;
      if (/[\\/](recharts|d3-[a-z]+|victory-vendor)[\\/]/.test(id)) return 'charts';
      if (/[\\/]@tanstack[\\/]/.test(id)) return 'query';
      if (/[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) return 'react';
      return undefined;
    } } } },
});
