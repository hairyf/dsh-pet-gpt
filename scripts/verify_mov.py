#!/usr/bin/env python3
"""Prove that every committed MOV decodes with a real alpha plane on macOS.

ffprobe only reads container metadata; a broken HEVC-with-alpha file still
reports codec hvc1. This runs the compiled AVFoundation verifier on every
animation referenced by config.jsonc, so CI fails when transparency was lost.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FRAME_WIDTH = 640
FRAME_RATE = 12


def referenced_names() -> list[str]:
    raw = (ROOT / "config.jsonc").read_text(encoding="utf-8")
    config = json.loads("\n".join(line for line in raw.splitlines() if not line.strip().startswith("//")))
    names: set[str] = set()

    def collect(value):
        if isinstance(value, str):
            names.add(value)
        elif isinstance(value, list):
            for item in value:
                collect(item)

    collect(list(config.get("motions", {}).values()))
    pools = config.get("animations", {})
    for key in ("idle", "turn", "drag", "clicks"):
        collect(pools.get(key))
    collect([action.get("name") for action in pools.get("moves", {}).get("actions", [])])
    for category in pools.get("categories", []):
        collect(category.get("actions"))
    for slot in pools.get("events", {}).values():
        collect(slot)
    return sorted(names)


def main() -> None:
    verifier = os.environ.get("ALPHA_VERIFIER")
    if not verifier:
        print("error: ALPHA_VERIFIER is not set", file=sys.stderr)
        raise SystemExit(1)
    names = referenced_names()
    missing = [name for name in names if not (ROOT / "mov" / f"{name}.mov").is_file()]
    if missing:
        print(f"error: missing MOV files: {', '.join(missing)}", file=sys.stderr)
        raise SystemExit(1)
    for name in names:
        path = ROOT / "mov" / f"{name}.mov"
        media = json.loads(subprocess.run(
            ["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
             "-show_entries", "stream=nb_read_frames", "-show_entries", "format=duration",
             "-of", "json", str(path)],
            check=True, stdout=subprocess.PIPE, text=True,
        ).stdout)
        frames = media["streams"][0]["nb_read_frames"]
        duration = media["format"]["duration"]
        subprocess.run([verifier, str(path), frames, duration, str(FRAME_WIDTH)], check=True)
    print(f"native alpha verified for {len(names)} MOV files")


if __name__ == "__main__":
    main()
