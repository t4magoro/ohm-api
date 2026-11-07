// Ohm's own lines (lines/ohm.json, packed into src/lines.bin by tools/build_lines.ts): find the stored message closest to
// yours (BM25) and say his reply to it. Every number is shown in `why`: the matched message, its score, and how much of
// what you said it covers. When none fits, he says he doesn't know yet and asks to be taught.
import { hidden } from "./base";

/** The sum behind `confidence`: each shared word's weight (BM25's idf), and the weight and count of the rest of what you said. */
export type Weights = { shared: [string, number][]; rest: number; others: number };
export type Found = { words: string[]; prompt: string[]; score: number; confidence: number; weights?: Weights; own?: boolean; admit?: boolean; matched?: string[]; below?: boolean };
export type Retriever = { find(heard: string[], random: () => number, accept?: (prompt: string[]) => boolean): Found | undefined; minConfidence: number; minWords: number; only: boolean; lesson: number; bytes: number; own?(heard: string[], random: () => number): Found | undefined };

const K1 = 1.2; // BM25's usual values, not tuned
const B = 0.75;

/** The one retriever Ohm uses, or null for none. */
export let retriever: Retriever | null = null;
export const useRetriever = (r: Retriever | null) => {
  retriever = r;
};

/** The index as one file: typed arrays over a buffer, so waking up costs almost nothing and none of it is in SQLite. */
export function packRetrieval(pairs: { prompt: string[]; reply: string[] }[]) {
  const ids = new Map<string, number>();
  const id = (w: string) => {
    let i = ids.get(w);
    if (i === undefined) ids.set(w, (i = ids.size));
    return i;
  };
  const N = pairs.length;
  const postings: number[][] = [];
  const lengths = new Uint16Array(N);
  const starts = new Uint32Array(N + 1);
  const text: number[] = [];
  pairs.forEach(({ prompt, reply }, d) => {
    lengths[d] = prompt.length;
    starts[d] = text.length;
    for (const w of prompt) text.push(id(w));
    for (const w of reply) text.push(id(w));
    for (const w of new Set(prompt)) (postings[id(w)] ??= []).push(d);
  });
  starts[N] = text.length;
  const V = ids.size;
  if (V > 65535) throw new Error("too many words for 16 bits");
  const offsets = new Uint32Array(V + 1);
  for (let i = 0; i < V; i++) offsets[i + 1] = offsets[i] + (postings[i]?.length ?? 0);
  const vocab = new TextEncoder().encode([...ids.keys()].join("\n"));
  const size = 20 + 4 * (V + 1) + 4 * offsets[V] + 4 * (N + 1) + 2 * N + 2 * text.length + vocab.length;
  const buffer = new ArrayBuffer(size);
  let at = 0;
  const take = (a: Uint32Array | Uint16Array | Uint8Array) => {
    new Uint8Array(buffer, at, a.byteLength).set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
    at += a.byteLength;
  };
  take(Uint32Array.of(N, V, offsets[V], text.length, vocab.length));
  take(offsets);
  for (let i = 0; i < V; i++) take(Uint32Array.from(postings[i] ?? []));
  take(starts);
  take(lengths);
  take(Uint16Array.from(text));
  take(vocab);
  return buffer;
}

/** `lesson`: visitors' count on a word pair after the topic that makes him skip retrieval, so what they taught can be said. */
export function openRetriever(buffer: ArrayBuffer, { minConfidence = 0, minWords = 1, only = false, lesson = Infinity } = {}): Retriever {
  const [N, V, P, T, vocabBytes] = new Uint32Array(buffer, 0, 5);
  let at = 20;
  const u32 = (n: number) => ((at += 4 * n), new Uint32Array(buffer, at - 4 * n, n));
  const u16 = (n: number) => ((at += 2 * n), new Uint16Array(buffer, at - 2 * n, n));
  const offsets = u32(V + 1);
  const postings = u32(P);
  const starts = u32(N + 1);
  const lengths = u16(N);
  const text = u16(T);
  const names = new TextDecoder().decode(new Uint8Array(buffer, at, vocabBytes)).split("\n");
  const words = new Map(names.map((w, i) => [w, i]));
  let totalLength = 0;
  for (let d = 0; d < N; d++) totalLength += lengths[d];
  const average = totalLength / Math.max(N, 1);
  const idf = (df: number) => Math.log(1 + (N - df + 0.5) / (df + 0.5));
  const unknown = Math.log(1 + N); // a word no stored message has: it lowers the confidence as a very rare word would
  const scores = new Float32Array(N);
  const say = (from: number, to: number) => Array.from(text.subarray(from, to), (i) => names[i]);

  return {
    minConfidence,
    minWords,
    only,
    lesson,
    bytes: buffer.byteLength,
    find(heard, random, accept) {
      const query = [...new Set(heard)];
      if (query.length === 0) return undefined;
      const touched: number[] = [];
      let all = 0;
      for (const w of query) {
        const i = words.get(w);
        const df = i === undefined ? 0 : offsets[i + 1] - offsets[i];
        if (df === 0) {
          all += unknown;
          continue;
        }
        const weight = idf(df);
        all += weight;
        for (let j = offsets[i!]; j < offsets[i! + 1]; j++) {
          const d = postings[j];
          if (scores[d] === 0) touched.push(d);
          // Prompts are short, so a word occurs about once: term frequency 1.
          scores[d] += (weight * (K1 + 1)) / (1 + K1 * (1 - B + (B * lengths[d]) / average));
        }
      }
      let bestScore = 0;
      const best: number[] = [];
      for (const d of touched) {
        if (accept && !accept(say(starts[d], starts[d] + lengths[d]))) continue;
        const s = scores[d];
        if (s > bestScore + 1e-6) {
          bestScore = s;
          best.length = 0;
          best.push(d);
        } else if (s > bestScore - 1e-6 && !best.includes(d) && best.length < 200) best.push(d);
      }
      for (const d of touched) scores[d] = 0;
      const open = best.filter((d) => !say(starts[d] + lengths[d], starts[d + 1]).some((w) => hidden.has(w)));
      if (open.length === 0) return undefined;
      const d = open[Math.floor(random() * open.length)];
      const stored = say(starts[d], starts[d] + lengths[d]);
      const prompt = new Set(stored);
      const shared: [string, number][] = [];
      for (const w of query) {
        if (prompt.has(w)) {
          const i = words.get(w)!;
          shared.push([w, idf(offsets[i + 1] - offsets[i])]);
        }
      }
      const matched = shared.reduce((sum, [, x]) => sum + x, 0);
      const round = (x: number) => Math.round(x * 100) / 100;
      const weights = { shared: shared.map(([w, x]) => [w, round(x)] as [string, number]), rest: round(all - matched), others: query.length - shared.length };
      return { words: say(starts[d] + lengths[d], starts[d + 1]), prompt: stored, score: bestScore, confidence: matched / all, weights };
    },
  };
}

// Words that say nothing about the topic, and spellings the lexicon keeps apart. Only for matching: what he hears doesn't change.
const FILLER = new Set(["ih", "sih", "dong", "deh", "nih", "tuh", "ya", "yah", "kok", "lah", "kan", "mah", "loh", "eh", "wah", "aduh", "sumpah", "hmm", "ohm", "banget", "sekali", "hehe", "haha", "hihi", "wkwk", "wkwkwk"]);
const SPELLING = new Map([["dimana", ["di", "mana"]], ["kemana", ["ke", "mana"]], ["darimana", ["dari", "mana"]], ["disana", ["di", "sana"]], ["disini", ["di", "sini"]], ["malem", ["malam"]], ["pengen", ["ingin"]], ["pingin", ["ingin"]], ["bgt", ["banget"]], ["aja", ["saja"]], ["seneng", ["senang"]], ["kesukaan", ["favorit"]], ["kenalin", ["kenalan"]], ["gapernah", ["tidak", "pernah"]], ["laper", ["lapar"]], ["cape", ["capek"]], ["keadaan", ["cuaca"]], ["keaada", ["cuaca"]]]);
const ME = new Set(["aku", "saya", "gue", "gua"]);
const YOU = new Set(["kamu", "anda", "kau", "lu", "lo"]);
export function tidy(heard: string[]) {
  // A name says nothing about what to answer: "nama aku iqbal" is "nama aku".
  const named = heard.filter((_, i) => !(heard[i - 1] === "namaku" || (i >= 2 && heard[i - 2] === "nama" && ME.has(heard[i - 1]))));
  const out = named.flatMap((w) => {
    const short = w.replace(/(.)\1+$/, "$1"); // bangett → banget
    return SPELLING.get(w) ?? SPELLING.get(short) ?? [short];
  }).filter((w) => !FILLER.has(w));
  return out.length > 0 ? out : heard;
}

/**
 * His own lines first. A stored message only counts if it's about the same person ("kamu lapar" can't match "aku lapar" or a bare
 * "lapar") and you said more than `least` of it, and it must cover at least `least` of what you said. Otherwise `rest`, unless a
 * lesson speaks (brain.ts). `dice` gives the lines their own dice in tests.
 */
export function linesFirst(lines: Retriever, rest: Retriever, least = 0.5, dice?: (heard: string[]) => () => number): Retriever {
  return {
    ...rest,
    minWords: 1,
    bytes: rest.bytes + lines.bytes,
    own(heard, random) {
      const asked = tidy(heard);
      const said = new Set(asked);
      const me = asked.some((w) => ME.has(w));
      const you = asked.some((w) => YOU.has(w));
      const fits = (prompt: string[]) => {
        const aboutYou = prompt.some((w) => YOU.has(w));
        const aboutMe = prompt.some((w) => ME.has(w));
        if ((you && !me && (!aboutYou || aboutMe)) || (me && !you && aboutYou)) return false;
        return prompt.filter((w) => said.has(w)).length / prompt.length > least;
      };
      const found = lines.find(asked, dice ? dice(heard) : random, fits);
      if (!found) return undefined;
      const matched = found.prompt.filter((w) => said.has(w)); // his words you also said, for the think page
      // Under the bar it isn't his answer, but the think page shows it as the line that came closest.
      return found.confidence >= least ? { ...found, own: true, matched } : { ...found, below: true, matched };
    },
    find: (heard, random) => (heard.length >= rest.minWords ? rest.find(heard, random) : undefined),
  };
}

export const ADMIT = ["hmm aku belum ngerti ajarin dong", "aku belum tahu soal itu kamu bisa jelasin", "wah itu baru buat aku ceritain dong", "aku belum belajar itu ajarin aku ya", "maaf otakku masih kecil jelasin pelan pelan dong", "hmm aku belum paham maksudnya ceritain dong"].map((x) => x.split(" "));

/** When nothing matches: he says he doesn't know yet, and asks to be taught. Used in place of stored dataset replies. */
export function admitting(replies: string[][], lesson = 3): Retriever {
  return {
    minConfidence: 0,
    minWords: 1,
    only: false,
    lesson,
    bytes: 0,
    find(_heard, random) {
      const open = replies.filter((r) => !r.some((w) => hidden.has(w)));
      if (open.length === 0) return undefined;
      return { words: open[Math.floor(random() * open.length)], prompt: [], score: 0, confidence: 1, admit: true };
    },
  };
}

