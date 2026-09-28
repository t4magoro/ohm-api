// The real word lists, built by tools/build_wordlists.py. Kept apart from words.ts
// because only wrangler can import .txt files; the tests build small lexicons of their own.
import block from "../wordlists/block.txt";
import en from "../wordlists/en.txt";
import id from "../wordlists/id.txt";
import { makeLexicon } from "./words";

export const lexicon = makeLexicon({ id, en }, block);