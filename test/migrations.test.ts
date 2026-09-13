import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { migrateConversations } from '../src/migrations';
it('upgrades legacy tasks without losing history or sharing a conversation across devices/projects', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY,deviceId TEXT,sessionId TEXT,executor TEXT,input TEXT,cwd TEXT,createdAt INTEGER,updatedAt INTEGER);
    CREATE TABLE sessions(id TEXT PRIMARY KEY,deviceId TEXT,title TEXT,cwd TEXT,executor TEXT,createdAt INTEGER,updatedAt INTEGER,archived INTEGER DEFAULT 0);
    INSERT INTO tasks VALUES ('a','one','legacy','agent','first','.','1','1'),('b','two','legacy','agent','other device','.','2','2'),('c','one','legacy','shell','other executor','.','3','3'),('d','one','legacy','agent','continued','.','4','4');`);
  const sql = {
    exec(query: string, ...params: (string | number | null)[]) {
      const statement = db.prepare(query);
      return {
        toArray: () => statement.all(...params) as Record<string, unknown>[],
      };
    },
  };
  // Platform exec runs eagerly, not when toArray is read.
  const eager = {
    exec(query: string, ...params: (string | number | null)[]) {
      const rows = sql.exec(query, ...params).toArray();
      return { toArray: () => rows };
    },
  };
  try {
    migrateConversations(eager);
    const rows = eager.exec('SELECT * FROM tasks ORDER BY id').toArray();
    expect(rows).toHaveLength(4);
    expect(rows[0].sessionId).toBe('legacy');
    expect(rows[3].sessionId).toBe('legacy');
    expect(new Set(rows.map((r) => r.sessionId)).size).toBe(3);
    expect(eager.exec('SELECT * FROM sessions').toArray()).toHaveLength(3);
    expect(rows.every((r) => r.attachmentIds === '[]')).toBe(true);
    migrateConversations(eager);
    expect(eager.exec('SELECT * FROM tasks ORDER BY id').toArray()).toEqual(
      rows,
    );
  } finally {
    db.close();
  }
});
