// Brain v4 (research/brain_v4.ipynb): Ohm writes each reply word by word with a small trained transformer, G (gen.ts).
// Its files are read-only and loaded once per wake, like base.bin. Visitors still only write to SQLite: what they teach
// reaches G through the lesson mix (change 9), and blocked words are masked as he reads, so blocking works at once.
import { hidden, mixing } from "./base";
import { Gen, copySet, reply as write, type Meta, type Reply } from "./gen";
import { admitting, linesFirst, openRetriever, packRetrieval, tidy } from "./retrieve";
import { tokenize, type Lexicon } from "./words";

/** Tuned on the tuning seeds (research/brain_v4.ipynb, change 13): k = 8 (change 8), tau and pi by the fit judge, theta the
 *  10th percentile of held-out teacher replies' scores, kappa the largest that passes the teaching gates (change 12): how
 *  many people's worth of weight G keeps against a lesson (lessonWeight). mu = 0, so there's no fit term (change 14). */
export const SETTINGS = { k: 8, tau: 1, pi: 0.95, theta: -4.364, kappa: 3 };
export const LESSON = 3; // today's visitor rule: 3 or more people said the same word after the topic
const MAX_WORDS = 20;
const STATE_KEYS = ["battery", "mood", "weather", "daypart"] as const;

/** What G reads besides your message: his state, as stateTokens gives it, and his last line to you (stored spellings). */
export type Talk = { state: string[]; prev: string[] };
export type Model = { gen: Gen; allowed: Uint8Array; copies: Set<string>; crisis: ReturnType<typeof linesFirst>; isBlocked: (w: string) => boolean };

export let model: Model | null = null;
export const useModel = (m: Model | null) => {
  model = m;
};

/**
 * model.json holds G's shape and vocabulary (export.py) and `copies`, the training replies he must not repeat (change 8)
 * unless all his candidates are such copies (change 15).
 * The lexicon is passed in, not imported, because only wrangler can load the word lists (lexicon.ts).
 */
export function loadModel(bin: ArrayBuffer, meta: Meta & { copies: string[] }, lexicon: Lexicon, kern?: WebAssembly.Module): Model {
  const gen = new Gen(bin, meta, kern);
  for (const k of STATE_KEYS) if (!meta.itos.some((w) => w.startsWith(`<${k}:`))) throw new Error(`model.json has no ${k} tokens`);
  const allowed = new Uint8Array(meta.itos.length);
  for (const w of meta.canSay) if (!lexicon.isBlocked(w)) allowed[gen.stoi.get(w)!] = 1;
  allowed[gen.stoi.get("<end>")!] = 1;
  const prompts = [...new Set(CRISIS.p.map((x) => tidy(lexicon.normalize(tokenize(x))).join(" ")))];
  const crisis = linesFirst(openRetriever(packRetrieval(prompts.map((x) => ({ prompt: x.split(" "), reply: CRISIS.r.split(" ") })))), admitting([]));
  return { gen, allowed, copies: copySet(meta.copies), crisis, isBlocked: lexicon.isBlocked };
}

/**
 * The crisis reply stays fixed (decision 7): line group 88 of lines/ohm.json, matched the way his lines are (linesFirst),
 * before G runs. It carries a helpline number, which no word-level model can say. A test keeps this copy equal to the group.
 */
export const CRISIS = {
  p: ["aku mau bunuh diri", "bunuh diri", "aku ingin mati", "aku mau mati", "pengen mati", "mau mati saja", "aku capek hidup", "aku tidak mau hidup lagi"],
  r: "aku cuma robot tapi aku peduli sama kamu tolong cerita ke orang yang kamu percaya atau hubungi 119 ekstensi 8 atau healing119.id",
};

/** G's input, as in training (train.py, examples): <s> state <prev> his last line to you <vis> your message <ohm>. */
function context(gen: Gen, { state, prev }: Talk, heard: string[]) {
  const s = gen.stoi, unk = s.get("<unk>")!;
  const ids = (ws: string[]) => ws.slice(0, MAX_WORDS).map((w) => s.get(w) ?? unk);
  const states = STATE_KEYS.map((k, i) => {
    const id = s.get(`<${k}:${state[i]}>`);
    if (id === undefined) throw new Error(`no state token <${k}:${state[i]}>`);
    return id;
  });
  return [s.get("<s>")!, ...states, s.get("<prev>")!, ...ids(prev), s.get("<vis>")!, ...ids(heard), s.get("<ohm>")!];
}

/**
 * How much a lesson weighs (change 12, the owner's choice): it grows with how many people taught it, n (the lesson's count,
 * with the visitor rule), and stops growing at mixing.cap = 5 people, as the chain's own mixing does, so two friends taking
 * turns can't outweigh five people. λ = m / (m + κ) with m = min(n, cap): G counts as κ people.
 */
export const lessonWeight = (count: number) => {
  const m = Math.min(count, mixing.cap);
  return m / (m + SETTINGS.kappa);
};

/**
 * G's reply to `heard`, or words: null when the guard fails. Blocked words are masked in G and dropped from the lesson.
 * `lesson`: the topic and its count when today's lesson rule fires (brain.ts, taught), and `after(p2, p1)`, what visitors said
 * next. Each pattern's count also stops at mixing.cap in p_L. `lambda` is the lesson's weight, 0 without one.
 */
export function speak(m: Model, talk: Talk, heard: string[], lesson: { word: string; count: number } | undefined, after: (p2: string, p1: string) => [string, number][], random: () => number): Reply & { lambda: number; read: string[] } {
  const allowed = m.allowed.slice();
  for (const w of hidden) {
    const i = m.gen.stoi.get(w);
    if (i !== undefined) allowed[i] = 0;
  }
  const ok = (w: string) => !m.isBlocked(w) && !hidden.has(w);
  const taught = lesson && ok(lesson.word)
    ? { topic: lesson.word, lambda: lessonWeight(lesson.count), after: (p2: string, p1: string) => after(p2, p1).filter(([x]) => ok(x)).map(([x, n]): [string, number] => [x, Math.min(n, mixing.cap)]) }
    : undefined;
  const ids = context(m.gen, talk, heard), vis = ids.indexOf(m.gen.stoi.get("<vis>")!); // the message: after <vis>, before <ohm>
  return { ...write(m.gen, ids, allowed, m.copies, SETTINGS, random, taught, [vis + 1, ids.length - 1]), lambda: taught?.lambda ?? 0, read: heard.slice(0, MAX_WORDS) };
}
