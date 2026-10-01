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
  // 4 (Phase 4): one row per hour for the Vitals charts. The indexes let the Vitals and
  // "while you were away" queries read only the rows they need instead of whole tables
  // (the free plan counts every row read). Each index costs one extra row write per insert.
  [
    "CREATE TABLE IF NOT EXISTS snapshots (at INTEGER PRIMARY KEY, charge REAL, mood REAL, vocab INTEGER, online INTEGER)",
    "CREATE INDEX IF NOT EXISTS events_type_at ON events (type, at)",
    "CREATE INDEX IF NOT EXISTS lines_at ON lines (at)",
    "CREATE INDEX IF NOT EXISTS words_at ON words (at)",
    "CREATE INDEX IF NOT EXISTS words_by ON words (by_id)",
  ],

  // 5 (brain v2): the visitor rule (seen, seen_by, last_by), word + situation counts and links, ratings,
  // and the skills in the hourly snapshot. The (p1, next) index serves both the one-word back-off and the
  // "was this pair seen?" test, so it replaces the p1-only one.
  [
    "ALTER TABLE words ADD COLUMN seen INTEGER DEFAULT 0",
    "ALTER TABLE words ADD COLUMN seen_by TEXT",
    "ALTER TABLE grams ADD COLUMN last_by TEXT",
    "DROP INDEX IF EXISTS grams_p1",
    "CREATE INDEX IF NOT EXISTS grams_p1_next ON grams (p1, next)",
    "CREATE TABLE IF NOT EXISTS word_ctx (word TEXT, situation TEXT, n INTEGER, PRIMARY KEY (word, situation)) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS links (word TEXT PRIMARY KEY, situation TEXT, g2 REAL, lift REAL) WITHOUT ROWID",
    "CREATE INDEX IF NOT EXISTS links_situation ON links (situation)",
    "ALTER TABLE lines ADD COLUMN rated INTEGER",
    "ALTER TABLE snapshots ADD COLUMN skill_words REAL",
    "ALTER TABLE snapshots ADD COLUMN skill_sentences REAL",
    "ALTER TABLE snapshots ADD COLUMN skill_context REAL",
    "ALTER TABLE snapshots ADD COLUMN skill_expression REAL",
  ],
  // 6: a link now needs 2+ sightings in its situation (grounding.ts). Drop the links made before that rule.
  [
    `DELETE FROM links WHERE NOT EXISTS (
       SELECT 1 FROM word_ctx c WHERE c.word = links.word AND c.situation = links.situation AND c.n >= 2)`,
  ],
  // 7: the one-word back-off gets its own counts, with the visitor rule (brain.ts, nextWord). The old
  // patterns can't be split by visitor, so pairs start empty and fill up as people talk. Nothing reads
  // grams by p1 any more, so that index goes: one row write less for every new triple.
  [
    "CREATE TABLE IF NOT EXISTS pairs (p1 TEXT, next TEXT, count INTEGER, last_by TEXT, PRIMARY KEY (p1, next)) WITHOUT ROWID",
    "DROP INDEX IF EXISTS grams_p1_next",
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