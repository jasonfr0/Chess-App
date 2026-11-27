/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/Chess-App/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false, // registered by src/ui/UpdatePrompt.tsx, which asks before reloading
      includeAssets: ['icons/*.png'],
      manifest: {
        name: 'Chess Coach',
        short_name: 'Chess Coach',
        description: 'A personal chess coach that explains your moves.',
        start_url: '/Chess-App/',
        scope: '/Chess-App/',
        display: 'standalone',
        orientation: 'portrait',
        theme_color: '#1d5fc4',
        background_color: '#f4f4f1',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,wasm,png,svg,webmanifest}'],
        maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        // Keeps the app chunk under the 500 kB warning limit; the PWA precache glob covers it.
        manualChunks(id: string) {
          if (/[\\/]node_modules[\\/](react|react-dom|react-chessboard|chess\.js)[\\/]/.test(id)) return 'vendor';
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
  },
});
