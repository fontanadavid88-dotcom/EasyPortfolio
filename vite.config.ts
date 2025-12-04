import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'mask-icon.svg'],
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
  ]
})