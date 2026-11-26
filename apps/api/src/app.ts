import { sql } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import type { Db } from './db/client.ts';
import { createDevicesRoutes } from './features/devices/devices.routes.ts';
import { createDiscoveryRoutes } from './features/discovery/discovery.routes.ts';
import { createDoctorRoutes } from './features/doctor/doctor.routes.ts';
import { createMcpRoutes } from './features/mcp/mcp.routes.ts';
import { createProviderRoutes } from './features/providers/providers.routes.ts';
import { createSettingsRoutes } from './features/settings/settings.routes.ts';
import { createSetupRoutes } from './features/setup/setup.routes.ts';
import { buildHealth, createVoiceRoutes } from './features/voice/voice.routes.ts';
import type { VoiceRuntime } from './features/voice/voice-runtime.ts';
import { AppError } from './lib/errors.ts';
import { registerWebApp } from './static.ts';

export type AppOptions = {
  db: Db;
  voice: VoiceRuntime;
  /** Enables CORS for the Vite dev server origin. Never on in production. */
  enableCors?: boolean;
  /** Logs one line per request. Off in tests to keep the output readable. */
  logRequests?: boolean;
  /** Absolute path of apps/web/dist. When set, the SPA is served too. */
  webDistDir?: string;
  /** Tests only: replaces fetch for the setup wizard's OpenAI check. */
  fetchImpl?: typeof fetch;
};

const MAX_BODY_BYTES = 100 * 1024;

/**
 * Builds the Hono app without starting a server, so tests can call
 * `app.request(...)` against an in-memory database.
 */
export function createApp({
  db,
  voice,
  enableCors = false,
  logRequests = false,
  webDistDir,
  fetchImpl,
}: AppOptions) {
  const app = new Hono();

  if (logRequests) app.use('*', logger());

  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // Radix positions popovers with inline `style` attributes.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    }),
  );

  // Dev only: the browser talks to Vite (:5173), which proxies /api, so CORS
  // is not strictly needed. It is enabled for tools that call :3000 directly.
  if (enableCors) {
    app.use('/api/*', cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] }));
  }

  app.use(
    '/api/*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () => {
        throw new AppError(413, 'PAYLOAD_TOO_LARGE', `Request body must be at most ${MAX_BODY_BYTES} bytes.`);
      },
    }),
  );

  // Always 200 while the process and database work, even when the Echo is
  // disconnected: Docker's healthcheck should not restart the app because
  // the Echo rebooted. The Echo's state is in the body.
  const health = (c: Context) => {
    // A trivial query proves the database file is open and readable.
    db.run(sql`select 1`);
    return c.json(buildHealth(voice));
  };
  app.get('/api/health', health);
  // The spec asks for GET /health; same document, outside /api.
  app.get('/health', health);

  app.route('/api', createVoiceRoutes(voice));
  app.route('/api', createDevicesRoutes(voice));
  app.route('/api', createDiscoveryRoutes(voice));
  app.route('/api', createSettingsRoutes(voice));
  app.route('/api', createProviderRoutes(voice, { fetchImpl }));
  app.route('/api', createSetupRoutes(voice, { fetchImpl }));
  app.route('/api', createMcpRoutes(voice));
  app.route('/api', createDoctorRoutes(voice));

  // Unknown API paths get a JSON 404 here, so they never fall through to the
  // SPA fallback below and come back as index.html.
  app.all('/api/*', () => {
    throw new AppError(404, 'NOT_FOUND', 'This API endpoint does not exist.');
  });

  if (webDistDir) registerWebApp(app, webDistDir);

  app.notFound((c) => c.json(new AppError(404, 'NOT_FOUND', 'Not found.').toBody(), 404));

  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(error.toBody(), error.status);
    }
    // Hono and its middleware throw HTTPException, e.g. 400 for malformed JSON.
    if (error instanceof HTTPException && error.status < 500) {
      const code = error.status === 404 ? 'NOT_FOUND' : 'VALIDATION_ERROR';
      return c.json(new AppError(error.status, code, error.message || 'Bad request.').toBody(), error.status);
    }
    // Anything else is a bug. Log the details, but never send them to clients.
    console.error(error);
    return c.json(new AppError(500, 'INTERNAL_ERROR', 'Something went wrong on the server.').toBody(), 500);
  });

  return app;
}
