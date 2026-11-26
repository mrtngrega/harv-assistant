"""Harv's ears: earshot (Leonxlnx/earshot, MIT) judges sound Harv can't hear, on this computer's CPU.

  python ears.py install          the reviewed earshot into ~/.harv/tools/earshot (venv, CPU PyTorch, its two
                                  pinned listening models: about 2 GB, once)
  python ears.py <command> ...    runs earshot: rank, find, describe, realness, ab, match, compare, measure,
                                  timeline, sheet, critique, sfx, kit, doctor (see earshot's own --help)

Never the `llm` command (it uploads the sound to Google with an API key) or `mcp`; this wrapper refuses both.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):  # UTF-8 output on Windows too (harv/dev-rules.md rule 12)
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

HOME = Path.home() / ".harv" / "tools" / "earshot"
SRC = HOME / "src"
VENV = HOME / "venv"
CACHE = HOME / "cache"
REPO = "https://github.com/Leonxlnx/earshot"
# The commit Harv reviewed (2026-11-18, earshot 0.4.1): network only for its two pinned safetensors models,
# subprocess only ffmpeg/ffprobe, no telemetry. The full hash (a short one could pick a branch of that name).
PIN = "4ac3d2ac2b151e1c23376f9ce7f3047a17050013"
REFUSED = {"llm": "uploads the sound to Google Gemini with an API key: Harv never does", "mcp": "Harv runs earshot as a command, not as a server"}


def bin_dir() -> Path:
    return VENV / ("Scripts" if os.name == "nt" else "bin")


def env() -> dict[str, str]:
    e = dict(os.environ)
    e["EARSHOT_HOME"] = str(CACHE)  # its caches and models live with it, not in ~/.cache
    e.setdefault("EARSHOT_THREADS", "3")  # leave the rest of the CPU to the user
    return e


def run(cmd: list[str], **kw) -> None:
    subprocess.run(cmd, check=True, env=env(), **kw)


def head() -> str:
    return subprocess.run(["git", "-C", str(SRC), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()


def install() -> None:
    if (SRC / "pyproject.toml").exists():
        if head() != PIN:
            sys.exit(f"earshot at {SRC} is at {head()[:7]}, not the reviewed {PIN[:7]}: review the change before using it.")
    else:
        HOME.mkdir(parents=True, exist_ok=True)
        run(["git", "init", "--quiet", str(SRC)])
        run(["git", "-C", str(SRC), "fetch", "--quiet", "--depth", "1", REPO, PIN])
        run(["git", "-C", str(SRC), "checkout", "--quiet", "FETCH_HEAD"])
        if head() != PIN:
            sys.exit(f"earshot didn't check out at the reviewed {PIN[:7]}; left it at {SRC}.")
    py = bin_dir() / ("python.exe" if os.name == "nt" else "python")
    if not py.exists():
        run([sys.executable, "-m", "venv", str(VENV)])
    run([str(py), "-m", "pip", "install", "--quiet", "--upgrade", "pip"])
    # CPU wheels: no CUDA download, and it never competes with Resolve or a game for the graphics card.
    run([str(py), "-m", "pip", "install", "--quiet", "torch", "--index-url", "https://download.pytorch.org/whl/cpu"])
    run([str(py), "-m", "pip", "install", "--quiet", "-e", str(SRC)])  # no extras: no mcp, no llm
    run([str(py), "-m", "earshot", "doctor", "--fetch"])  # the two pinned models, so it works offline later
    print(f"installed at {HOME} ({PIN[:7]})")


def main(argv: list[str]) -> None:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return
    if argv[0] == "install":
        install()
        return
    if argv[0] in REFUSED:
        sys.exit(f"ears.py: refused `{argv[0]}`: {REFUSED[argv[0]]}.")
    py = bin_dir() / ("python.exe" if os.name == "nt" else "python")
    if not py.exists():
        sys.exit(f"earshot isn't installed: run `python {Path(__file__).name} install` (free, MIT, about 2 GB).")
    if head() != PIN:
        sys.exit(f"earshot at {SRC} isn't the reviewed {PIN[:7]}: review the change before using it.")
    sys.exit(subprocess.run([str(py), "-m", "earshot", *argv], env=env()).returncode)


if __name__ == "__main__":
    main(sys.argv[1:])
