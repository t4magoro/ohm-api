// Every table Ohm uses, and every change to them over time. Each step runs once, in order,
// so the live database (which already has older tables) and a brand-new one end up the same.
// Never edit a step that already ran on the live Ohm: add a new step instead.
const STEPS: string[][] = [
  // 1: Phases 1–3a
  [
    "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at INTEGER, type TEXT, who_id TEXT, who_name TEXT)",
    "CREATE TABLE IF NOT EXISTS lines (id INTEGER PRIMARY KEY, at INTEGER, text TEXT, to_name TEXT)",
    "CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY, at INTEGER, line_id INTEGER, text TEXT, by_id TEXT)",
    "CREATE TABLE IF NOT EXISTS words (word TEXT PRIMARY KEY, langs TEXT, by_id TEXT, by_name TEXT, at INTEGER, uses INTEGER DEFAULT 0, said INTEGER DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS grams (p2 TEXT, p1 TEXT, next TEXT, count INTEGER, PRIMARY KEY (p2, p1, next))",
    "CREATE INDEX IF NOT EXISTS grams_p1 ON grams (p1)",
    "CREATE TABLE IF NOT EXISTS pending (word TEXT PRIMARY KEY, seen INTEGER, first_seen INTEGER)",
    "CREATE TABLE IF NOT EXISTS blocked (word TEXT PRIMARY KEY)",
  ],
  // 2 (Phase 3a): the words in "taught" feed lines
  ["ALTER TABLE events ADD COLUMN detail TEXT"],
  // 3 (Phase 3b): who taught a word or made Ohm say a line, as a salted IP hash, so you can ban them
  [
    "ALTER TABLE words ADD COLUMN ip_hash TEXT",
    "ALTER TABLE lines ADD COLUMN ip_hash TEXT",
    "CREATE TABLE IF NOT EXISTS bans (ip_hash TEXT PRIMARY KEY, at INTEGER)",
  ],
];

export function migrate(sql: SqlStorage) {
  sql.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)");
  const row = sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'schema'").toArray()[0];
  const done = row ? Number(row.value) : 0;
  STEPS.slice(done).forEach((step, i) => {
    for (const statement of step) sql.exec(statement);
    sql.exec(
      "INSERT INTO kv (key, value) VALUES ('schema', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      String(done + i + 1),
    );
  });
}