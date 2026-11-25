import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import crypto from 'node:crypto';

/** Writes precache.json (every built file + a build version) for the service worker. */
function precacheManifest(): Plugin {
  return {
    name: 'sf-precache-manifest',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map') && f !== 'index.html').map((f) => `/${f}`);
      const assets = [...new Set([...files, '/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/badge-72.png'])].sort();
      const version = crypto.createHash('sha256').update(assets.join('\n')).digest('hex').slice(0, 12);
      this.emitFile({ type: 'asset', fileName: 'precache.json', source: JSON.stringify({ version, assets }) });
    },
  };
}

export default defineConfig({
  plugins: [react(), precacheManifest()],
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
