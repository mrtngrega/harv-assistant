"""Colour correction LUTs for a Resolve edit from color-grade-ai (isaacrowntree/color-grade-ai, MIT):
it measures a frame or a clip (exposure, white balance, skin, saturation), fits a correction by trying
it and measuring again, and writes a .cube LUT. No model, nothing leaves the computer.

  python grade.py install                       fetch the reviewed version into ~/.harv/tools/color-grade-ai
  python grade.py type <frame.png>              log or display-referred Rec.709? (say so before grading)
  python grade.py fix <frame.png|clip> -o <out.cube> [--log]
                                                a correction LUT for a frame (or ~12 frames of a clip)
  python grade.py match <reference.png> <shot.png> -o <out.cube>
                                                make shot look like reference
  python grade.py report <frame.png>            what's wrong with the frame, per node (no LUT)
Needs Ruby (it bakes the LUT) and ffmpeg (for clips). Prints the LUT's path.
"""

from __future__ import annotations

import glob
import os
import shutil
import subprocess
import sys
import venv
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):  # UTF-8 output on Windows too (harv/dev-rules.md rule 12)
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

TOOL = Path.home() / ".harv" / "tools" / "color-grade-ai"
REPO = "https://github.com/isaacrowntree/color-grade-ai"
# The commit Harv reviewed (2026-11-16): local maths only, no network. The full hash: a short one
# would pick a branch or tag of that name first (the full review, R16).
PIN = "a6eef94e0d773b1a9475cd9bac8bc15bc3944f46"
PY = TOOL / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def env() -> dict[str, str]:
    """PATH with Ruby and ffmpeg, which a server started before their install may not have."""
    extra: list[str] = []
    if os.name == "nt":
        extra += sorted(glob.glob("C:/Ruby*-x64/bin"))[-1:]
        local = os.environ.get("LOCALAPPDATA", "")
        extra += sorted(glob.glob(os.path.join(local, "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg*", "*", "bin")))[-1:]
    e = dict(os.environ)
    e["PATH"] = os.pathsep.join([*extra, e.get("PATH", "")])
    e["PYTHONIOENCODING"] = "utf-8"
    return e


def install() -> None:
    if not (TOOL / "auto_grade.py").exists():
        TOOL.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "clone", "--quiet", REPO, str(TOOL)], check=True)
    subprocess.run(["git", "-C", str(TOOL), "checkout", "--quiet", PIN], check=True)
    if not PY.exists():
        venv.create(TOOL / ".venv", with_pip=True)
    subprocess.run([str(PY), "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "numpy", "pillow"], check=True)
    missing = [t for t in ("ruby", "ffmpeg") if not shutil.which(t, path=env()["PATH"])]
    note = f" (still missing: {', '.join(missing)})" if missing else ""
    print(f"color-grade-ai ready at {TOOL} ({PIN[:7]}){note}")


def run(script: str, *args: str) -> None:
    if not PY.exists():
        sys.exit(f"color-grade-ai isn't installed: run `python {Path(__file__).name} install` (free, MIT).")
    if not shutil.which("ruby", path=env()["PATH"]):
        sys.exit("Ruby isn't installed (it writes the LUT): Windows `winget install RubyInstallerTeam.Ruby.4.0`, Fedora `sudo dnf install ruby`.")
    p = subprocess.run([str(PY), "-s", str(TOOL / script), *args], cwd=TOOL, env=env())
    sys.exit(p.returncode)


def main() -> None:
    a = sys.argv[1:]
    if not a or a[0] in ("-h", "--help"):
        print(__doc__)
        return
    cmd, rest = a[0], a[1:]
    out = rest[rest.index("-o") + 1] if "-o" in rest else None
    rest = [x for i, x in enumerate(rest) if x != "-o" and (i == 0 or rest[i - 1] != "-o")]
    log = "--log" in rest
    rest = [x for x in rest if x != "--log"]
    if cmd == "install":
        install()
    elif cmd == "type" and len(rest) == 1:
        run("footage_type.py", os.path.abspath(rest[0]))
    elif cmd == "report" and len(rest) == 1:
        run("auto_grade.py", os.path.abspath(rest[0]))
    elif cmd == "fix" and len(rest) == 1 and out:
        src = os.path.abspath(rest[0])
        transfer = ["--transfer", "log" if log else "display"]
        if src.lower().endswith((".png", ".jpg", ".jpeg", ".tif", ".tiff")):
            run("auto_grade.py", src, "--emit", os.path.abspath(out), *transfer)
        else:
            # A clip keeps --log too (it was dropped here and log footage was guessed: R16).
            run("sample_clip.py", src, "--emit", os.path.abspath(out), *transfer)
    elif cmd == "match" and len(rest) == 2 and out:
        run("match_grade.py", os.path.abspath(rest[0]), os.path.abspath(rest[1]), "--emit", os.path.abspath(out))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
