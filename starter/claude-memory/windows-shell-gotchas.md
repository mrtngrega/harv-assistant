---
name: windows-shell-gotchas
description: Git Bash heredocs eat backslashes; Python text writes flip files to CRLF; how to capture the real Harv app window
metadata:
  type: feedback
---

- **Heredocs:** Git Bash heredocs (even `<<'EOF'`) and `node -e` strings can eat backslashes, silently changing Windows paths and `\n`. Write scripts with the Write tool into a scratch folder, then run them. The repo's PreToolUse hook (`scripts/heredoc-guard.mjs`) refuses a heredoc with a backslash.
- **Python on Windows:** `open(p, 'w')` writes `\r\n` and turns a whole file to CRLF. Use `open(p, 'rb')`/`'wb'` with `.decode()`/`.encode()`, or the Edit tool.
- **Backticks through Bash** (in `node -e "…"`) run as commands. Write docs and memory text with the Write tool.
- **Seeing the app as it really looks:** CDP screenshots show only the page (not the shared browser, the pill, the wallpaper behind). For a real capture: find the "Harv" window with EnumWindows per `harv.exe`, make it topmost without activating it (SetWindowPos HWND_TOPMOST, flags 0x13), BitBlt from the screen DC with SRCCOPY|CAPTUREBLT (0x40CC0020; CopyFromScreen misses layered windows), then put it back. Windows PowerShell is DPI-unaware: scaled monitors have scaled coordinates.
