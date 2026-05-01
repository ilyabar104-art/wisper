import Database from 'better-sqlite3';
import { dbPath } from './paths.js';

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  db = new Database(dbPath());
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      text TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      model TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(
      text, content='history', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS history_ai AFTER INSERT ON history BEGIN
      INSERT INTO history_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS history_ad AFTER DELETE ON history BEGIN
      INSERT INTO history_fts(history_fts, rowid, text) VALUES('delete', old.id, old.text);
    END;
  `);
  return db;
}

export interface HistoryEntry {
  id: number;
  ts: number;
  text: string;
  duration_ms: number;
  model: string;
}

export function addEntry(entry: Omit<HistoryEntry, 'id'>): number {
  const stmt = getDb().prepare(
    'INSERT INTO history (ts, text, duration_ms, model) VALUES (?, ?, ?, ?)'
  );
  const info = stmt.run(entry.ts, entry.text, entry.duration_ms, entry.model);
  return Number(info.lastInsertRowid);
}

export function listEntries(query?: string, limit = 200): HistoryEntry[] {
  const d = getDb();
  if (query && query.trim()) {
    const q = query.trim().replace(/"/g, '""');
    return d
      .prepare(
        `SELECT h.* FROM history h
         JOIN history_fts ON history_fts.rowid = h.id
         WHERE history_fts MATCH ?
         ORDER BY h.ts DESC LIMIT ?`
      )
      .all(`"${q}"*`, limit) as HistoryEntry[];
  }
  return d
    .prepare('SELECT * FROM history ORDER BY ts DESC LIMIT ?')
    .all(limit) as HistoryEntry[];
}

export function deleteEntry(id: number): void {
  getDb().prepare('DELETE FROM history WHERE id = ?').run(id);
}
