// A tiny key-value store in SQLite (the kv table, see schema.ts). The pet, the weather, the settings,
// the brain stats and the unlocked parts each live under one key, as JSON.

export function kvGet<T>(sql: SqlStorage, key: string): T | undefined {
  const row = sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", key).toArray()[0];
  return row ? (JSON.parse(row.value) as T) : undefined;
}

export function kvSet(sql: SqlStorage, key: string, value: unknown) {
  sql.exec(
    "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    key,
    JSON.stringify(value),
  );
}
