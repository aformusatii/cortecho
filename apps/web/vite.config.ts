import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * URL prefix the dev server is reached under. Normally '/'.
 *
 * code-server's port proxy (https://<host>/absproxy/5173/) forwards requests
 * WITH that prefix, so every URL Vite writes into the page (/@vite/client,
 * /src/main.tsx…) must carry it too, or the browser asks code-server's own
 * root and gets a 404. code-server sets VSCODE_PROXY_URI in its terminals,
 * which is how we know we are behind it. DEV_BASE_PATH overrides both cases.
 */
function readDevBasePath(): string {
  if (process.env.DEV_BASE_PATH) return process.env.DEV_BASE_PATH;
  if (process.env.VSCODE_PROXY_URI) return '/absproxy/5173/';
  return '/';
}

/**
 * Redirects the prefix without its trailing slash (/absproxy/5173) to the
 * prefix itself. Vite only serves URLs that start with the full `base`, so
 * the shorter URL, which is what people type, would otherwise be a 404.
 */
function redirectToBasePath(basePath: string): Plugin {
  const withoutSlash = basePath.replace(/\/$/, '');
  return {
    name: 'redirect-to-base-path',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (withoutSlash === '' || req.url !== withoutSlash) return next();
        res.writeHead(302, { Location: basePath });
        res.end();
      });
    },
  };
}

export default defineConfig(({ command, isPreview }) => {
  // Only the dev server gets the prefix: production builds are served by Hono
  // at '/', even when `npm run build` happens to run inside code-server.
  const devBasePath = command === 'serve' && !isPreview ? readDevBasePath() : '/';

  return {
    base: devBasePath,
    plugins: [
      // The router plugin must run before the React plugin: it generates
      // src/routeTree.gen.ts from the files in src/routes/.
      tanstackRouter({ target: 'react', autoCodeSplitting: true }),
      react(),
      tailwindcss(),
      redirectToBasePath(devBasePath),
      VitePWA({
        // 'prompt': a new service worker waits until the user clicks "Reload"
        // in the update toast (PwaUpdateToast.tsx), instead of swapping code
        // under a user who is halfway through filling in a form.
        registerType: 'prompt',
        // We register from React (useRegisterSW), so no extra script is injected.
        injectRegister: false,
        // A service worker in dev caches aggressively and causes confusing
        // stale-code bugs. Test the PWA with `npm run build && npm start`.
        devOptions: { enabled: false },
        includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png', 'logo.svg'],
        manifest: {
          name: 'Cortecho',
          short_name: 'Cortecho',
          description:
            'The brain for a rooted Amazon Echo Dot: a DIY AI voice assistant, no Home Assistant needed.',
          display: 'standalone',
          start_url: '/',
          scope: '/',
          theme_color: '#1b2337',
          background_color: '#faf9f5',
          // Generated from public/logo.svg by `npm run icons`.
          icons: [
            { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
            { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
            { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          // Precache the app shell: HTML, JS, CSS, fonts and icons.
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
          cleanupOutdatedCaches: true,
          // Offline navigation to any client route (/users/3/edit) serves the
          // cached index.html, and the router renders the page...
          navigateFallback: 'index.html',
          // ...but never for API URLs, which must reach the server.
          navigateFallbackDenylist: [/^\/api\//],
          runtimeCaching: [
            {
              // User data is never cached: offline means "no data", never "old data".
              urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
              handler: 'NetworkOnly',
            },
          ],
        },
      }),
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      port: 5173,
      // Listen on all network interfaces (not only localhost), so the dev
      // server can be opened from other devices: http://<machine-ip>:5173.
      host: true,
      // Vite rejects requests whose Host header it does not know (protection
      // against DNS rebinding). `true` accepts any hostname or IP, which is
      // fine for a dev server on a trusted network. To be stricter, list the
      // names instead, e.g. ['my-laptop.local', 'dev.example.com'].
      allowedHosts: true,
      // In dev the API runs separately on :3000. Proxying keeps the browser on a
      // single origin, so the code calls `/api/...` the same way in dev and prod.
      proxy: {
        // The proxy runs before Vite strips `base`, so the key includes the
        // prefix, and `rewrite` removes it: Hono always serves plain /api/...
        [`${devBasePath}api`]: {
          // 127.0.0.1, not localhost: Node may resolve localhost to IPv6 ::1,
          // while the API listens on IPv4 0.0.0.0.
          target: 'http://127.0.0.1:3000',
          rewrite: (path) => path.slice(devBasePath.length - 1),
        },
      },
    },
  };
});
