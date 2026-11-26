"""Sound effects for a Resolve edit from sfx-kit (wyzowl/sfx-kit, CC0: 320 sounds with timing data).

  python sfx.py install                      fetch the kit into ~/.harv/tools/sfx-kit (pinned commit, ~120 MB)
  python sfx.py find <words> [--fits S] [--voice] [-n 8]
      sounds for a moment ("slide in", "title slam", "success"); --fits: the move's length in seconds;
      --voice: the sound sits under speech (prefers soft ones, gives the quieter level)
  python sfx.py place <id> --at <seconds> --fps <rate> [--start-frame F] [--voice]
      where the clip goes so its sync point lands on the moment: recordFrame, the file, the volume
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):  # UTF-8 output on Windows too (harv/dev-rules.md rule 12)
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

KIT = Path.home() / ".harv" / "tools" / "sfx-kit"
REPO = "https://github.com/wyzowl/sfx-kit"
# The commit Harv reviewed (2026-11-16): data only, CC0. The full hash: a short one would pick a
# branch or tag of that name first (the full review, R16).
PIN = "92780e7ab0cdfb557497a988089c47f46e8c7412"


def load() -> list[dict]:
    meta = KIT / "sounds.json"
    if not meta.exists():
        sys.exit(f"sfx-kit isn't installed at {KIT}: run `python {Path(__file__).name} install` (free, CC0, ~120 MB).")
    data = json.loads(meta.read_text(encoding="utf-8"))
    return data["sounds"] if isinstance(data, dict) else data


def install() -> None:
    def head_now() -> str:
        return subprocess.run(["git", "-C", str(KIT), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()

    if (KIT / "sounds.json").exists():
        head = head_now()
        # An existing kit counts only at the reviewed commit (any version said "already installed": R16).
        if head != PIN:
            sys.exit(f"sfx-kit at {KIT} is at {head[:7]}, not the reviewed {PIN[:7]}: review the change before using it.")
        print(f"already installed at {KIT} ({PIN[:7]})")
        return
    KIT.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "clone", "--quiet", "--depth", "1", REPO, str(KIT)], check=True)
    head = head_now()
    if head != PIN:
        # Only the reviewed version: a newer one gets a new review first.
        subprocess.run(["git", "-C", str(KIT), "fetch", "--quiet", "--depth", "1", "origin", PIN], check=False)
        if subprocess.run(["git", "-C", str(KIT), "checkout", "--quiet", PIN], capture_output=True).returncode != 0:
            sys.exit(f"sfx-kit has moved on to {head}, which Harv hasn't reviewed (pinned {PIN}). Left it at {KIT}; review the change before using it.")
    print(f"installed at {KIT} ({PIN[:7]}): {len(load())} sounds")


WORD = re.compile(r"[a-z0-9]+")


def words(s: object) -> set[str]:
    return set(WORD.findall(str(s).lower()))


def score(s: dict, query: set[str], fits: float | None, voice: bool) -> float:
    text = {
        "id": words(s.get("id")),
        "name": words(s.get("name")),
        "use": words(" ".join(s.get("use_for") or [])),
        "tags": words(" ".join(s.get("tags") or [])),
        "desc": words(s.get("description")),
        "avoid": words(" ".join(s.get("avoid_for") or [])),
    }
    pts = 0.0
    for q in query:
        if len(q) <= 3 and q not in ("pop", "zip", "hit", "low", "big"):
            pts += 0.5 * (q in text["id"])  # "in", "out", "a": only a tie-breaker
            continue
        pts += 3 * (q in text["id"]) + 2 * (q in text["use"]) + 2 * (q in text["tags"]) + (q in text["name"]) + 0.5 * (q in text["desc"])
        pts -= 1.5 * (q in text["avoid"])
    if pts <= 0:
        return 0
    lo_hi = s.get("fits_seconds")
    if fits is not None and isinstance(lo_hi, list) and len(lo_hi) == 2:
        pts += 3 if lo_hi[0] <= fits <= lo_hi[1] else -2
    if voice:
        tier = ((s.get("level") or {}).get("tier") or "").lower()
        avoid = " ".join(s.get("avoid_for") or []).lower()
        pts += 1.5 if tier == "soft" else (-2 if tier == "hard" else 0)
        pts -= 3 if "speech" in avoid or "voice" in avoid else 0
    return pts


def volume(s: dict, voice: bool) -> float:
    """dB for Resolve's AudioVolume: 0 = as the kit made it; under speech the kit's own offset."""
    return float(s.get("under_voiceover_db") or -6) if voice else 0.0


def find(args: argparse.Namespace) -> None:
    sounds = load()
    query = words(" ".join(args.words))
    ranked = sorted(((score(s, query, args.fits, args.voice), s) for s in sounds), key=lambda x: -x[0])
    hits = [s for p, s in ranked if p > 0][: args.n]
    if not hits:
        print("no match: read catalogue.md in the kit (one line per sound) or GUIDE.md's table of moments")
        return
    for s in hits:
        sync = s.get("sync") or {}
        fit = s.get("fits_seconds")
        print(
            f"{s['id']}  {s.get('duration', 0):.2f}s  sync {sync.get('at', 0):.3f}s ({sync.get('meets', '?')})"
            f"{f'  fits {fit[0]}-{fit[1]}s' if isinstance(fit, list) else ''}  vol {volume(s, args.voice):+.0f} dB"
            f"\n    {s.get('description', '')}  use: {', '.join((s.get('use_for') or [])[:3])}"
        )


def place(args: argparse.Namespace) -> None:
    s = next((x for x in load() if x["id"] == args.id), None)
    if not s:
        sys.exit(f"no sound '{args.id}' (use find)")
    at = float((s.get("sync") or {}).get("at") or 0)
    first = round((args.at - at) * args.fps)
    if first < 0:
        sys.exit(f"the sound's sync point is {at:.3f}s in: the moment must be at least that far into the timeline")
    out = {
        "file": str(KIT / s["file"]),
        "recordFrame": args.start_frame + first,
        "frames": max(1, round(float(s.get("duration") or 0) * args.fps)),
        "AudioVolume": volume(s, args.voice),
        "sync": (s.get("sync") or {}).get("how", ""),
    }
    print(json.dumps(out, indent=1))


OPENVERSE = "https://api.openverse.org/v1/audio/"
SOUNDS = Path.home() / ".harv" / "workspace" / "sounds"
# Openverse asks automated clients to name themselves: a generic name, nothing about the user.
UA = {"User-Agent": "harv-sfx/1.0"}


def fetch_json(url: str) -> dict:
    import urllib.request

    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def real(args: argparse.Namespace) -> None:
    """Real recordings (rain, a street, a door) from Openverse: CC0, or CC BY with credit. No key, ~200 searches a day."""
    from urllib.parse import urlencode

    q = urlencode({"q": " ".join(args.words), "license": "cc0" if args.cc0 else "cc0,by", "page_size": args.n * 2})
    try:
        data = fetch_json(f"{OPENVERSE}?{q}")
    except OSError as e:
        sys.exit(f"Openverse didn't answer ({e}); try again later or use the kit (find).")
    shown = 0
    for r in data.get("results", []):
        secs = (r.get("duration") or 0) / 1000
        if args.max_seconds and secs > args.max_seconds:
            continue
        print(f"{r['id']}  {secs:.1f}s  {r['license']} {r.get('license_version') or ''}  {r.get('title', '')[:60]}  by {r.get('creator', '?')}")
        shown += 1
        if shown >= args.n:
            break
    if not shown:
        print("nothing found: try other words (what it sounds like, not what it's for)")


def get(args: argparse.Namespace) -> None:
    """Downloads one Openverse sound into ~/.harv/workspace/sounds and writes its credit line."""
    import urllib.request

    if not re.fullmatch(r"[0-9a-f-]{36}", args.id):
        sys.exit("give the id that `real` printed")
    r = fetch_json(f"{OPENVERSE}{args.id}/")
    lic = (r.get("license") or "").lower()
    if lic not in ("cc0", "by", "pdm"):
        sys.exit(f"its licence is {lic}: Harv uses only CC0, CC BY and public domain sounds")
    SOUNDS.mkdir(parents=True, exist_ok=True)
    slug = re.sub(r"[^\w-]+", "-", (r.get("title") or "sound").lower()).strip("-")[:40] or "sound"
    # Openverse's answer is outside text: an https address only (urllib opens file:// too), a plain
    # extension, and at most ~50 MB read (the full review, R16).
    url = str(r.get("url") or "")
    if not url.lower().startswith("https://"):
        sys.exit(f"the sound's address isn't https: {url[:80]}")
    ext = str(r.get("filetype") or "mp3").lower()
    if not re.fullmatch(r"[a-z0-9]{2,4}", ext):
        sys.exit(f"odd file type: {ext[:20]}")
    out = SOUNDS / f"{slug}-{args.id[:8]}.{ext}"
    limit = 50 * 1024 * 1024
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as src:
        data = src.read(limit + 1)
    if len(data) > limit:
        sys.exit("the sound is over 50 MB: not downloaded")
    out.write_bytes(data)
    credit = f"\"{r.get('title')}\" by {r.get('creator')} ({r.get('foreign_landing_url')}), {r.get('license').upper()} {r.get('license_version') or ''}".strip()
    credits = SOUNDS / "credits.txt"
    old = credits.read_text(encoding="utf-8") if credits.exists() else ""
    if credit not in old:
        credits.write_text(old + credit + "\n", encoding="utf-8")
    need = "needs this credit in the video's description" if lic == "by" else "no credit needed"
    print(json.dumps({"file": str(out), "license": lic, "credit": credit, "note": need, "credits_file": str(credits)}, indent=1))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("install")
    f = sub.add_parser("find")
    f.add_argument("words", nargs="+")
    f.add_argument("--fits", type=float)
    f.add_argument("--voice", action="store_true")
    f.add_argument("-n", type=int, default=8)
    p = sub.add_parser("place")
    p.add_argument("id")
    p.add_argument("--at", type=float, required=True, help="the moment, in seconds from the timeline's start")
    p.add_argument("--fps", type=float, required=True)
    p.add_argument("--start-frame", type=int, default=0, help="timeline:GetStartFrame() (usually 86400 at 24 fps)")
    p.add_argument("--voice", action="store_true")
    r = sub.add_parser("real", help="real recordings from Openverse (CC0 / CC BY)")
    r.add_argument("words", nargs="+")
    r.add_argument("--cc0", action="store_true", help="only sounds that need no credit")
    r.add_argument("--max-seconds", type=float)
    r.add_argument("-n", type=int, default=8)
    g = sub.add_parser("get", help="download one Openverse sound by id")
    g.add_argument("id")
    args = ap.parse_args()
    {"install": lambda: install(), "find": lambda: find(args), "place": lambda: place(args), "real": lambda: real(args), "get": lambda: get(args)}[args.cmd]()


if __name__ == "__main__":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    main()
