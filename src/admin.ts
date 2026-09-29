// What you can ask for on the admin page. The page itself is public JavaScript and only the token
// is secret, so every request is checked here again, like any other input from outside.
// The checked commands are carried out with moderation.ts.
import { HOURS_RANGE, type Settings } from "./protocol";
import { tokenize, type Lang } from "./words";

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

/** The search box's text, tidied: 1 to 32 characters, lowercase like every word Ohm stores. Null if not allowed. */
export function cleanQuery(q: string | null): string | null {
  const s = (q ?? "").trim().toLowerCase();
  return s.length >= 1 && s.length <= 32 ? s : null;
}
