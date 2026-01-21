import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const resolveDevPort = () => {
  const raw = process.env.PORT;
  if (!raw) return 5173;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5173;
};

export default defineConfig(() => {
  const devPort = resolveDevPort();
  const hmrHost = process.env.HMR_HOST || 'localhost';
  const isVercelDev = Boolean(process.env.VERCEL || process.env.VERCEL_DEV);
  const cwd = process.cwd();
  const forcedRoot = process.env.VITE_PROJECT_ROOT;
  const root = forcedRoot || cwd;
  const realCwd = fs.existsSync(cwd) ? fs.realpathSync(cwd) : cwd;
  const extraAllow = process.env.VITE_FS_ALLOW
    ? process.env.VITE_FS_ALLOW.split('|').map((value) => value.trim()).filter(Boolean)
    : [];
  const fsAllow = Array.from(new Set([root, cwd, realCwd, ...extraAllow])).filter(Boolean);

  return {
    root,
    server: {
    host: true,
    port: devPort,
    strictPort: true,
    fs: {
      allow: fsAllow
    },
    watch: {
      usePolling: true,
      interval: 1000
    },
    hmr: isVercelDev
      ? false
      : {
          host: hmrHost,
          port: devPort,
          protocol: 'ws'
        }
  },
  resolve: {
    preserveSymlinks: Boolean(forcedRoot),
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
  };
});
