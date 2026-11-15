// Ohm's reply generator for the Worker: the brain_v4 transformer, run word by word with a key/value cache, in plain
// TypeScript with no runtime library. Mirrors decode.py: masked sampling with temperature and top-p, k candidates,
// exact-copy rejection (unless every candidate is a copy: change 15), score = mean log2 p at temperature 1, and the guard.
// Speed: every weight row is read once per batch of vectors (the context's words together, the k candidates together).

export type Meta = {
  d: number; layers: number; heads: number; ctx: number;
  itos: string[]; canSay: string[];
  tensors: Record<string, [number, number[]]>; // name → [offset in floats, shape]
};

/** What the model has read so far: each layer's keys and values, one row per position. */
export type State = { k: Float32Array[]; v: Float32Array[]; n: number };

const SQRT1_2 = Math.SQRT1_2;
/** erf by Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7): PyTorch's default GELU is the exact, erf-based one. */
function erf(x: number): number {
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
  return s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
}

/** OUT[m, rows] = X[m, cols] · Wᵀ + b, W is [rows, cols] row-major (PyTorch's Linear layout); b may be null. */
function linear(W: Float32Array, b: Float32Array | null, X: Float32Array, m: number, cols: number, rows: number, OUT: Float32Array) {
  for (let r = 0; r < rows; r++) {
    const o = r * cols, bias = b ? b[r] : 0;
    for (let v = 0; v < m; v++) {
      const xo = v * cols;
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0, c = 0;
      for (; c + 3 < cols; c += 4) {
        s0 += W[o + c] * X[xo + c]; s1 += W[o + c + 1] * X[xo + c + 1];
        s2 += W[o + c + 2] * X[xo + c + 2]; s3 += W[o + c + 3] * X[xo + c + 3];
      }
      for (; c < cols; c++) s0 += W[o + c] * X[xo + c];
      OUT[v * rows + r] = bias + s0 + s1 + s2 + s3;
    }
  }
}

function layerNorm(X: Float32Array, m: number, d: number, g: Float32Array, b: Float32Array, OUT: Float32Array) {
  for (let v = 0; v < m; v++) {
    const o = v * d;
    let mean = 0;
    for (let i = 0; i < d; i++) mean += X[o + i];
    mean /= d;
    let q = 0;
    for (let i = 0; i < d; i++) q += (X[o + i] - mean) ** 2;
    const inv = 1 / Math.sqrt(q / d + 1e-5);
    for (let i = 0; i < d; i++) OUT[o + i] = (X[o + i] - mean) * inv * g[i] + b[i];
  }
}

// wasm-ld puts kern.wasm's stack and data at the start of memory (it declares 2 pages, 128 KiB). Ours starts after it,
// which also keeps pointer 0 free to mean "no bias". ponytail: a fixed 1 MiB, check the declared size if the kernel grows.
const KERNEL_AREA = 1 << 20;

export class Gen {
  readonly meta: Meta;
  readonly stoi: Map<string, number>;
  private w: Record<string, Float32Array> = {};
  private kern: ((...a: number[]) => void) | null = null;
  private buf: Record<"X" | "H" | "QKV" | "A" | "T" | "M" | "Hw" | "OUT", Float32Array>;
  static readonly MAX_WANT = 16; // logits wanted per call: the k candidates, or the last context word

  /** kern: kern.wasm compiled (a WebAssembly.Module). Without it, the same arithmetic runs in plain JS. */
  constructor(bin: ArrayBuffer, meta: Meta, kern?: WebAssembly.Module) {
    this.meta = meta;
    this.stoi = new Map(meta.itos.map((w, i) => [w, i]));
    const { d, ctx } = meta, V = meta.itos.length;
    const sizes = { X: ctx * d, H: ctx * d, QKV: ctx * 3 * d, A: ctx * d, T: ctx * d, M: ctx * 4 * d,
                    Hw: Gen.MAX_WANT * d, OUT: Gen.MAX_WANT * V };
    let mem: ArrayBuffer, wBase: number, at: number;
    if (kern) {  // the kernel's own stack and data first, then the weights, then the buffers, in one memory that never grows
      const scratch = Object.values(sizes).reduce((a, b) => a + b, 0) * 4 + 16 * 8;
      const memory = new WebAssembly.Memory({ initial: Math.ceil((KERNEL_AREA + bin.byteLength + scratch) / 65536) });
      new Uint8Array(memory.buffer, KERNEL_AREA).set(new Uint8Array(bin));
      this.kern = new WebAssembly.Instance(kern, { env: { memory } }).exports.linear as (...a: number[]) => void;
      mem = memory.buffer; wBase = KERNEL_AREA; at = KERNEL_AREA + bin.byteLength;
    } else {
      mem = new ArrayBuffer(Object.values(sizes).reduce((a, b) => a + b, 0) * 4); wBase = -1; at = 0;
    }
    for (const [name, [off, shape]] of Object.entries(meta.tensors))
      this.w[name] = wBase < 0 ? new Float32Array(bin, off * 4, shape.reduce((a, b) => a * b, 1))
                               : new Float32Array(mem, wBase + off * 4, shape.reduce((a, b) => a * b, 1));
    const buf: Record<string, Float32Array> = {};
    for (const [k, n] of Object.entries(sizes)) { at = Math.ceil(at / 16) * 16; buf[k] = new Float32Array(mem, at, n); at += n * 4; }
    this.buf = buf as Gen["buf"];
  }

  private lin(W: Float32Array, b: Float32Array | null, X: Float32Array, m: number, cols: number, rows: number, OUT: Float32Array) {
    if (this.kern) this.kern(W.byteOffset, b ? b.byteOffset : 0, X.byteOffset, m, cols, rows, OUT.byteOffset);
    else linear(W, b, X, m, cols, rows, OUT);
  }

  /** States are reused (release): a reply needs k + 1 of them, 0.6 MB each, so making new ones every reply only made
   *  garbage. A reused state's rows past n hold old numbers, which are never read: a position is written before it's read. */
  private pool: State[] = [];

  start(): State {
    const { layers, ctx, d } = this.meta, s = this.pool.pop();
    if (s) { s.n = 0; return s; }
    return { k: Array.from({ length: layers }, () => new Float32Array(ctx * d)),
             v: Array.from({ length: layers }, () => new Float32Array(ctx * d)), n: 0 };
  }

  clone(s: State): State {
    const used = s.n * this.meta.d, c = this.start();
    s.k.forEach((a, l) => c.k[l].set(a.subarray(0, used)));
    s.v.forEach((a, l) => c.v[l].set(a.subarray(0, used)));
    c.n = s.n;
    return c;
  }

  release(...states: State[]) {
    this.pool.push(...states);
  }

  /** Reads m words at once: word j goes to states[j] at its next position (a state listed twice takes consecutive
   *  positions, which is how a context is read in one go). Returns the next-word logits after each j in want. */
  forward(states: State[], ids: number[], want: number[], attn?: (Float32Array | undefined)[]): Float32Array[] {
    // attn[j], if given: word j's attention over the positions it sees, averaged over every layer and head (read only).
    const { d, layers, heads, ctx, itos } = this.meta, w = this.w, hd = d / heads, m = ids.length, scale = 1 / Math.sqrt(hd);
    const share = 1 / (layers * heads);
    const pos = new Int32Array(m), seen = new Map<State, number>();
    for (let j = 0; j < m; j++) {
      const s = states[j], before = seen.get(s) ?? 0;
      pos[j] = s.n + before;
      seen.set(s, before + 1);
      if (pos[j] >= ctx) throw new Error("context full");
    }
    if (want.length > Gen.MAX_WANT) throw new Error("too many logits wanted at once");
    const b = this.buf, X = b.X.subarray(0, m * d), H = b.H.subarray(0, m * d), QKV = b.QKV.subarray(0, m * 3 * d);
    const A = b.A.subarray(0, m * d), T = b.T.subarray(0, m * d), M = b.M.subarray(0, m * 4 * d), sc = new Float32Array(ctx);
    const E = w["emb.weight"], P = w["pos.weight"];
    for (let j = 0; j < m; j++) for (let i = 0; i < d; i++) X[j * d + i] = E[ids[j] * d + i] + P[pos[j] * d + i];
    for (let l = 0; l < layers; l++) {
      const p = `blocks.${l}.`;
      layerNorm(X, m, d, w[p + "ln1.weight"], w[p + "ln1.bias"], H);
      this.lin(w[p + "qkv.weight"], w[p + "qkv.bias"], H, m, d, 3 * d, QKV);
      for (let j = 0; j < m; j++) {  // all keys and values first, so a word can see the earlier words of its own batch
        states[j].k[l].set(QKV.subarray(j * 3 * d + d, j * 3 * d + 2 * d), pos[j] * d);
        states[j].v[l].set(QKV.subarray(j * 3 * d + 2 * d, (j + 1) * 3 * d), pos[j] * d);
      }
      for (let j = 0; j < m; j++) {
        const K = states[j].k[l], V = states[j].v[l], q = j * 3 * d, a = j * d, last = pos[j], look = attn?.[j];
        for (let hh = 0; hh < heads; hh++) {
          const o = hh * hd;
          let max = -Infinity;
          for (let t = 0; t <= last; t++) {
            let s = 0;
            for (let i = 0; i < hd; i++) s += QKV[q + o + i] * K[t * d + o + i];
            sc[t] = s * scale;
            if (sc[t] > max) max = sc[t];
          }
          let sum = 0;
          for (let t = 0; t <= last; t++) sum += (sc[t] = Math.exp(sc[t] - max));
          for (let i = 0; i < hd; i++) A[a + o + i] = 0;
          for (let t = 0; t <= last; t++) {
            const pt = sc[t] / sum;
            if (look) look[t] += pt * share;
            for (let i = 0; i < hd; i++) A[a + o + i] += pt * V[t * d + o + i];
          }
        }
      }
      this.lin(w[p + "proj.weight"], w[p + "proj.bias"], A, m, d, d, T);
      for (let i = 0; i < m * d; i++) X[i] += T[i];
      layerNorm(X, m, d, w[p + "ln2.weight"], w[p + "ln2.bias"], H);
      this.lin(w[p + "mlp.0.weight"], w[p + "mlp.0.bias"], H, m, d, 4 * d, M);
      for (let i = 0; i < M.length; i++) M[i] = 0.5 * M[i] * (1 + erf(M[i] * SQRT1_2));
      this.lin(w[p + "mlp.2.weight"], w[p + "mlp.2.bias"], M, m, 4 * d, d, T);
      for (let i = 0; i < m * d; i++) X[i] += T[i];
    }
    for (const [s, n] of seen) s.n += n;
    // The vocabulary-sized output layer only where logits are wanted: the last context word, or each candidate.
    const Hw = b.Hw.subarray(0, want.length * d), out = b.OUT.subarray(0, want.length * itos.length);
    want.forEach((j, r) => Hw.set(X.subarray(j * d, (j + 1) * d), r * d));
    layerNorm(Hw, want.length, d, w["ln.weight"], w["ln.bias"], Hw);
    this.lin(E, null, Hw, want.length, d, itos.length, out);
    return want.map((_, r) => out.slice(r * itos.length, (r + 1) * itos.length));  // copies: the buffer is reused
  }

  /** One word for one state: the simple form, used by the logit check. */
  step(s: State, id: number): Float32Array {
    return this.forward([s], [id], [0])[0];
  }
}

/** A seeded random number generator (mulberry32), so tests and replays are repeatable. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One word said, for the think page: its probability, the top 5 it was picked from (all at temperature 1, after any
 *  lesson), and how much of its probability came from the lesson (0 without one). */
/** `die`: where his roll landed, on the line of chances laid end to end from the likeliest word; `cut`: where that line
 *  stops (the top-p words' total), so the die always lands before it. Both on the chances shown (τ = 1 makes them equal). */
export type Step = { word: string; p: number; top: [string, number][]; lesson: number; attn?: number[]; die: number; cut: number };
export type Candidate = { words: string[] | null; score: number; why: "ok" | "copy" | "too long"; steps: Step[] };
export type Reply = { words: string[] | null; score: number; chosen: number; candidates: Candidate[] };
export type Settings = { k: number; tau: number; pi: number; theta: number };
/** A lesson (change 9): he starts from `topic`, and after his last two words (p2 "<s>" at the start) he mixes in
 *  `after(p2, p1)`, what visitors said next (count 3 or more, "<end>" for a sentence end), weighted by count. Blocked
 *  words must already be out. */
export type Lesson = { topic: string; after: (p2: string, p1: string) => [string, number][]; lambda: number };

const MAX_WORDS = 20;
export const MIN_COPY_WORDS = 5; // change 8: only copies of training replies this long are banned

/** The banned copies: whole training replies (normalized words joined by spaces) of at least MIN_COPY_WORDS words. */
export const copySet = (replies: string[]) => new Set(replies.filter((r) => r.split(" ").length >= MIN_COPY_WORDS));

/** pick()'s three work arrays, reused: new ones at every step of every candidate made about 15 MB of garbage a reply. */
let work = new Float64Array(0);
function workArrays(n: number) {
  if (work.length < 3 * n) work = new Float64Array(3 * n);
  const q = work.subarray(0, n), s = work.subarray(n, 2 * n), f = work.subarray(2 * n, 3 * n);
  q.fill(0); s.fill(0); f.fill(0);
  return [q, s, f];
}

/**
 * Picks the next word: top-p sampling at temperature tau. Without a lesson it's over G's allowed words. With one,
 * p = (1 - λ) p_G + λ p_L, and p_L may hold words G has never seen, which get their own slots past G's vocabulary.
 * Returns the word, the id G reads it as (<unk> for a new word), and the step for the think page, whose p is at
 * temperature 1: the score averages log2 of it.
 */
function pick(g: Gen, logits: Float32Array, allowed: Uint8Array, set: Settings, rand: () => number, pL: Map<string, number> | null, lambda: number) {
  const V = logits.length, itos = g.meta.itos, stoi = g.stoi;
  let max = -Infinity;
  for (let i = 0; i < V; i++) if (allowed[i] && logits[i] > max) max = logits[i];
  const extra = pL ? [...pL.keys()].filter((w) => !stoi.has(w)) : [];
  const [q, s, fromLesson] = workArrays(V + extra.length), order: number[] = [];
  let z1 = 0, zt = 0;
  for (let i = 0; i < V; i++) if (allowed[i]) { z1 += (s[i] = Math.exp(logits[i] - max)); zt += (q[i] = Math.exp((logits[i] - max) / set.tau)); }
  const gw = pL ? 1 - lambda : 1;
  for (let i = 0; i < V; i++) if (allowed[i]) { q[i] *= gw / zt; s[i] *= gw / z1; }
  if (pL) for (const [w, p] of pL) { const i = stoi.get(w) ?? V + extra.indexOf(w); q[i] += lambda * p; s[i] += lambda * p; fromLesson[i] = lambda * p; }
  // Only words above a small floor need sorting when the words under it hold less than 1 - pi and 5 are above it: the
  // top-p set and the top 5 then lie wholly above it, in the order a full sort gives (sort is stable). Else sort them all.
  let tail = 0;
  for (let i = 0; i < q.length; i++) if (q[i] >= 1e-4) order.push(i); else tail += q[i];
  if (tail >= 1 - set.pi - 1e-9 || order.length < 5) { order.length = 0; for (let i = 0; i < q.length; i++) if (q[i] > 0) order.push(i); }
  order.sort((a, b) => q[b] - q[a]);
  let cum = 0, keep = 0;
  while (keep < order.length && cum < set.pi) cum += q[order[keep++]];
  let r = rand() * cum, w = order[keep - 1];
  const die = r; // recorded for the think page only
  for (let j = 0; j < keep; j++) { r -= q[order[j]]; if (r <= 0) { w = order[j]; break; } }
  const name = (i: number) => (i < V ? itos[i] : extra[i - V]);
  const step: Step = { word: name(w), p: s[w], top: order.slice(0, 5).map((i) => [name(i), s[i]]), lesson: fromLesson[w] / s[w],
                       die: Math.round(die * 1e4) / 1e4, cut: Math.round(cum * 1e4) / 1e4 };
  return { id: w < V ? w : stoi.get("<unk>")!, step };
}

/** p_L after the words so far, normalized, or null when visitors taught nothing after them (then p = p_G). */
function lessonAfter(lesson: Lesson | undefined, words: string[], cache: Map<string, Map<string, number> | null>) {
  if (!lesson) return null;
  if (!words.length) return new Map([[lesson.topic, 1]]); // the first word: all of p_L on the topic
  const p1 = words[words.length - 1], p2 = words.length > 1 ? words[words.length - 2] : "<s>", key = `${p2} ${p1}`;
  if (!cache.has(key)) {
    const rows = lesson.after(p2, p1), total = rows.reduce((a, [, n]) => a + n, 0);
    cache.set(key, total > 0 ? new Map(rows.map(([w, n]) => [w, n / total])) : null);
  }
  return cache.get(key)!;
}

/** Ohm's reply to a context (ids up to and including <ohm>), as decode.py's Brain.reply, plus the lesson mix. The k
 *  candidates are written in lockstep so each step's weights are read once for all of them. `msg`: the positions
 *  [from, to) of the visitor's message in the context; then each step's `attn` is the attention that picked it, on each
 *  message word (the think page; the arithmetic is the same either way). */
export function reply(g: Gen, context: number[], allowed: Uint8Array, copies: Set<string>, set: Settings, rand: () => number, lesson?: Lesson, msg?: [number, number]): Reply {
  const END = g.stoi.get("<end>")!, CTX = g.meta.ctx;
  const look = () => (msg ? new Float32Array(CTX) : undefined);
  const onMsg = (a: Float32Array | undefined) => a && Array.from(a.subarray(msg![0], msg![1]), (x) => Math.round(x * 1000) / 1000);
  const base = g.start(), first = look(), firstAttn: (Float32Array | undefined)[] = [];
  firstAttn[context.length - 1] = first;
  const last = g.forward(context.map(() => base), context, [context.length - 1], firstAttn)[0];
  const cache = new Map<string, Map<string, number> | null>();
  const run = Array.from({ length: set.k }, () => ({ s: g.clone(base), words: [] as string[], steps: [] as Step[], logits: last, attn: first, done: false }));
  for (let n = 0; n <= MAX_WORDS; n++) {
    const next: typeof run = [], ids: number[] = [];
    for (const c of run) {
      if (c.done) continue;
      const pL = lessonAfter(lesson, c.words, cache);
      const { id, step } = pick(g, c.logits, allowed, set, rand, pL, lesson?.lambda ?? 0);
      if (msg) step.attn = onMsg(c.attn);
      c.steps.push(step);
      if (id === END) c.done = true;
      else { c.words.push(step.word); next.push(c); ids.push(id); }
    }
    if (!next.length) break;
    if (n === MAX_WORDS) break;  // the 21st word wasn't <end>: too long, as in decode.py
    const attn = next.map(look);
    const logits = g.forward(next.map((c) => c.s), ids, ids.map((_, j) => j), attn);
    next.forEach((c, j) => { c.logits = logits[j]; c.attn = attn[j]; });
  }
  const cands: Candidate[] = run.map((c) =>
    !c.done ? { words: null, score: -Infinity, why: "too long", steps: c.steps }
    : { words: c.words, score: c.steps.reduce((a, t) => a + Math.log2(t.p), 0) / c.steps.length, why: copies.has(c.words.join(" ")) ? "copy" : "ok", steps: c.steps });
  g.release(base, ...run.map((c) => c.s));
  // Change 15: a banned copy is said only when every finished candidate is one (else "nama kamu siapa" got "I don't know").
  const fresh = cands.filter((c) => c.why === "ok"), pool = fresh.length ? fresh : cands.filter((c) => c.why === "copy");
  const best = (pool.length ? pool : cands).reduce((a, b) => (b.score > a.score ? b : a));
  const ok = best.why !== "too long" && best.score >= set.theta;
  return { words: ok ? best.words : null, score: best.score, chosen: cands.indexOf(best), candidates: cands };
}
