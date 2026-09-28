"""Builds the word lists Ohm learns from.

  wordlists/id.txt, en.txt  words Ohm may learn by itself (the 30,000 most common of each language)
  wordlists/block.txt       words it must never learn: LDNOOBW's English list + your block-id.txt

Sources: hermitdave/FrequencyWords (MIT, from movie subtitles) and
LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words (CC BY 4.0).

Run from ohm-api:
  docker run --rm -v "${PWD}:/app" -w /app python:3.13-alpine python tools/build_wordlists.py
"""

import re
import urllib.request
from pathlib import Path

FREQUENCY = "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/{lang}/{lang}_50k.txt"
BAD_WORDS_EN = "https://raw.githubusercontent.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/master/en"
KEEP = 30_000
# Letters, optionally joined by ' or - (don't, kupu-kupu). Same rule as tokenize() in brain.ts.
WORD = re.compile(r"^[^\W\d_]+(?:['-][^\W\d_]+)*$")
OUT = Path("wordlists")


def download(url: str) -> list[str]:
    with urllib.request.urlopen(url, timeout=30) as res:
        return res.read().decode("utf-8").splitlines()


def words_in(lines: list[str]) -> set[str]:
    """One word per line; blank lines and # comments are skipped."""
    return {w.strip().lower() for w in lines if w.strip() and not w.strip().startswith("#")}


# LDNOOBW also has phrases; only single words can match what Ohm hears, so only those are kept.
blocked = {w for w in words_in(download(BAD_WORDS_EN)) if " " not in w}
blocked |= words_in((OUT / "block-id.txt").read_text(encoding="utf-8").splitlines())
(OUT / "block.txt").write_text("\n".join(sorted(blocked)) + "\n", encoding="utf-8")
print(f"block: {len(blocked)} words")

for lang in ("id", "en"):
    kept: dict[str, None] = {}  # a dict keeps the frequency order and drops duplicates
    for line in download(FREQUENCY.format(lang=lang)):
        word = line.split(" ")[0].lower()
        if len(word) <= 24 and WORD.match(word) and word not in blocked:
            kept[word] = None
        if len(kept) == KEEP:
            break
    (OUT / f"{lang}.txt").write_text("\n".join(kept) + "\n", encoding="utf-8")
    print(f"{lang}: {len(kept)} words")