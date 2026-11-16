import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.ts';

export type Db = BetterSQLite3Database<typeof schema>;

export type DatabaseConnection = {
  db: Db;
  /** The raw better-sqlite3 handle, needed only to close the file on shutdown. */
  sqlite: Database.Database;
};

/**
 * Opens (or creates) the SQLite database.
 * Pass ':memory:' for a throw-away database in tests.
 */
export function openDatabase(filePath: string): DatabaseConnection {
  const inMemory = filePath === ':memory:';
  if (!inMemory) {
    mkdirSync(path.dirname(filePath), { recursive: true });
  }

  const sqlite = new Database(filePath);
  // WAL lets readers and the single writer work at the same time and is the
  // recommended mode for server use. It does not apply to in-memory databases.
  if (!inMemory) {
    sqlite.pragma('journal_mode = WAL');
  }
  // SQLite ships with foreign keys OFF for backwards compatibility.
  sqlite.pragma('foreign_keys = ON');
  // Wait up to 5s instead of failing immediately if the file is locked
  // (e.g. while `npm run db:seed` runs next to the dev server).
  sqlite.pragma('busy_timeout = 5000');

  const db = drizzle({ client: sqlite, schema });
  return { db, sqlite };
}
