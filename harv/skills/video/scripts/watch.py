"""Watch a short video (a reel, a TikTok, a short clip) the way a person would: download it, take
frames from it and pull its sound out, so its pictures, on-screen text and speech can be read even
when it has no subtitles or caption. For long videos with captions, transcript.py is cheaper.

Uses yt-dlp from ~/.harv/tools/yt-dlp (see transcript.py) and ffmpeg (on PATH, or winget's
Gyan.FFmpeg on Windows; RPM Fusion's on Fedora). Nothing is logged in to: a video that needs a
login is refused, never fetched with browser cookies.

  python watch.py <url> [--frames 12] [--out-dir ~/.harv/workspace/videos] [--max-minutes 15]
Saves <out-dir>/<id>/ with video.mp4, audio.wav (16 kHz mono, for the transcribe tool), frames
frame-01-0m05s.jpg ... and sheet.jpg (all frames on one picture), plus <out-dir>/<id>.md with the
title, caption and the list of files. Prints the .md path; read it for what to do next.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):  # UTF-8 output on Windows too (harv/dev-rules.md rule 12)
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

HOME = Path.home()
YTDLP = HOME / ".harv" / "tools" / "yt-dlp" / ("Scripts/yt-dlp.exe" if os.name == "nt" else "bin/yt-dlp")


def find_ffmpeg() -> str:
    found = shutil.which("ffmpeg")
    if found:
        return found
    if os.name == "nt":
        # winget puts it here; a server started before the install doesn't have it on PATH yet.
        local = os.environ.get("LOCALAPPDATA", "")
        hits = sorted(glob.glob(os.path.join(local, "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg*", "*", "bin", "ffmpeg.exe")))
        if hits:
            return hits[-1]
    sys.exit("ffmpeg isn't installed: on Windows `winget install Gyan.FFmpeg`, on Fedora `sudo dnf install ffmpeg` (RPM Fusion). Install it on Windows and say so; on Fedora ask the user (sudo needs their password).")


def ytdlp(args: list[str]) -> str:
    if not YTDLP.exists():
        sys.exit(f"yt-dlp isn't installed at {YTDLP}: make the venv and pip install yt-dlp there, then say you installed it.")
    p = subprocess.run([str(YTDLP), "--no-progress", "--no-warnings", *args], capture_output=True, text=True, encoding="utf-8")
    if p.returncode != 0:
        last = p.stderr.strip().splitlines()[-1] if p.stderr.strip() else str(p.returncode)
        if "login" in last.lower() or "cookies" in last.lower():
            sys.exit(f"This video needs a login to watch ({last}). Harv never uses browser cookies: say so and work from what the link shows.")
        sys.exit(f"yt-dlp failed: {last}")
    return p.stdout


def ff(ffmpeg: str, args: list[str]) -> bool:
    return subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *args], capture_output=True).returncode == 0


def stamp(s: float) -> str:
    s = int(s)
    return f"{s // 60}m{s % 60:02d}s"


def mmss(s: float) -> str:
    s = int(s)
    return f"{s // 60}:{s % 60:02d}"


def probe(ffmpeg: str, video: Path) -> tuple[float, int, int, bool]:
    """(duration, width, height, has sound) read from ffmpeg's own report (no ffprobe needed)."""
    p = subprocess.run([ffmpeg, "-hide_banner", "-i", str(video)], capture_output=True, text=True, encoding="utf-8", errors="replace")
    text = p.stderr
    d = re.search(r"Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)", text)
    dur = int(d[1]) * 3600 + int(d[2]) * 60 + float(d[3]) if d else 0.0
    v = re.search(r"Stream #.*Video:.*?(\d{2,5})x(\d{2,5})", text)
    w, h = (int(v[1]), int(v[2])) if v else (0, 0)
    return dur, w, h, "Audio:" in text


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("url")
    ap.add_argument("--frames", type=int, default=12, help="how many frames, spread evenly (4 to 24)")
    ap.add_argument("--out-dir", default=str(HOME / ".harv" / "workspace" / "videos"))
    ap.add_argument("--max-minutes", type=float, default=15, help="refuse longer videos (use transcript.py for those)")
    ap.add_argument("--keep-video", action="store_true", help="keep video.mp4 (by default it goes once frames and sound are out)")
    args = ap.parse_args()
    n = max(4, min(24, args.frames))
    ffmpeg = find_ffmpeg()

    info = json.loads(ytdlp(["-J", "--skip-download", "--no-playlist", args.url]))
    if info.get("_type") == "playlist":
        entries = [e for e in info.get("entries") or [] if e]
        if not entries:
            sys.exit("The link is a post with no video in it.")
        info = entries[0]
    length = float(info.get("duration") or 0)
    if length and length > args.max_minutes * 60:
        sys.exit(f"The video is {mmss(length)} long: use transcript.py for its words, or pass --max-minutes to watch it anyway.")

    vid = str(info.get("id") or "video")
    folder = Path(args.out_dir) / vid
    folder.mkdir(parents=True, exist_ok=True)
    for old in folder.glob("frame-*.jpg"):
        old.unlink()
    video = folder / "video.mp4"
    if not video.exists():
        ytdlp([
            "--no-playlist", "-f", "bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b", "--merge-output-format", "mp4",
            "--ffmpeg-location", str(Path(ffmpeg).parent), "-o", str(folder / "video.%(ext)s"), info.get("webpage_url") or args.url,
        ])
        got = sorted(folder.glob("video.*"))
        if not got:
            sys.exit("yt-dlp downloaded nothing.")
        if got[0] != video:
            got[0].rename(video)

    dur, w, h, sound = probe(ffmpeg, video)
    dur = dur or length
    if not dur:
        sys.exit("Couldn't read the video's length.")

    # Frames spread evenly, each from the middle of its slice; wide enough to read on-screen text.
    frames: list[tuple[float, str]] = []
    width = 720 if h > w else 960
    for i in range(n):
        t = dur * (i + 0.5) / n
        name = f"frame-{i + 1:02d}-{stamp(t)}.jpg"
        if ff(ffmpeg, ["-ss", f"{t:.2f}", "-i", str(video), "-frames:v", "1", "-vf", f"scale={width}:-2", "-q:v", "3", str(folder / name)]):
            frames.append((t, name))

    # One overview picture: every frame small, in reading order.
    sheet = folder / "sheet.jpg"
    cols, cell = (6, 240) if h > w else (4, 360)
    if frames:
        inputs: list[str] = []
        for _, name in frames:
            inputs += ["-i", str(folder / name)]
        # Every cell the same size (xstack needs absolute offsets), from the video's aspect.
        ch = int(round(cell * (h / w) / 2) * 2) if w else cell
        scaled = "".join(f"[{i}:v]scale={cell}:{ch},setsar=1[f{i}];" for i in range(len(frames)))
        pad = "".join(f"[f{i}]" for i in range(len(frames)))
        layout = "|".join(f"{(i % cols) * cell}_{(i // cols) * ch}" for i in range(len(frames)))
        graph = f"{scaled}{pad}xstack=inputs={len(frames)}:layout={layout}:fill=black" if len(frames) > 1 else f"[0:v]scale={cell}:-2"
        if not ff(ffmpeg, [*inputs, "-filter_complex", graph, "-frames:v", "1", "-q:v", "3", str(sheet)]):
            sheet = None  # type: ignore[assignment]

    audio = folder / "audio.wav"
    if sound:
        if not ff(ffmpeg, ["-i", str(video), "-vn", "-ac", "1", "-ar", "16000", str(audio)]):
            sound = False

    caption = (info.get("description") or "").strip()
    lines = [
        f"# {info.get('title') or 'Untitled'}",
        "",
        f"- By: {info.get('uploader') or info.get('channel') or '?'}",
        f"- Length: {mmss(dur)} · {w}x{h}",
        f"- Uploaded: {info.get('upload_date', '?')}",
        f"- Link: {info.get('webpage_url', args.url)}",
        f"- Folder: {folder}",
        "",
        "## Caption",
        "",
        caption or "(no caption)",
        "",
        "## Frames",
        "",
        f"- Overview: {sheet} ({cols} across, in order)" if sheet else "- Overview: (couldn't make one)",
    ]
    lines += [f"- [{mmss(t)}] {folder / name}" for t, name in frames]
    lines += ["", "## Speech", ""]
    lines += [f"Run the transcribe tool on {audio} and paste its text here (format srt for times)." if sound else "The video has no sound track."]
    md = Path(args.out_dir) / f"{vid}.md"
    md.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    # Shared reels are watched in the background: the full video (up to 1080p) isn't kept, and an old
    # reel's sound goes after 30 days (its .md, frames and report stay) (the full review, K27).
    if not args.keep_video:
        video.unlink(missing_ok=True)
    sweep(Path(args.out_dir), keep=folder)
    print(f"{md}  ({mmss(dur)}, {len(frames)} frames, {'sound' if sound else 'no sound'})")


def sweep(out_dir: Path, keep: Path, days: int = 30) -> None:
    """Big files of reels watched over `days` ago: video.mp4 and audio.wav (the notes and frames stay)."""
    import time

    cutoff = time.time() - days * 86400
    for big in [*out_dir.glob("*/video.mp4"), *out_dir.glob("*/audio.wav")]:
        try:
            if big.parent != keep and big.stat().st_mtime < cutoff:
                big.unlink()
        except OSError:
            pass


if __name__ == "__main__":
    main()
