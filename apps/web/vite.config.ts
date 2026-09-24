import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [
    vue(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src/service-worker',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectManifest: { globPatterns: ['**/*.{js,css,html,png,svg,woff2}'] },
      manifest: {
        name: '简护 | Simcare',
        short_name: '简护',
        lang: 'zh-CN',
        start_url: '/',
        display: 'standalone',
        theme_color: '#087f72',
        background_color: '#f4f7f8',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        ],
      },
    }),
  ],
  server: { port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:8787' } },
  build: { outDir: '../../dist/web', emptyOutDir: true },
});
