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
      manifest: {
        name: 'MavDeck',
        short_name: 'MavDeck',
        description: 'Real-time MAVLink telemetry visualization',
        theme_color: '#111827',
        background_color: '#111827',
        display: 'standalone',
        icons: [],
      },
    }),
  ],
  base: process.env.GITHUB_ACTIONS ? '/MavDeck/' : '/',
  test: {
    environment: 'happy-dom',
  },
});
