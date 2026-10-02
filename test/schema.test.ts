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
    expect(old.exec("SELECT value FROM kv WHERE key = 'schema'").one()).toEqual({ value: "11" });
  });

  it("runs each step once, so running it again changes nothing", () => {
    const sql = testSql(); // testSql() already migrated once
    migrate(sql);
    expect(sql.exec("SELECT value FROM kv WHERE key = 'schema'").one()).toEqual({ value: "11" });
  });

  it("step 6 drops the links that rest on one sighting", () => {
    const sql = emptySql();
    migrate(sql, 5); // like the live Ohm, which stopped at step 5
    sql.exec("INSERT INTO word_ctx (word, situation, n) VALUES ('hujan', 'rain', 2), ('rahasia', 'malam', 1)");
    sql.exec("INSERT INTO links (word, situation, g2, lift) VALUES ('hujan', 'rain', 15, 16), ('rahasia', 'malam', 11, 30)");
    migrate(sql);
    expect(sql.exec("SELECT word FROM links").toArray()).toEqual([{ word: "hujan" }]);
  });

  it("step 7 gives the one-word back-off its own table and drops the index nothing reads", () => {
    const sql = emptySql();
    migrate(sql, 6); // like the live Ohm, which stopped at step 6
    migrate(sql);
    expect(sql.exec("SELECT COUNT(*) AS n FROM pairs").one()).toEqual({ n: 0 });
    expect(sql.exec("SELECT name FROM sqlite_master WHERE name = 'grams_p1_next'").toArray()).toEqual([]);
  });

  it("step 11 takes the drilled words' sightings out of every count, as if they were never seen", () => {
    const sql = emptySql();
    migrate(sql, 10); // like the live Ohm, which stopped at step 10
    sql.exec("INSERT INTO words (word, langs, seen, seen_by) VALUES ('kabar', 'id', 3, 'rina'), ('hujan', 'id', 2, 'budi')");
    sql.exec("INSERT INTO word_ctx (word, situation, n) VALUES ('kabar', 'hot', 3), ('kabar', 'siang', 2), ('hujan', 'rain', 2)");
    sql.exec("INSERT INTO links (word, situation, g2, lift) VALUES ('kabar', 'hot', 12, 3.1), ('hujan', 'rain', 15, 6)");
    const mind = { skills: { words: 0.5, sentences: 0.8 }, sightings: 5, seenIn: { hot: 3, siang: 4, rain: 2 } };
    sql.exec("INSERT INTO kv (key, value) VALUES ('mind', ?)", JSON.stringify(mind));
    migrate(sql);
    expect(JSON.parse(sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'mind'").one().value)).toEqual({
      skills: { words: 0.5 }, // guessing replaces sentences
      sightings: 2,
      seenIn: { hot: 0, siang: 2, rain: 2 },
    });
    expect(sql.exec("SELECT word, seen, seen_by FROM words ORDER BY word").toArray()).toEqual([
      { word: "hujan", seen: 2, seen_by: "budi" },
      { word: "kabar", seen: 0, seen_by: null },
    ]);
    expect(sql.exec("SELECT DISTINCT word FROM word_ctx").toArray()).toEqual([{ word: "hujan" }]);
    expect(sql.exec("SELECT word FROM links").toArray()).toEqual([{ word: "hujan" }]);
  });

  it("step 8 rebuilds the pairs from the triples, never counting more visitors than typed them", () => {
    const sql = emptySql();
    migrate(sql, 7); // like the live Ohm, which stopped at step 7
    const gram = (p2: string, p1: string, next: string, n: number, by: string) =>
      sql.exec("INSERT INTO grams (p2, p1, next, count, last_by) VALUES (?, ?, ?, ?, ?)", p2, p1, next, n, by);
    gram("<s>", "<s>", "aku", 3, "citra"); // a sentence start: never a pair
    gram("<s>", "aku", "suka", 3, "citra"); // aku suka: 3 visitors
    gram("aku", "suka", "kopi", 2, "budi");
    gram("aku", "kopi", "enak", 1, "rina"); // kopi enak: Rina, after two different words…
    gram("kamu", "kopi", "enak", 1, "rina"); // …is still one visitor
    gram("dia", "kopi", "pahit", 1, "budi"); // kopi pahit: Budi and Dewi, but each triple says 1
    gram("kita", "kopi", "pahit", 1, "dewi");
    sql.exec("INSERT INTO pairs (p1, next, count, last_by) VALUES ('suka', 'kopi', 1, 'eko')"); // learned after step 7
    migrate(sql);
    expect(sql.exec("SELECT p1, next, count FROM pairs ORDER BY p1, next").toArray()).toEqual([
      { p1: "aku", next: "suka", count: 3 },
      { p1: "kopi", next: "enak", count: 1 },
      { p1: "kopi", next: "pahit", count: 1 }, // a lower bound: 2 visitors really typed it
      { p1: "suka", next: "kopi", count: 2 },
    ]);
    expect(sql.exec("SELECT last_by FROM pairs WHERE p1 = 'suka'").one()).toEqual({ last_by: "eko" }); // the newest stays
  });
});