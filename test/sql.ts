import { DatabaseSync } from "node:sqlite";
import { migrate } from "../src/schema";

/** An empty real SQLite database (Node's built-in one) behind the same exec() the Durable Object has. */
export function emptySql() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...params: (string | number | null)[]) {
      const rows = db.prepare(query).all(...params);
      return { toArray: () => rows, one: () => rows[0] };
    },
  } as unknown as SqlStorage;
}

/** A database with all of Ohm's tables, like a brand-new Ohm. */
export function testSql() {
  const sql = emptySql();
  migrate(sql);
  return sql;
}

export const count = (sql: SqlStorage, query: string) => (sql.exec(query).one() as { n: number }).n;