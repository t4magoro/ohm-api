// Counts Tatoeba's Indonesian sentences into src/base.bin, the read-only layer base.ts reads. Only needed to refresh them.
// 1. Download ind_sentences.tsv.bz2 from https://downloads.tatoeba.org/exports/per_language/ind/ and unpack it:
//      docker run --rm -v "${PWD}:/app" -w /app python:3.13-alpine python -c "import bz2,shutil;shutil.copyfileobj(bz2.open('ind_sentences.tsv.bz2'),open('ind_sentences.tsv','wb'))"
// 2. docker run --rm -v "${PWD}:/app" -w /app node:24-slim node --import ./tools/resolve.mjs tools/build_counts.ts ind_sentences.tsv
// 3. Update the author list in CREDITS.md (CC BY 2.0 FR asks for them): the authors are in ind_sentences_detailed.tsv.bz2.
// The rules are the evaluation's (research/brain_eval.ipynb): a sentence with a blocked word is dropped whole, as hear() drops a
// message, and so are the stock names Tom and Mary. Unknown words split a sentence into pieces. Each sentence is its own speaker.
import { readFileSync, writeFileSync } from "node:fs";
import { makeLexicon, tokenize } from "../src/words.ts";
import { buildBase } from "./build_base.ts";

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
// tools/counts-block.txt: more words kept out of the counts than wordlists/block.txt blocks in messages.
const lexicon = makeLexicon({ id: read("wordlists/id.txt"), en: read("wordlists/en.txt") }, [read("wordlists/block.txt"), ...read("tools/counts-block.txt").split("\n").map((w) => w.trim()).filter(Boolean)].join("\n"));
const known = (w: string) => lexicon.langsOf(w).length > 0;
const clean = (t: string) =>
  t
    .split("\n")
    .filter((l) => !l.trimStart().startsWith(">") && !l.trimStart().startsWith("&gt;"))
    .join("\n")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+|www\.\S+/gi, " ")
    .replace(/\/?\b[ur]\/[A-Za-z0-9_-]+/g, " ")
    .replace(/&[a-z]+;/gi, " ");

function* pieces(file: string) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    const [id, lang, text] = line.split("\t");
    if (lang !== "ind") throw new Error(`not an Indonesian sentence: ${id}`);
    const sentences = clean(text).split(/[.!?\n]+/).map((s) => s.trim()).filter(Boolean).map((s) => lexicon.normalize(tokenize(s))).filter((s) => s.length > 0);
    if (sentences.some((s) => s.some((w) => lexicon.isBlocked(w)))) continue;
    for (const s of sentences.filter((x) => !x.includes("tom") && !x.includes("mary"))) {
      let piece: string[] = [];
      for (const w of [...s, ""]) {
        if (w && known(w)) piece.push(w);
        else if (piece.length > 0) {
          yield { speaker: id, words: piece };
          piece = [];
        }
      }
    }
  }
}

const { buffer, stats } = buildBase(pieces(process.argv[2]), { minTri: 1 });
writeFileSync(new URL("../src/base.bin", import.meta.url), new Uint8Array(buffer));
console.log(JSON.stringify({ ...stats, bytes: buffer.byteLength }));
