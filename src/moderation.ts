// Moderation in the database: approving and blocking words, bans, reports, and the admin page's lists.
// Admin requests are checked in admin.ts first, so these functions trust their arguments.
import type { AdminOverview, AdminSearch, Settings } from "./protocol";
import type { Lang } from "./words";

/** Ohm learns a word from the queue, credited to "admin". */
export function approveWord(sql: SqlStorage, word: string, lang: Lang, now: number) {
  sql.exec(
    "INSERT INTO words (word, langs, by_id, by_name, at, uses) VALUES (?, ?, 'admin', 'admin', ?, 0) ON CONFLICT (word) DO NOTHING",
    word,
    lang,
    now,
  );
  sql.exec("DELETE FROM pending WHERE word = ?", word);
}

/** Ohm forgets a word everywhere and can never learn it again, until you unblock it. */
export function blockWord(sql: SqlStorage, word: string) {
  sql.exec("INSERT INTO blocked (word) VALUES (?) ON CONFLICT (word) DO NOTHING", word);
  sql.exec("DELETE FROM pending WHERE word = ?", word);
  sql.exec("DELETE FROM words WHERE word = ?", word);
  sql.exec("DELETE FROM grams WHERE p2 = ? OR p1 = ? OR next = ?", word, word, word);
  sql.exec("DELETE FROM pairs WHERE p1 = ? OR next = ?", word, word);
  sql.exec("DELETE FROM word_ctx WHERE word = ?", word);
  sql.exec("DELETE FROM links WHERE word = ?", word);
}

export function unblockWord(sql: SqlStorage, word: string) {
  sql.exec("DELETE FROM blocked WHERE word = ?", word);
}

/**
 * Ohm forgets everything he learned: words, the queue, patterns, situations, skills. What stays: the
 * blocklist, bans, reports, his past lines, the feed, the Vitals history and unlocked milestones.
 */
export function resetBrain(sql: SqlStorage) {
  for (const table of ["words", "pending", "grams", "pairs", "word_ctx", "links"]) sql.exec(`DELETE FROM ${table}`);
  sql.exec("DELETE FROM kv WHERE key IN ('brain', 'mind')");
}

/** Bans are kept by salted IP hash (see guard.ts), never by real IP address. */
export const isBanned = (sql: SqlStorage, ipHash: string) =>
  sql.exec("SELECT 1 FROM bans WHERE ip_hash = ?", ipHash).toArray().length > 0;

export function ban(sql: SqlStorage, ipHash: string, now: number) {
  sql.exec("INSERT INTO bans (ip_hash, at) VALUES (?, ?) ON CONFLICT (ip_hash) DO NOTHING", ipHash, now);
}

export function unban(sql: SqlStorage, ipHash: string) {
  sql.exec("DELETE FROM bans WHERE ip_hash = ?", ipHash);
}

/** A visitor flags one of Ohm's lines for your admin page. False if the line doesn't exist (any more). */
export function fileReport(sql: SqlStorage, lineId: number, byId: string, now: number) {
  const line = sql.exec<{ text: string }>("SELECT text FROM lines WHERE id = ?", lineId).toArray()[0];
  if (!line) return false;
  sql.exec("INSERT INTO reports (at, line_id, text, by_id) VALUES (?, ?, ?, ?)", now, lineId, line.text, byId);
  return true;
}

export function dismissReport(sql: SqlStorage, id: number) {
  sql.exec("DELETE FROM reports WHERE id = ?", id);
}

/** Deletes one of Ohm's lines, and the reports about it. */
export function unsay(sql: SqlStorage, lineId: number) {
  sql.exec("DELETE FROM lines WHERE id = ?", lineId);
  sql.exec("DELETE FROM reports WHERE line_id = ?", lineId);
}

/** Everything the admin page lists. */
export function overview(sql: SqlStorage, settings: Settings): AdminOverview {
  type O = AdminOverview;
  return {
    settings,
    pending: sql.exec<O["pending"][number]>("SELECT word, seen FROM pending ORDER BY seen DESC, first_seen LIMIT 100").toArray(),
    reports: sql
      .exec<O["reports"][number]>(
        `SELECT r.id, r.at, r.line_id AS lineId, r.text, l.to_name AS "to", l.ip_hash AS ipHash
         FROM reports r LEFT JOIN lines l ON l.id = r.line_id ORDER BY r.id DESC LIMIT 100`,
      )
      .toArray(),
    words: sql
      .exec<O["words"][number]>(`SELECT word, by_name AS "by", ip_hash AS ipHash, at FROM words ORDER BY at DESC LIMIT 50`)
      .toArray(),
    blocked: sql.exec<O["blocked"][number]>("SELECT word FROM blocked ORDER BY word").toArray(),
    bans: sql.exec<O["bans"][number]>("SELECT ip_hash AS ipHash, at FROM bans ORDER BY at DESC").toArray(),
  };
}

/** Words that contain `q`, in every word list, so old words can be found without scrolling. */
export function search(sql: SqlStorage, q: string): AdminSearch {
  type S = AdminSearch;
  // In LIKE, % and _ are wildcards. Put ! in front of them (and of ! itself) so they match themselves.
  const like = `%${q.replace(/[!%_]/g, "!$&")}%`;
  // ponytail: LIKE '%q%' reads the whole table; fine for a few thousand words and a rare admin search.
  return {
    q,
    words: sql
      .exec<S["words"][number]>(
        `SELECT word, by_name AS "by", ip_hash AS ipHash, at FROM words WHERE word LIKE ? ESCAPE '!' ORDER BY word LIMIT 50`,
        like,
      )
      .toArray(),
    pending: sql
      .exec<S["pending"][number]>("SELECT word, seen FROM pending WHERE word LIKE ? ESCAPE '!' ORDER BY word LIMIT 50", like)
      .toArray(),
    blocked: sql
      .exec<S["blocked"][number]>("SELECT word FROM blocked WHERE word LIKE ? ESCAPE '!' ORDER BY word LIMIT 50", like)
      .toArray(),
  };
}
