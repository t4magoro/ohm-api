// What you can do on the admin page. The page itself is public JavaScript and only the token
// is secret, so every request is checked here again, like any other input from outside.
import { tokenize } from "./brain";
import { HOURS_RANGE, type AdminOverview, type AdminSearch, type Settings } from "./protocol";
import type { Lang } from "./words";

export type AdminCommand =
  | { do: "approve"; word: string; lang: Lang }
  | { do: "block" | "unblock"; word: string }
  | { do: "ban" | "unban"; ipHash: string }
  | { do: "dismiss" | "unsay"; id: number }
  | { do: "settings"; settings: Settings };

const isWord = (w: unknown): w is string => typeof w === "string" && tokenize(w)[0] === w;
const isHours = (h: unknown): h is number =>
  typeof h === "number" && Number.isFinite(h) && h >= HOURS_RANGE[0] && h <= HOURS_RANGE[1];
const isId = (id: unknown): id is number => Number.isSafeInteger(id) && (id as number) > 0;

export function parseAdminCommand(action: string, body: unknown): AdminCommand | null {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  switch (action) {
    case "approve":
      return isWord(b.word) && (b.lang === "id" || b.lang === "en") ? { do: action, word: b.word, lang: b.lang } : null;
    case "block":
    case "unblock":
      return isWord(b.word) ? { do: action, word: b.word } : null;
    case "ban":
    case "unban":
      return typeof b.ipHash === "string" && /^[0-9a-f]{16}$/.test(b.ipHash) ? { do: action, ipHash: b.ipHash } : null;
    case "dismiss":
    case "unsay":
      return isId(b.id) ? { do: action, id: b.id } : null;
    case "settings":
      return isHours(b.chargeHours) && isHours(b.moodHours)
        ? { do: action, settings: { chargeHours: b.chargeHours, moodHours: b.moodHours } }
        : null;
    default:
      return null;
  }
}

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
}

export function unblockWord(sql: SqlStorage, word: string) {
  sql.exec("DELETE FROM blocked WHERE word = ?", word);
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

/** The search box's text, tidied: 1 to 32 characters, lowercase like every word Ohm stores. Null if not allowed. */
export function cleanQuery(q: string | null): string | null {
  const s = (q ?? "").trim().toLowerCase();
  return s.length >= 1 && s.length <= 32 ? s : null;
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