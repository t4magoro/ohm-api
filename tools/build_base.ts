// Counts a dataset into the file src/base.ts reads, with the same rules as learning from a visitor (brain.ts, hear):
// each count goes up unless the same speaker raised it last time. Pieces are already tokenized, normalized and filtered.
const START = "<s>";
const END = "</s>";
const M = 2 ** 17; // ponytail: a 3-word key fits a double up to 131,072 words; the word list is about 20,000

export function buildBase(pieces: Iterable<{ speaker: string; words: string[] }>, { minTri = 1 } = {}) {
  const ids = new Map<string, number>([[START, 0], [END, 1]]);
  const words = [START, END];
  const uses: number[] = [0, 0];
  const speakers = new Map<string, number>();
  const tri = new Map<number, number>();
  const triLast = new Map<number, number>();
  const bi = new Map<number, number>();
  const biLast = new Map<number, number>();
  let tokens = 0;
  let ends = 0;
  const idOf = (w: string) => {
    let i = ids.get(w);
    if (i === undefined) {
      i = words.length;
      ids.set(w, i);
      words.push(w);
      uses.push(0);
    }
    return i;
  };
  for (const { speaker, words: piece } of pieces) {
    if (piece.length === 0) continue;
    let who = speakers.get(speaker);
    if (who === undefined) speakers.set(speaker, (who = speakers.size));
    const t = [0, 0, ...piece.map(idOf), 1];
    for (let i = 2; i < t.length; i++) {
      const k3 = (t[i - 2] * M + t[i - 1]) * M + t[i];
      if (triLast.get(k3) !== who) {
        tri.set(k3, (tri.get(k3) ?? 0) + 1);
        triLast.set(k3, who);
      }
      const k2 = t[i - 1] * M + t[i];
      if (biLast.get(k2) !== who) {
        bi.set(k2, (bi.get(k2) ?? 0) + 1);
        biLast.set(k2, who);
      }
      if (t[i] > 1) uses[t[i]]++;
    }
    tokens += piece.length;
    ends += 1;
  }

  const V = words.length;
  const u16 = (n: number) => new Uint16Array(n);
  const u32 = (n: number) => new Uint32Array(n);

  // Pairs, forward and mirrored.
  const pairs = Float64Array.from(bi.keys()).sort();
  const nB = pairs.length;
  const [fs, fn, fc] = [u32(V + 1), u16(nB), u32(nB)];
  pairs.forEach((k, i) => {
    const p1 = Math.floor(k / M);
    fn[i] = k - p1 * M;
    fc[i] = bi.get(k)!;
    fs[p1 + 1]++;
  });
  for (let i = 0; i < V; i++) fs[i + 1] += fs[i];
  const mirrored = Float64Array.from(pairs, (k) => (k % M) * M + Math.floor(k / M)).sort();
  const [bs, bp, bc] = [u32(V + 1), u16(nB), u32(nB)];
  mirrored.forEach((k, i) => {
    const next = Math.floor(k / M);
    const p1 = k - next * M;
    bp[i] = p1;
    bc[i] = bi.get(p1 * M + next)!;
    bs[next + 1]++;
  });
  for (let i = 0; i < V; i++) bs[i + 1] += bs[i];

  // Triples by (p1, p2) → next, and by (p1, next) → p2. A block per p1, then a sorted second word, then its rows.
  const kept = [...tri].filter(([, c]) => c >= minTri);
  const nT = kept.length;
  const count = new Map(kept);
  const parts = (k: number) => {
    const next = k % M;
    const rest = (k - next) / M;
    const p1 = rest % M;
    return [(rest - p1) / M, p1, next];
  };
  const index = (key: (p2: number, p1: number, next: number) => number[]) => {
    // key gives [block, second, row id]; sorted, so runs of the same (block, second) are next to each other.
    const items = kept.map(([k]) => {
      const [p2, p1, next] = parts(k);
      const [a, b, c] = key(p2, p1, next);
      return { sort: (a * M + b) * M + c, k };
    });
    items.sort((x, y) => x.sort - y.sort);
    const starts = u32(V + 1);
    const seconds: number[] = [];
    const offsets: number[] = [];
    const id = u16(nT);
    const cnt = u32(nT);
    let last = -1;
    items.forEach(({ sort, k }, i) => {
      const c = sort % M;
      const ctx = (sort - c) / M;
      if (ctx !== last) {
        const b = ctx % M;
        starts[(ctx - b) / M + 1]++;
        seconds.push(b);
        offsets.push(i);
        last = ctx;
      }
      id[i] = c;
      cnt[i] = count.get(k)!;
    });
    offsets.push(nT);
    for (let i = 0; i < V; i++) starts[i + 1] += starts[i];
    return { starts, seconds: Uint16Array.from(seconds), offsets: Uint32Array.from(offsets), id, cnt };
  };
  const t1 = index((p2, p1, next) => [p1, p2, next]);
  const t2 = index((p2, p1, next) => [p1, next, p2]);

  const arrays: Record<string, Uint16Array | Uint32Array> = {
    uses: Uint32Array.from(uses), fs, fn, fc, bs, bp, bc,
    tcs: t1.starts, tcp: t1.seconds, tco: t1.offsets, tn: t1.id, tc: t1.cnt,
    rcs: t2.starts, rcn: t2.seconds, rco: t2.offsets, rp: t2.id, rc: t2.cnt,
  };
  // The header holds offsets, and its own length moves them, so lay it out with a fixed room for them.
  const places: Record<string, [number, number, number]> = {};
  const names = Object.keys(arrays);
  const draft = new TextEncoder().encode(JSON.stringify({ words, tokens, ends, arrays: Object.fromEntries(names.map((n) => [n, [1e11, 1e11, 16]])) }));
  let at = 4 + draft.length;
  at = (at + 7) & ~7;
  for (const n of names) {
    const a = arrays[n];
    at = (at + a.BYTES_PER_ELEMENT - 1) & ~(a.BYTES_PER_ELEMENT - 1);
    places[n] = [at, a.length, a.BYTES_PER_ELEMENT * 8];
    at += a.byteLength;
  }
  const buffer = new ArrayBuffer(at);
  const header = new TextEncoder().encode(JSON.stringify({ words, tokens, ends, arrays: places }));
  new Uint32Array(buffer, 0, 1)[0] = header.length;
  new Uint8Array(buffer, 4, header.length).set(header);
  for (const n of names) new (arrays[n].constructor as Uint32ArrayConstructor)(buffer, places[n][0], places[n][1]).set(arrays[n]);
  const n1 = [...tri.values()].filter((c) => c === 1).length;
  const n2 = [...tri.values()].filter((c) => c === 2).length;
  return { buffer, stats: { vocab: V - 2, tokens, ends, pairs: nB, triples: nT, triplesAll: tri.size, speakers: speakers.size, kneserD: n1 / (n1 + 2 * n2) } };
}
