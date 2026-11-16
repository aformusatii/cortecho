import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { env } from '../env.ts';
import { type Db, openDatabase } from './client.ts';

// Absolute path, so migrations are found no matter which directory the
// process was started from (repo root, apps/api, or the Docker WORKDIR).
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Applies all pending SQL migrations from apps/api/drizzle. Safe to run repeatedly. */
export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

// `npm run db:migrate` runs this file directly.
if (import.meta.main) {
  const { db, sqlite } = openDatabase(env.DATABASE_PATH);
  runMigrations(db);
  sqlite.close();
  console.log(`Migrations applied to ${env.DATABASE_PATH}`);
}
