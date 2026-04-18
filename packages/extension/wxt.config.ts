import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  modules: ['@wxt-dev/module-svelte'],
  manifest: {
    name: 'RSI Companion',
    description: 'Improve your RSI experience on robertsspaceindustries.com.',
    author: 'Kamille92',
    permissions: ['cookies', 'alarms', 'storage'],
    host_permissions: [
      'https://robertsspaceindustries.com/*',
      'https://status.robertsspaceindustries.com/*',
      'https://rsi-companion.kamille.ovh/*',
    ],
    action: {
      default_title: 'RSI Companion',
      default_popup: 'popup.html',
    },
    icons: {
      64: 'icon/64.png',
      128: 'icon/128.png',
      256: 'icon/256.png',
    },
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  outDir: 'dist',
});
