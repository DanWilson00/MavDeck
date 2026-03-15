import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    solidPlugin(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      devOptions: {
        enabled: true,
        type: 'module',
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,json,svg,png}'],
        navigateFallback: 'index.html',
      },
      manifest: {
        name: 'MavDeck',
        short_name: 'MavDeck',
        description: 'Real-time MAVLink telemetry visualization',
        theme_color: '#111217',
        background_color: '#111217',
        display: 'standalone',
        icons: [
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
        ],
      },
    }),
  ],
  base: process.env.GITHUB_ACTIONS ? '/MavDeck/' : '/',
  test: {
    environment: 'happy-dom',
  },
});
