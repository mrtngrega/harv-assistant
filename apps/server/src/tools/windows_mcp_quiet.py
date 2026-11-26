"""Starts Windows-MCP (0.8.8, reviewed) without its own on-screen indicator.

Windows-MCP draws a blue glow around the screen and its own notice pill while it uses the mouse and
keyboard. Harv shows its own pill instead (apps/desktop/src-tauri/src/pill.rs), so two indicators
said the same thing (the user's wish, 2026-11-06: only Harv's). 0.8.8 has no switch for it, and its
control logic waits for the indicator, so this swaps the indicator module for one that draws
nothing and always reports itself shown. It still refuses to act while the user uses the mouse or
keyboard (USER_CONTROL), except for the input that was them talking to Harv (see below), stops when
they move (CONTROL_PREEMPTED), and Ctrl+Alt+Shift+Backspace still takes control back. Its
screenshot flash is off by its own switch (WINDOWS_MCP_DISABLE_FLASH, set by windowsMcp.ts).

Usage (windowsMcp.ts): <venv>/Scripts/python.exe -I windows_mcp_quiet.py serve --transport stdio
"""

import contextlib
import sys

from windows_mcp.desktop import control_overlay as indicator

# Same names and signatures as windows_mcp/desktop/control_overlay.py in 0.8.8; a version bump
# needs a new review of that module before this runs on it.
indicator.start = lambda: None
indicator.stop = lambda: None
indicator.set_active = lambda active, *, generation=None: True
indicator.set_pending = lambda pending, *, generation=None: True
indicator.is_healthy = lambda: True
indicator.suspend_for_capture = contextlib.nullcontext

# The user's own message or Approve click in Harv's window is them talking to Harv, not taking the
# desktop back, yet Windows-MCP waits 10 s after any physical input (USER_CONTROL). Harv writes when
# it last heard from the user (HARV_DESKTOP_GRANT, {"at": epoch ms}); input up to then, and while they
# wait for Harv to start (WAITING), is forgiven once a tool starts. Input after that still counts, and
# the takeover check while Harv acts (CONTROL_PREEMPTED) is untouched. 1.5 s was too short: moving
# the mouse 2 s after sending made the first action wait 10 s (2026-11-10, a live test).
import json  # noqa: E402
import os  # noqa: E402
import time  # noqa: E402

from windows_mcp.desktop.control import ControlCoordinator  # noqa: E402

GRANT = os.environ.get("HARV_DESKTOP_GRANT", "")
WAITING = 15.0  # seconds after the message or Approve: the user waiting for Harv, not using the desktop
FRESH = 300  # an older grant is ignored
QUIET = 10.0  # Windows-MCP's idle wait (control.py)


def _grant_mono() -> float | None:
    """The grant as a time.monotonic() moment, or None."""
    try:
        with open(GRANT, encoding="utf-8") as f:
            at = float(json.load(f)["at"]) / 1000
    except (OSError, ValueError, KeyError, TypeError):
        return None
    age = time.time() - at
    if age < 0 or age > FRESH:
        return None
    return time.monotonic() - age + WAITING


def _forgive(self: ControlCoordinator) -> None:
    bound = _grant_mono() if GRANT else None
    if bound is None:
        return
    with self._lock:
        if self._pressed or self._mouse_down or self._fast_takeover or self._fast_pending or self._emergency:
            return
        last = max(self._last_user, self._last_physical_event)
        if last <= 0 or last > bound:
            return
        # Push the forgiven input back past the idle wait: the next tick sees the user as idle.
        old = time.monotonic() - QUIET - 0.01
        self._last_user = min(self._last_user, old)
        self._last_physical_event = min(self._last_physical_event, old)


_begin_call = ControlCoordinator.begin_call


def begin_call(self: ControlCoordinator, name: str) -> int:
    _forgive(self)
    return _begin_call(self, name)


ControlCoordinator.begin_call = begin_call

# Windows opens new windows on the main monitor, but Harv works on his own (Settings › Works on). After
# an App launch or switch, the window it opened or brought up is moved onto Harv's monitor (the user's
# report note, 2026-11-19): same size if it fits, centred, maximized again if it was. The gate writes
# the monitor to HARV_DESKTOP_PIN right before the call ({"at", "region"}; no region = leave it, e.g.
# the message named another monitor). App's resize mode is Harv placing a window himself: untouched.
import ctypes  # noqa: E402
import re  # noqa: E402

import win32api  # noqa: E402
import win32con  # noqa: E402
import win32gui  # noqa: E402
import win32process  # noqa: E402

from windows_mcp.desktop.service import Desktop  # noqa: E402
from windows_mcp.tools import app as app_module  # noqa: E402

PIN = os.environ.get("HARV_DESKTOP_PIN", "")
PIN_FRESH = 120  # seconds: the gate writes it just before the call
WINDOW_WAIT = 10.0  # seconds a launched program may take to show its window
OWN = {"harv.exe", "harv"}  # Harv's own window is never moved


def _pin_region() -> tuple[int, int, int, int] | None:
    if not PIN:
        return None
    try:
        with open(PIN, encoding="utf-8") as f:
            pin = json.load(f)
        if time.time() - float(pin["at"]) / 1000 > PIN_FRESH:
            return None
        left, top, right, bottom = (int(v) for v in pin["region"])
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return left, top, right, bottom


def _is_own(hwnd: int) -> bool:
    try:
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        from psutil import Process

        return Process(pid).name().lower() in OWN
    except Exception:
        return False


def _move_onto(hwnd: int, region: tuple[int, int, int, int]) -> bool:
    """Moves a top-level window onto the monitor `region`; False when it was already there or can't be."""
    if not hwnd or not win32gui.IsWindow(hwnd) or not win32gui.IsWindowVisible(hwnd) or _is_own(hwnd):
        return False
    hwnd = win32gui.GetAncestor(hwnd, 2) or hwnd  # GA_ROOT
    left, top, right, bottom = region
    x0, y0, x1, y1 = win32gui.GetWindowRect(hwnd)
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    if left <= cx < right and top <= cy < bottom:
        return False
    try:
        work = win32api.GetMonitorInfo(win32api.MonitorFromPoint(((left + right) // 2, (top + bottom) // 2)))["Work"]
    except Exception:
        work = region
    wl, wt, wr, wb = work
    maximized = bool(ctypes.windll.user32.IsZoomed(hwnd))
    if maximized or win32gui.IsIconic(hwnd):
        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        x0, y0, x1, y1 = win32gui.GetWindowRect(hwnd)
    w, h = min(x1 - x0, wr - wl), min(y1 - y0, wb - wt)
    x, y = wl + (wr - wl - w) // 2, wt + (wb - wt - h) // 2
    flags = win32con.SWP_NOZORDER | win32con.SWP_NOACTIVATE
    win32gui.SetWindowPos(hwnd, 0, x, y, w, h, flags)
    if maximized:
        win32gui.ShowWindow(hwnd, win32con.SW_MAXIMIZE)
    return True


def _tops() -> list[tuple[int, int, str]]:
    """Visible, titled top-level windows (no owned dialogs): (hwnd, pid, title)."""
    found: list[tuple[int, int, str]] = []

    def each(hwnd, _):
        if win32gui.IsWindowVisible(hwnd) and not win32gui.GetWindow(hwnd, win32con.GW_OWNER):
            title = win32gui.GetWindowText(hwnd)
            if title:
                found.append((hwnd, win32process.GetWindowThreadProcessId(hwnd)[1], title))
        return True

    win32gui.EnumWindows(each, None)
    return found


def _tree(pid: int) -> set[int]:
    """The program and everything it started (a launcher often hands the window to a child)."""
    from psutil import NoSuchProcess, Process

    try:
        return {pid, *(c.pid for c in Process(pid).children(recursive=True))}
    except (NoSuchProcess, ValueError):
        return set()


def _exe_of(pid: int) -> str:
    from psutil import Process

    try:
        return Process(pid).name().lower()
    except Exception:
        return ""


def _launched(before: set[int], pid: int = 0, exe: str = "", name: str = "") -> int:
    """
    Waits for the window a launch opened and returns it (0 when none showed). Only windows that are
    new since the launch count, so a window the user already had open is never moved; of those, one
    of the program's own process tree, else one of the same program (Windows 11's Notepad hands over
    to another process), else one with the app's name in its title. The wait ends early when the
    program is gone and nothing new showed in 3 s (a command-line program).
    """
    exe = os.path.basename(exe or "").lower()
    want = re.sub(r"\s+", " ", name or "").strip().lower()
    start = time.monotonic()
    while True:
        pids = _tree(pid) if pid else set()
        fresh = [w for w in _tops() if w[0] not in before and not _is_own(w[0])]
        for test in (
            lambda w: w[1] in pids,
            lambda w: bool(exe) and _exe_of(w[1]) == exe,
            lambda w: bool(want) and want in w[2].lower(),
        ):
            hit = next((w[0] for w in fresh if test(w)), 0)
            if hit:
                return hit
        waited = time.monotonic() - start
        if waited >= WINDOW_WAIT or (waited >= 3.0 and not pids):
            return 0
        time.sleep(0.25)


MOVED = " Its window was moved onto your monitor (Harv's), since Windows opens windows on the main one."


def _pin(hwnd_of) -> bool:
    region = _pin_region()
    if region is None:
        return False
    try:
        return _move_onto(hwnd_of(), region)
    except Exception:
        return False  # never fail the App call over the move


def _handles() -> set[int]:
    try:
        return {w[0] for w in _tops()}
    except Exception:
        return set()


_launch_app = Desktop.launch_app
_app = Desktop.app


def launch_app(self: Desktop, name: str):
    response, status, pid = _launch_app(self, name)
    self._harv_pid = pid
    return response, status, pid


def app(self: Desktop, mode, name=None, loc=None, size=None):
    self._harv_pid = 0
    before = _handles() if mode == "launch" else set()
    result = _app(self, mode, name, loc, size)
    if mode == "switch":
        moved = _pin(win32gui.GetForegroundWindow)
    elif mode == "launch" and isinstance(result, str) and "launch" in result.lower() and "not found" not in result.lower():
        pid = getattr(self, "_harv_pid", 0)
        moved = _pin(lambda: _launched(before, pid=pid, name=name))
    else:
        moved = False
    return f"{result}{MOVED}" if moved and isinstance(result, str) else result


Desktop.launch_app = launch_app
Desktop.app = app

_launch_executable = app_module._launch_executable


def launch_executable(executable, args, cwd):
    before = _handles()
    out = _launch_executable(executable, args, cwd)
    try:
        info = json.loads(out)
        pid = int(info["pid"])
    except (ValueError, KeyError, TypeError):
        return out
    if _pin(lambda: _launched(before, pid=pid, exe=str(info.get("executable", "")))):
        info["moved"] = "onto your monitor (Harv's)"
        return json.dumps(info, indent=2)
    return out


app_module._launch_executable = launch_executable


from windows_mcp.__main__ import main  # noqa: E402  (after the swap, so it uses it)

sys.exit(main())
