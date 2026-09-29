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
    expect(old.exec("SELECT value FROM kv WHERE key = 'schema'").one()).toEqual({ value: "4" });
  });

  it("runs each step once, so running it again changes nothing", () => {
    const sql = testSql(); // testSql() already migrated once
    migrate(sql);
    expect(sql.exec("SELECT value FROM kv WHERE key = 'schema'").one()).toEqual({ value: "4" });
  });
});
