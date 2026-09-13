interface Database {
  exec(
    query: string,
    ...params: (string | number | null)[]
  ): { toArray(): Record<string, unknown>[] };
}
// Called inside the DO storage transaction. One marker prevents rescanning history
// on every hibernation wake and ensures old mixed-device sessions stay isolated.
export function migrateConversations(sql: Database) {
  sql.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)',
  );
  if (
    sql.exec('SELECT version FROM schema_migrations WHERE version=2').toArray()
      .length
  )
    return;
  const columns = sql.exec('PRAGMA table_info(tasks)').toArray();
  if (!columns.some((c) => c.name === 'attachmentIds'))
    sql.exec(
      "ALTER TABLE tasks ADD COLUMN attachmentIds TEXT NOT NULL DEFAULT '[]'",
    );
  const groups = sql
    .exec(
      'SELECT sessionId,deviceId,cwd,executor FROM tasks GROUP BY sessionId,deviceId,cwd,executor ORDER BY MIN(createdAt)',
    )
    .toArray();
  const seen = new Set<string>();
  for (const row of groups) {
    const id = String(row.sessionId);
    if (seen.has(id))
      sql.exec(
        'UPDATE tasks SET sessionId=? WHERE sessionId=? AND deviceId=? AND cwd=? AND executor=?',
        crypto.randomUUID(),
        id,
        String(row.deviceId),
        String(row.cwd),
        String(row.executor),
      );
    else seen.add(id);
  }
  sql.exec(`INSERT OR IGNORE INTO sessions(id,deviceId,title,cwd,executor,createdAt,updatedAt)
    SELECT sessionId,deviceId,substr(input,1,80),cwd,executor,MIN(createdAt),MAX(updatedAt) FROM tasks GROUP BY sessionId`);
  sql.exec('INSERT INTO schema_migrations VALUES (2)');
}
