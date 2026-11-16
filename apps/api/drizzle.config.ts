import { defineConfig } from 'drizzle-kit';

// Used by `npm run db:generate` (writes SQL into ./drizzle, which is committed)
// and `npm run db:studio`. The app itself applies migrations with
// src/db/migrate.ts, not with drizzle-kit.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_PATH ?? '../../data/app.db',
  },
});
