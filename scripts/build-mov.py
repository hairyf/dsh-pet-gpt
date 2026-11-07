#!/usr/bin/env python3
"""Encode HEVC-with-alpha MOV files for macOS from the committed WebM assets.

Apple needs HEVC-with-alpha (.mov, codec tag hvc1) for transparency in
WKWebView; VP9 alpha WebM stays the Windows/Linux format. Encoding goes through
AVAssetWriter, which only exists on macOS, so this script must run on a macOS
runner (see .github/workflows/sync-upstream.yml):

    python3 scripts/build-mov.py self-check     # host + asset sanity
    python3 scripts/build-mov.py run            # encode every missing/stale MOV
    python3 scripts/build-mov.py run --force    # re-encode everything

Environment:
    ENCODER        path to the compiled hevc-alpha helper (built from the
                   pinned upstream source by the workflow)
    ANIMATIONS     optional JSON array limiting the run to those animations
    MOV_JOBS       parallel encodes (default: cpu_count, min 2)
"""

from __future__ import annotations

import json
import os
import hashlib
import platform
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEBM_DIR = ROOT / "webm"
MOV_DIR = ROOT / "mov"
CONFIG = ROOT / "config.jsonc"
PET = ROOT / "pet.json"
# Provenance manifest shared with convert.mjs. A MOV is stale when the recorded
# digest of the WebM it was encoded from no longer matches webm/.
ASSETS = ROOT / ".assets.json"
FRAME_WIDTH = 640
FRAME_HEIGHT = 360
FRAME_RATE = 12


def fail(message: str) -> "NoReturn":
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def probe(path: Path) -> dict:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
            "-show_entries", "stream=codec_name,codec_tag_string,pix_fmt,width,height,r_frame_rate,nb_read_frames",
            "-show_entries", "format=duration,size", "-of", "json", str(path),
        ],
        check=True, stdout=subprocess.PIPE, text=True, encoding="utf-8", timeout=300,
    )
    return json.loads(result.stdout)


def animation_names() -> list[str]:
    raw = CONFIG.read_text(encoding="utf-8")
    stripped = "\n".join(line for line in raw.splitlines() if not line.strip().startswith("//"))
    config = json.loads(stripped)
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
    collect(list(pools.get("motions", {}).values()))
    collect([action.get("name") for action in pools.get("moves", {}).get("actions", [])])
    for category in pools.get("categories", []):
        collect(category.get("actions"))
    for slot in pools.get("events", {}).values():
        collect(slot)
    return sorted(names)


def sources() -> list[Path]:
    if not WEBM_DIR.is_dir():
        fail(f"missing {WEBM_DIR.relative_to(ROOT)}")
    files = sorted(WEBM_DIR.glob("*.webm"))
    if not files:
        fail("webm/ holds no animations")
    known = {path.stem for path in files}
    missing = [name for name in animation_names() if name not in known]
    if missing:
        fail(f"configured animations without a video: {', '.join(missing)}")
    return files


def validate_source(path: Path) -> int:
    media = probe(path)
    stream = media["streams"][0]
    if stream["codec_name"] != "vp9":
        fail(f"{path.name}: expected VP9, found {stream['codec_name']}")
    if (stream["width"], stream["height"]) != (FRAME_WIDTH, FRAME_HEIGHT):
        fail(f"{path.name}: expected {FRAME_WIDTH}x{FRAME_HEIGHT}, found {stream['width']}x{stream['height']}")
    if stream["r_frame_rate"] != f"{FRAME_RATE}/1":
        fail(f"{path.name}: expected {FRAME_RATE} fps, found {stream['r_frame_rate']}")
    frames = int(stream["nb_read_frames"])
    if frames < 2:
        fail(f"{path.name}: only {frames} decodable frames")
    alpha = subprocess.run(
        [
            "ffmpeg", "-v", "error", "-c:v", "libvpx-vp9", "-i", str(path),
            "-vf", "format=rgba,alphaextract,scale=64:64", "-f", "rawvideo",
            "-pix_fmt", "gray", "-",
        ],
        check=True, stdout=subprocess.PIPE, timeout=300,
    ).stdout
    if not alpha:
        fail(f"{path.name}: alpha plane is empty")
    if min(alpha) > 32 or max(alpha) < 223:
        fail(f"{path.name}: source alpha looks opaque ({min(alpha)}..{max(alpha)})")
    expected = frames / FRAME_RATE
    actual = float(media["format"]["duration"])
    if abs(actual - expected) > 1 / FRAME_RATE + 0.05:
        fail(f"{path.name}: duration {actual:.3f}s does not match {frames} frames at {FRAME_RATE} fps")
    return frames


def load_assets() -> dict:
    if not ASSETS.is_file():
        return {"upstream": None, "animations": {}}
    return json.loads(ASSETS.read_text(encoding="utf-8"))


def save_assets(assets: dict) -> None:
    ASSETS.write_text(json.dumps(assets, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def needs_encoding(source: Path, target: Path, entry: dict | None) -> bool:
    if not target.is_file() or target.stat().st_size == 0:
        return True
    if entry is None:
        return True
    return entry.get("mov") != sha256(source)


def encode(source: Path, target: Path) -> str:
    encoder = os.environ.get("ENCODER")
    if not encoder:
        fail("ENCODER is not set; run this on macOS with the compiled helper")
    frames = validate_source(source)
    MOV_DIR.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="hevc-alpha-", dir=MOV_DIR) as temporary:
        encoded = Path(temporary) / "output.mov"
        decoder = subprocess.Popen(
            [
                "ffmpeg", "-v", "error", "-c:v", "libvpx-vp9", "-i", str(source),
                "-an", "-fps_mode", "passthrough", "-f", "rawvideo",
                "-pix_fmt", "bgra", "-",
            ],
            stdout=subprocess.PIPE,
        )
        try:
            result = subprocess.run(
                [encoder, str(encoded), str(FRAME_WIDTH), str(FRAME_HEIGHT), str(FRAME_RATE)],
                stdin=decoder.stdout, timeout=1800,
            )
            decoder.stdout.close()
            if decoder.wait(timeout=60) != 0:
                fail(f"{source.name}: ffmpeg decode failed")
            if result.returncode != 0:
                fail(f"{source.name}: HEVC-alpha encoder failed")
        finally:
            if decoder.poll() is None:
                decoder.kill()
                decoder.wait()
        media = probe(encoded)
        stream = media["streams"][0]
        if stream["codec_name"] != "hevc":
            fail(f"{source.name}: encoder produced {stream['codec_name']}, expected hevc")
        if stream["codec_tag_string"] != "hvc1":
            fail(f"{source.name}: codec tag must be hvc1, found {stream['codec_tag_string']}")
        if (stream["width"], stream["height"]) != (FRAME_WIDTH, FRAME_HEIGHT):
            fail(f"{source.name}: encoded dimensions changed")
        if int(stream["nb_read_frames"]) != frames:
            fail(f"{source.name}: encoded {stream['nb_read_frames']} frames, expected {frames}")
        shutil.move(str(encoded), target)
    return f"{source.stem}: {frames} frames, {target.stat().st_size // 1024} KiB"


def run(force: bool) -> None:
    if platform.system() != "Darwin":
        fail("HEVC-with-alpha encoding needs AVAssetWriter, so it must run on macOS")
    files = sources()
    requested = json.loads(os.environ.get("ANIMATIONS", "[]"))
    if requested:
        known = {path.stem for path in files}
        unknown = [name for name in requested if name not in known]
        if unknown:
            fail(f"unknown animations: {', '.join(unknown)}")
        files = [path for path in files if path.stem in requested]
    MOV_DIR.mkdir(exist_ok=True)
    assets = load_assets()
    animations = assets.setdefault("animations", {})
    if not force:
        files = [path for path in files
                 if needs_encoding(path, MOV_DIR / f"{path.stem}.mov", animations.get(path.stem))]
    print(f"encoding {len(files)} of the committed animations", flush=True)
    if not files:
        return
    jobs = max(1, int(os.environ.get("MOV_JOBS", "0") or max(2, (os.cpu_count() or 4) // 2)))
    with ThreadPoolExecutor(max_workers=jobs) as executor:
        futures = [(executor.submit(encode, path, MOV_DIR / f"{path.stem}.mov"), path) for path in files]
        for index, (future, path) in enumerate(futures, start=1):
            print(f"[{index}/{len(files)}] {future.result()}", flush=True)
            animations.setdefault(path.stem, {})["mov"] = sha256(path)
            save_assets(assets)


def self_check() -> None:
    files = sources()
    total = 0
    for path in files:
        total += validate_source(path)
    print(f"ok: {len(files)} VP9-alpha WebM, {total} frames, {FRAME_WIDTH}x{FRAME_HEIGHT} @ {FRAME_RATE} fps")
    if platform.system() != "Darwin":
        print("note: MOV encoding is unavailable off macOS; webm/ assets are still valid")


def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "self-check":
        self_check()
    elif command == "run":
        run("--force" in sys.argv[2:])
    else:
        fail("usage: python3 scripts/build-mov.py self-check|run [--force]")


if __name__ == "__main__":
    main()
