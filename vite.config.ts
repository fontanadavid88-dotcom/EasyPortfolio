import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ command }) => ({
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    watch: {
      usePolling: true,
      interval: 1000
    },
    hmr: {
      host: 'localhost',
      port: 5173,
      protocol: 'ws'
    }
  },
  resolve: {
    alias: [
      { find: /^lodash\/(.*)$/, replacement: 'lodash-es/$1.js' },
    ]
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'EasyPortfolio',
        short_name: 'EasyPF',
        description: 'Personal Portfolio Tracker & Rebalancing Tool',
        theme_color: '#ffffff',
        icons: [
          {
            src: 'https://picsum.photos/192/192',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'https://picsum.photos/512/512',
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      }
    })
  ].filter(Boolean)
}));
