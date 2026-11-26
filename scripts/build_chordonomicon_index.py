"""Builds the static chord index the app looks songs up in.

Reads chordonomicon_v2.csv (https://huggingface.co/datasets/ailsntua/Chordonomicon,
CC BY-NC 4.0) and writes <out>/0000.json ... 2047.json, each mapping Spotify track
IDs to the song's Chordonomicon chord string, plus <out>/meta.json.

Usage:
  python -I scripts/build_chordonomicon_index.py path/to/chordonomicon_v2.csv [out_dir]

out_dir defaults to public/cn so `npm run dev` and `npm run build` serve it.
"""

import csv
import json
import os
import sys

SHARD_COUNT = 2048


def shard_of(spotify_id: str) -> str:
    """FNV-1a 32-bit. Must match shardOf() in src/chart/chordonomicon.ts."""
    h = 0x811C9DC5
    for ch in spotify_id:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{h % SHARD_COUNT:04d}"


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join("public", "cn")
    os.makedirs(out, exist_ok=True)
    csv.field_size_limit(10**9)

    shards: dict[str, dict[str, str]] = {}
    rows = kept = dupes = 0
    with open(src, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            rows += 1
            sid = (row.get("spotify_song_id") or "").strip()
            chords = " ".join((row.get("chords") or "").split())
            if not sid or not chords or len(sid) != 22:
                continue
            shard = shards.setdefault(shard_of(sid), {})
            if sid in shard:
                dupes += 1
                # Keep the longer transcription; it is usually the complete one.
                if len(chords) <= len(shard[sid]):
                    continue
            else:
                kept += 1
            shard[sid] = chords

    for name, data in shards.items():
        with open(os.path.join(out, f"{name}.json"), "w", encoding="utf-8") as f:
            json.dump(data, f, separators=(",", ":"), ensure_ascii=False)

    meta = {
        "source": "Chordonomicon v2 (Kantarelis et al. 2024)",
        "license": "CC BY-NC 4.0",
        "url": "https://huggingface.co/datasets/ailsntua/Chordonomicon",
        "rows": rows,
        "tracks": kept,
        "duplicates": dupes,
        "shards": SHARD_COUNT,
    }
    with open(os.path.join(out, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
