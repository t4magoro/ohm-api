import { describe, expect, it } from "vitest";
import { migrate } from "../src/schema";
import { emptySql, testSql } from "./sql";

describe("migrate", () => {
  it("upgrades the live Phase 2 database (old tables, no schema number) without losing data", () => {
    const old = emptySql();
    old.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)");
    old.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, at INTEGER, type TEXT, who_id TEXT, who_name TEXT)");
    old.exec("INSERT INTO events (at, type, who_id, who_name) VALUES (1, 'charge', 'x', 'IQBAL')");
    migrate(old);
    expect(old.exec("SELECT who_name, detail FROM events").one()).toEqual({ who_name: "IQBAL", detail: null });
    expect(old.exec("SELECT value FROM kv WHERE key = 'schema'").one()).toEqual({ value: "7" });
  });

  it("runs each step once, so running it again changes nothing", () => {
    const sql = testSql(); // testSql() already migrated once
    migrate(sql);
    expect(sql.exec("SELECT value FROM kv WHERE key = 'schema'").one()).toEqual({ value: "7" });
  });

  it("step 6 drops the links that rest on one sighting", () => {
    const sql = testSql();
    sql.exec("INSERT INTO word_ctx (word, situation, n) VALUES ('hujan', 'rain', 2), ('rahasia', 'malam', 1)");
    sql.exec("INSERT INTO links (word, situation, g2, lift) VALUES ('hujan', 'rain', 15, 16), ('rahasia', 'malam', 11, 30)");
    sql.exec("UPDATE kv SET value = '5' WHERE key = 'schema'"); // like the live Ohm, which stopped at step 5
    migrate(sql);
    expect(sql.exec("SELECT word FROM links").toArray()).toEqual([{ word: "hujan" }]);
  });

  it("step 7 gives the one-word back-off its own table and drops the index nothing reads", () => {
    const sql = testSql();
    sql.exec("DROP TABLE pairs");
    sql.exec("CREATE INDEX grams_p1_next ON grams (p1, next)");
    sql.exec("UPDATE kv SET value = '6' WHERE key = 'schema'"); // like the live Ohm, which stopped at step 6
    migrate(sql);
    expect(sql.exec("SELECT COUNT(*) AS n FROM pairs").one()).toEqual({ n: 0 });
    expect(sql.exec("SELECT name FROM sqlite_master WHERE name = 'grams_p1_next'").toArray()).toEqual([]);
  });
});