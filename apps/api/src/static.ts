import { existsSync } from 'node:fs';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';

/**
 * Production only: serve the built SPA (apps/web/dist) from the same port as
 * the API, so there is one process, one origin and no CORS.
 */
export function registerWebApp(app: Hono, distDir: string): void {
  if (!existsSync(path.join(distDir, 'index.html'))) {
    console.warn(`[static] ${distDir}/index.html not found. Run "npm run build" first.`);
  }

  // 1. Real files (JS, CSS, icons, manifest, service worker).
  app.use(
    '*',
    serveStatic({
      root: distDir,
      onFound: (filePath, c) => {
        // Vite puts a content hash in every file name under /assets, so those
        // can be cached forever. Everything else (index.html, sw.js, the
        // manifest) must be revalidated, or users would never get updates.
        const isHashedAsset = filePath.includes(`${path.sep}assets${path.sep}`);
        c.header('Cache-Control', isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    }),
  );

  // 2. SPA fallback: any other GET (e.g. /users/12/edit after a reload) gets
  //    index.html and the client-side router takes over. /api/* never reaches
  //    this point because app.ts answers unknown API paths with a JSON 404.
  app.get(
    '*',
    serveStatic({
      root: distDir,
      path: 'index.html',
      onFound: (_filePath, c) => {
        c.header('Cache-Control', 'no-cache');
      },
    }),
  );
}
