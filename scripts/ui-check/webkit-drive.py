#!/usr/bin/env python3
"""Drive the dashboard in WebKitGTK, the engine the Linux app uses (it has no CDP port).

An offscreen WebKit view loads the dashboard and runs a list of steps from a JSON file:
  {"size": [w, h]}                      resize the view
  {"js": "...", "label": "x"}           run JavaScript (an expression or an async IIFE); prints the JSON result
  {"wait": ms}                          wait
  {"shot": "name"}                      save <outdir>/<name>.png
  {"shot_js": "...", "label": "x"}      take a screenshot and run JavaScript with it: __SHOT__ in the
                                        script becomes the PNG as a data: URL (to measure pixels in the page)
Usage: python3 webkit-drive.py steps.json outdir [url]
Nothing shows on screen. It is one more window of the dashboard: layout changes (views, tabs)
reach the other windows, so a plan should put back what it changes.
"""
import base64
import io
import json
import os
import sys

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402

steps = json.load(open(sys.argv[1], encoding="utf-8"))
outdir = sys.argv[2]
url = sys.argv[3] if len(sys.argv) > 3 else "http://127.0.0.1:4316/"
os.makedirs(outdir, exist_ok=True)

win = Gtk.OffscreenWindow()
view = WebKit2.WebView()
view.get_settings().set_enable_developer_extras(True)
win.add(view)
size = steps[0]["size"] if steps and "size" in steps[0] else [1920, 1040]
view.set_size_request(*size)
win.show_all()

state = {"i": 0}


def done():
    Gtk.main_quit()


def nxt(*_):
    if state["i"] >= len(steps):
        done()
        return False
    step = steps[state["i"]]
    state["i"] += 1
    if "size" in step:
        view.set_size_request(*step["size"])
        win.resize(*step["size"])
        GLib.timeout_add(400, nxt)
    elif "wait" in step:
        GLib.timeout_add(step["wait"], nxt)
    elif "js" in step:
        def finished(v, res, label=step.get("label", "")):
            try:
                value = v.evaluate_javascript_finish(res)
                out = value.to_json(0) if value is not None else "null"
            except Exception as e:  # a JS exception
                out = f"ERROR {e}"
            if label:
                print(f"{label}: {out}", flush=True)
            GLib.timeout_add(step.get("after", 150), nxt)

        view.evaluate_javascript(step["js"], -1, None, None, None, finished)
    elif "shot_js" in step:
        def measured(v, res, label=step.get("label", "")):
            try:
                value = v.call_async_javascript_function_finish(res)
                out = value.to_json(0) if value is not None else "null"
            except Exception as e:
                out = f"ERROR {e}"
            print(f"{label}: {out}", flush=True)
            GLib.timeout_add(150, nxt)

        def captured(v, res, js=step["shot_js"]):
            try:
                surface = v.get_snapshot_finish(res)
                buf = io.BytesIO()
                surface.write_to_png(buf)
                url = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
                # The async variant waits for a promise the script returns (evaluate_javascript doesn't).
                body = "return (" + js.replace("__SHOT__", url) + ");"
                v.call_async_javascript_function(body, -1, None, None, None, None, measured)
            except Exception as e:
                print(f"shot_js ERROR {e}", flush=True)
                GLib.timeout_add(50, nxt)

        view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, captured)
    elif "shot" in step:
        def saved(v, res, name=step["shot"]):
            try:
                surface = v.get_snapshot_finish(res)
                path = os.path.join(outdir, f"{name}.png")
                surface.write_to_png(path)
                print(f"shot {path}", flush=True)
            except Exception as e:
                print(f"shot {name} ERROR {e}", flush=True)
            GLib.timeout_add(50, nxt)

        view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, saved)
    else:
        GLib.timeout_add(10, nxt)
    return False


def loaded(v, event):
    if event == WebKit2.LoadEvent.FINISHED and state["i"] == 0:
        GLib.timeout_add(4000, nxt)


view.connect("load-changed", loaded)
GLib.timeout_add(180_000, done)
view.load_uri(url)
Gtk.main()
