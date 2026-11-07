// Packs Ohm's own lines, lines/ohm.json, into src/lines.bin. Run it after editing the lines, from ohm-api:
//   docker run --rm -v "${PWD}:/app" -w /app node:24-slim node --import ./tools/resolve.mjs tools/build_lines.ts
// Each group is a list of messages (p) and replies (r): any reply can answer any message in its group. Messages are matched
// as he hears them (normalized, then tidied as in retrieve.ts). Replies are said exactly as written.
import { readFileSync, writeFileSync } from "node:fs";
import { packRetrieval, tidy } from "../src/retrieve.ts";
import { makeLexicon, tokenize } from "../src/words.ts";

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const lexicon = makeLexicon({ id: read("wordlists/id.txt"), en: read("wordlists/en.txt") }, read("wordlists/block.txt"));
const groups: { p: string[]; r: string[] }[] = JSON.parse(read("lines/ohm.json"));
const pairs: { prompt: string[]; reply: string[] }[] = [];
for (const { p, r } of groups) {
  for (const prompt of new Set(p.map((x) => tidy(lexicon.normalize(tokenize(x))).join(" ")))) {
    for (const text of r) pairs.push({ prompt: prompt.split(" "), reply: text.split(" ") });
  }
}
const blocked = [...new Set(pairs.flatMap((x) => lexicon.normalize(x.reply)))].filter((w) => lexicon.isBlocked(w));
if (blocked.length > 0) throw new Error(`blocked words in his replies: ${blocked.join(" ")}`);
writeFileSync(new URL("../src/lines.bin", import.meta.url), new Uint8Array(packRetrieval(pairs)));
console.log(`${groups.length} groups, ${pairs.length} message and reply pairs`);
