// The base: what Ohm knows from a dataset, counted offline by tools/build_base.ts and read-only here. Visitors only ever
// write to the SQLite tables, and the two layers mix when he reads. Typed arrays over one file, so waking him up costs
// a word list, not a parse of millions of rows.
export type Row = { next: string; count: number };

export type Base = {
  vocab: number;
  tokens: number;
  ends: number;
  bytes: number;
  has(word: string): boolean;
  uses(word: string): number;
  /** Words after (p2, p1), like grams. */
  next(p2: string, p1: string): Row[];
  /** Words after p1, like pairs. */
  word(p1: string): Row[];
  /** Words before (a, b): the mirror of next, for growing left. */
  prev(a: string, b: string): Row[];
  /** Words before a: the mirror of word. */
  before(a: string): Row[];
  pair(p1: string, next: string): number;
  /** A word, not a sentence edge, where the die r (0–1) lands: common words more often, as people use them. */
  random(r: number): string;
  list(): string[];
};

export const FIRST_WORD = 2; // ids 0 and 1 are <s> and </s>

/** Reads a file written by tools/build_base.ts. Makes views over the bytes, so its cost is the word table alone. */
export function loadBase(buffer: ArrayBuffer): Base {
  const headerLength = new Uint32Array(buffer, 0, 1)[0];
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, headerLength))) as {
    words: string[];
    tokens: number;
    ends: number;
    arrays: Record<string, [number, number, 16 | 32]>;
  };
  const view = (name: string) => {
    const [offset, length, bits] = header.arrays[name];
    return bits === 16 ? new Uint16Array(buffer, offset, length) : new Uint32Array(buffer, offset, length);
  };
  const [uses, fs, fn, fc, bs, bp, bc] = ["uses", "fs", "fn", "fc", "bs", "bp", "bc"].map(view);
  const [tcs, tcp, tco, tn, tc, rcs, rcn, rco, rp, rc] = ["tcs", "tcp", "tco", "tn", "tc", "rcs", "rcn", "rco", "rp", "rc"].map(view);
  const { words } = header;
  const ids = new Map(words.map((w, i) => [w, i]));
  const running = new Float64Array(words.length - FIRST_WORD);
  for (let i = 0, sum = 0; i < running.length; i++) running[i] = sum += uses[i + FIRST_WORD];
  // The position of x among ids[lo..hi), or -1.
  const find = (list: Uint16Array | Uint32Array, lo: number, hi: number, x: number) => {
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo < list.length && list[lo] === x ? lo : -1;
  };
  const rows = (id: Uint16Array | Uint32Array, count: Uint16Array | Uint32Array, from: number, to: number) => {
    const out: Row[] = new Array(Math.max(0, to - from));
    for (let i = from; i < to; i++) out[i - from] = { next: words[id[i]], count: count[i] };
    return out;
  };
  // A two-level lookup: the block of `first`, then `second` inside it, then its rows.
  const two = (starts: Uint16Array | Uint32Array, seconds: Uint16Array | Uint32Array, offsets: Uint16Array | Uint32Array, id: Uint16Array | Uint32Array, count: Uint16Array | Uint32Array, first: string, second: string) => {
    const a = ids.get(first);
    const b = ids.get(second);
    if (a === undefined || b === undefined) return [];
    const at = find(seconds, starts[a], starts[a + 1], b);
    if (at < 0 || at >= starts[a + 1]) return [];
    return rows(id, count, offsets[at], offsets[at + 1]);
  };
  return {
    vocab: words.length - FIRST_WORD,
    tokens: header.tokens,
    ends: header.ends,
    bytes: buffer.byteLength,
    has: (w) => (ids.get(w) ?? 0) >= FIRST_WORD,
    uses: (w) => {
      const i = ids.get(w);
      return i === undefined ? 0 : uses[i];
    },
    next: (p2, p1) => two(tcs, tcp, tco, tn, tc, p1, p2),
    word: (p1) => {
      const a = ids.get(p1);
      return a === undefined ? [] : rows(fn, fc, fs[a], fs[a + 1]);
    },
    prev: (a, b) => two(rcs, rcn, rco, rp, rc, a, b),
    before: (a) => {
      const i = ids.get(a);
      return i === undefined ? [] : rows(bp, bc, bs[i], bs[i + 1]);
    },
    pair: (p1, next) => {
      const a = ids.get(p1);
      const b = ids.get(next);
      if (a === undefined || b === undefined) return 0;
      const at = find(fn, fs[a], fs[a + 1], b);
      return at < 0 || at >= fs[a + 1] ? 0 : fc[at];
    },
    random: (r) => {
      const x = r * running[running.length - 1];
      let [lo, hi] = [0, running.length - 1];
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (running[mid] <= x) lo = mid + 1;
        else hi = mid;
      }
      return words[FIRST_WORD + lo];
    },
    list: () => words.slice(FIRST_WORD),
  };
}

/** The one base Ohm reads, or null: then he is the visitor-only Ohm, exactly as before. */
export let base: Base | null = null;
export const useBase = (b: Base | null) => {
  base = b;
};

/** The mixing rule's numbers, tuned in brain_eval.ipynb. `unseen`: the prior where the dataset has no evidence at all. `bottom`: the chain's last step. */
export const mixing = { prior: 4, unseen: 8, cap: 5, bottom: "unigram" as "uniform" | "unigram" };

/** Words an admin blocked, read once per reply: blocking must also hide them from the read-only base. */
export let hidden = new Set<string>();
export const loadHidden = (sql: SqlStorage) => {
  hidden = new Set(sql.exec<{ word: string }>("SELECT word FROM blocked").toArray().map((r) => r.word));
};

/**
 * The two layers of one context as one list. The dataset counts as `prior` votes in total, however big it is, so a
 * lesson isn't drowned out: P(w) = (visitor votes for w + prior × dataset share of w) / (visitor votes + prior). A
 * Dirichlet prior, in quarters of a vote. A pattern's visitor votes stop growing at `cap` people, because the visitor
 * rule counts switches, not people: two friends taking turns must not outweigh everyone. `kept` and `options` are the
 * real counts, for how far to trust this context at all (Why's chance).
 */
export function mixed(visitors: Row[], dataset: Row[]) {
  const cap = base ? mixing.cap : Infinity;
  const open = dataset.filter((r) => !hidden.has(r.next));
  const keptBase = open.reduce((sum, r) => sum + 4 * r.count - 3, 0);
  const out = new Map<string, { next: string; weight: number; votes: number }>();
  for (const r of open) out.set(r.next, { next: r.next, weight: ((4 * r.count - 3) / keptBase) * 4 * mixing.prior, votes: r.count });
  let kept = keptBase;
  for (const r of visitors) {
    const weight = 4 * Math.min(r.count, cap) - 3;
    kept += weight;
    const had = out.get(r.next);
    if (had) {
      had.weight += weight;
      had.votes += r.count;
    } else out.set(r.next, { next: r.next, weight, votes: r.count });
  }
  const rows = [...out.values()];
  return { rows, kept, keptBase, options: rows.length, total: rows.reduce((sum, r) => sum + r.weight, 0) };
}
