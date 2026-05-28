import { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

let db: Database | null = null;

export function cacheDir(): string {
  const dir = join(homedir(), '.sui-net');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getDb(): Database {
  if (db) return db;
  const path = join(cacheDir(), 'cache.sqlite');
  db = new Database(path, { create: true });
  db.run('PRAGMA journal_mode = WAL;');
  db.run('PRAGMA busy_timeout = 5000;');
  db.run(`
    CREATE TABLE IF NOT EXISTS cache (
      network    TEXT    NOT NULL,
      kind       TEXT    NOT NULL,
      key        TEXT    NOT NULL,
      value      TEXT    NOT NULL,
      fetched_at INTEGER NOT NULL,
      immutable  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (network, kind, key)
    );
  `);
  return db;
}
