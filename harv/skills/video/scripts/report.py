"""Render a video report: one self-contained HTML page in Harv's look (the idea from video-lens,
kar2phi/video-lens, MIT: you write a small JSON, a fixed renderer makes the page, so no HTML is
written by hand and nothing in the video's text can turn into markup).

  python report.py <payload.json> [--out-dir ~/.harv/workspace/videos]
Saves <out-dir>/<id>.html and prints its path. Pictures are embedded (Harv's preview can't load
local files): when watch.py made frames for this id, each outline entry shows the nearest frame.

Payload (UTF-8 JSON):
{
  "id": "abcDEF12345",              # the same id as the transcript or watch file
  "title": "...", "by": "...", "length": 62, "link": "https://...",   # length in seconds
  "summary": "2-4 sentences.",
  "takeaway": "1-3 sentences the summary doesn't say.",
  "key_points": [{"point": "...", "why": "...", "t": 125}],          # t optional; **bold** allowed
  "outline": [{"t": 0, "title": "...", "detail": "one sentence"}],
  "language": "en"                  # optional, the page's language
}
"""

from __future__ import annotations

import argparse
import base64
import html
import json
import re
import subprocess
import sys
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):  # UTF-8 output on Windows too (harv/dev-rules.md rule 12)
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

HOME = Path.home()


def mmss(s: float) -> str:
    s = int(s)
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


def esc(text: object) -> str:
    return html.escape(str(text or ""), quote=True)


def inline(text: object) -> str:
    """Escaped text with **bold** and *italic*, nothing else."""
    t = esc(text)
    t = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", t)
    return re.sub(r"(?<![*\w])\*(?!\s)(.+?)(?<!\s)\*(?![*\w])", r"<em>\1</em>", t)


def jump(link: str, t: float | None) -> str | None:
    """A link that opens the video at t, where the site supports it."""
    if t is None or not link:
        return None
    m = re.search(r"(?:youtube\.com/(?:watch\?v=|shorts/)|youtu\.be/)([\w-]{6,})", link)
    if m:
        return f"https://www.youtube.com/watch?v={m[1]}&t={int(t)}s"
    if "vimeo.com/" in link:
        return f"{link.split('#')[0]}#t={int(t)}s"
    return None


def frames_of(folder: Path) -> list[tuple[float, Path]]:
    out = []
    for f in sorted(folder.glob("frame-*.jpg")):
        m = re.search(r"-(\d+)m(\d\d)s\.jpg$", f.name)
        if m:
            out.append((int(m[1]) * 60 + int(m[2]), f))
    return out


def thumb(path: Path) -> str:
    """A small JPEG as a data URI (ffmpeg shrinks it when there is one; else the file as is)."""
    data = path.read_bytes()
    try:
        from watch import find_ffmpeg  # the same lookup (winget's folder on Windows)

        p = subprocess.run(
            [find_ffmpeg(), "-hide_banner", "-loglevel", "error", "-i", str(path), "-vf", "scale=320:-2", "-q:v", "5", "-f", "mjpeg", "-"],
            capture_output=True,
            timeout=20,
        )
        if p.returncode == 0 and p.stdout:
            data = p.stdout
    except (OSError, subprocess.SubprocessError, ImportError, SystemExit):
        pass
    return "data:image/jpeg;base64," + base64.b64encode(data).decode()


CSS = """
:root{--bg:#0a1018;--glass:rgba(16,24,34,.72);--line:rgba(255,255,255,.1);--ink:#dfe7ef;--muted:#8a99a8;--accent:#A8C8E8;--amber:#F2B880}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1200px 600px at 20% -10%,#1a2a3a 0%,var(--bg) 60%) fixed;color:var(--ink);
font:14px/1.6 'IBM Plex Mono',ui-monospace,Consolas,monospace}
main{max-width:980px;margin:0 auto;padding:28px 18px 60px}
.meta{color:var(--muted);font-size:12px}
h1{font-size:22px;line-height:1.3;margin:6px 0 4px;font-weight:600}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
h2{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:30px 0 10px;font-weight:500}
.panel{background:var(--glass);border:1px solid var(--line);border-radius:12px;padding:16px 18px;backdrop-filter:blur(22px)}
.take{border-left:3px solid var(--amber)}
.take h2{color:var(--amber);margin:0 0 6px}
ol.points{margin:0;padding-left:22px}ol.points li{margin:0 0 12px}ol.points li:last-child{margin:0}
.why{color:var(--muted);display:block;margin-top:2px}
.t{color:var(--accent);font-size:12px;white-space:nowrap}
.outline{display:flex;flex-direction:column;gap:6px}
details{background:var(--glass);border:1px solid var(--line);border-radius:10px;overflow:hidden}
summary{list-style:none;cursor:pointer;display:flex;gap:14px;align-items:baseline;padding:9px 14px}
summary::-webkit-details-marker{display:none}
summary:hover{background:rgba(168,200,232,.06)}
summary .t{min-width:56px}
details[open] summary{border-bottom:1px solid var(--line)}
.body{display:flex;gap:14px;padding:10px 14px 12px;align-items:flex-start}
.body img{max-width:200px;max-height:220px;border-radius:6px;border:1px solid var(--line);flex:none}
.body p{margin:0;color:#c6d1dc}
footer{margin-top:34px;color:var(--muted);font-size:11px}
@media (max-width:600px){.body{flex-direction:column}.body img{max-width:100%;max-height:320px}h1{font-size:19px}}
"""


def render(p: dict, folder: Path | None) -> str:
    link = str(p.get("link") or "")
    frames = frames_of(folder) if folder and folder.is_dir() else []
    length = float(p.get("length") or 0)

    def stamp(t: object) -> str:
        if not isinstance(t, (int, float)):
            return ""
        href = jump(link, float(t))
        label = esc(mmss(float(t)))
        return f'<a class="t" href="{esc(href)}" target="_blank" rel="noopener">{label}</a>' if href else f'<span class="t">{label}</span>'

    meta = " · ".join(x for x in [esc(p.get("by")), esc(mmss(length)) if length else "", esc(p.get("date"))] if x)
    out = [
        "<!doctype html>",
        f'<html lang="{esc(p.get("language") or "en")}"><head><meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width,initial-scale=1">',
        f"<title>{esc(p.get('title') or 'Video')}</title>",
        # No web font: the page is fully self-contained (IBM Plex Mono when installed, else the system's monospace).
        f"<style>{CSS}</style></head><body><main>",
        f'<div class="meta">{meta}</div>',
        f"<h1>{esc(p.get('title') or 'Video')}</h1>",
    ]
    if link:
        out.append(f'<a href="{esc(link)}" target="_blank" rel="noopener">Open the video ↗</a>')
    out += ["<h2>Summary</h2>", f'<div class="panel">{inline(p.get("summary"))}</div>']
    if p.get("takeaway"):
        out.append(f'<div class="panel take" style="margin-top:18px"><h2>Takeaway</h2>{inline(p["takeaway"])}</div>')
    points = p.get("key_points") or []
    if points:
        out += ["<h2>Key points</h2>", '<div class="panel"><ol class="points">']
        for k in points:
            t = stamp(k.get("t")) if "t" in k else ""
            why = f'<span class="why">{inline(k.get("why"))}</span>' if k.get("why") else ""
            out.append(f"<li>{inline(k.get('point'))} {t}{why}</li>")
        out.append("</ol></div>")
    outline = p.get("outline") or []
    if outline:
        out += ["<h2>Outline</h2>", '<div class="outline">']
        for i, o in enumerate(outline):
            t = float(o.get("t") or 0)
            pic = ""
            if frames:
                nearest = min(frames, key=lambda f: abs(f[0] - t))
                pic = f'<img src="{thumb(nearest[1])}" alt="">'
            out.append(
                f"<details{' open' if i == 0 else ''}><summary>{stamp(t)}<span>{esc(o.get('title'))}</span></summary>"
                f'<div class="body">{pic}<p>{inline(o.get("detail"))}</p></div></details>'
            )
        out.append("</div>")
    out.append(f"<footer>Made by Harv from the video's {'speech and frames' if frames else 'transcript'}.</footer>")
    out.append("</main></body></html>")
    return "\n".join(out)


def check(p: dict) -> list[str]:
    errors = []
    for key in ("id", "title", "summary"):
        if not p.get(key):
            errors.append(f"'{key}' is missing")
    if p.get("id") and not re.fullmatch(r"[\w-]{1,80}", str(p["id"])):
        errors.append("'id' may only have letters, digits, - and _")
    # The link becomes a clickable href: a javascript: or data: one copied from outside text would run (K29).
    if p.get("link") and not re.match(r"https?://", str(p["link"]), re.I):
        errors.append("'link' must start with http:// or https://")
    times = [o.get("t") for o in p.get("outline") or []]
    if any(not isinstance(t, (int, float)) for t in times):
        errors.append("every outline entry needs a number 't' (seconds)")
    elif times != sorted(times):
        errors.append("outline times must go up")
    length = p.get("length")
    if isinstance(length, (int, float)) and length and any(t > length + 1 for t in times if isinstance(t, (int, float))):
        errors.append("an outline time is past the video's end")
    return errors


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("payload")
    ap.add_argument("--out-dir", default=str(HOME / ".harv" / "workspace" / "videos"))
    args = ap.parse_args()
    try:
        p = json.loads(Path(args.payload).read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        sys.exit(f"Couldn't read the payload: {e}")
    errors = check(p)
    if errors:
        sys.exit("Fix the payload: " + "; ".join(errors))
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{p['id']}.html"
    path.write_text(render(p, out_dir / str(p["id"])), encoding="utf-8", newline="\n")
    print(path)


if __name__ == "__main__":
    main()
