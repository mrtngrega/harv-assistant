"""Harv's hold-to-talk key on Linux (Wayland): KDE's GlobalShortcuts portal.

Run by the app (src/talk.rs, `python3 -u -c <this>`): binds "Ctrl+Alt+Space" for the app id
"harv" (KDE asks once, in its own dialog; the user can change the key in System Settings ›
Shortcuts) and prints one line per change: "down" when the key is pressed, "up" when let go.
No keyboard is read: the desktop tells only this shortcut (tested 18/18 on KDE 6, 2026-11-17).
"""
import random
import sys

from gi.repository import Gio, GLib

TRIGGER = sys.argv[1] if len(sys.argv) > 1 else "CTRL+ALT+space"
NAME = "org.freedesktop.portal.Desktop"
PATH = "/org/freedesktop/portal/desktop"
IFACE = "org.freedesktop.portal.GlobalShortcuts"

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
loop = GLib.MainLoop()


def say(line):
    print(line, flush=True)


try:
    # Tells the portal this process is the app "harv" (harv.desktop), so the binding is kept for it.
    bus.call_sync(NAME, PATH, "org.freedesktop.host.portal.Registry", "Register",
                  GLib.Variant("(sa{sv})", ("harv", {})), None, 0, -1, None)
except GLib.Error as e:
    say(f"note: register failed ({e.message})")

sender = bus.get_unique_name()[1:].replace(".", "_")


def token():
    return f"harv{random.randint(0, 10**9)}"


def request(method, args, sig, handle):
    """A portal call that answers through its Request's Response signal."""
    path = f"/org/freedesktop/portal/desktop/request/{sender}/{handle}"
    box = {}

    def on_response(_c, _s, _p, _i, _sig, params):
        box["r"] = params.unpack()
        loop.quit()

    sub = bus.signal_subscribe(NAME, "org.freedesktop.portal.Request", "Response", path, None, 0, on_response)
    bus.call_sync(NAME, PATH, IFACE, method, GLib.Variant(sig, args), None, 0, -1, None)
    loop.run()
    bus.signal_unsubscribe(sub)
    return box["r"]


t = token()
code, res = request("CreateSession",
                    ({"handle_token": GLib.Variant("s", t), "session_handle_token": GLib.Variant("s", token())},),
                    "(a{sv})", t)
if code != 0:
    say(f"error: no shortcut session ({code})")
    sys.exit(2)
session = res["session_handle"]

t = token()
code, _ = request("BindShortcuts",
                  (session,
                   [("talk", {"description": GLib.Variant("s", "Harv: hold to talk"),
                              "preferred_trigger": GLib.Variant("s", TRIGGER)})],
                   "", {"handle_token": GLib.Variant("s", t)}),
                  "(oa(sa{sv})sa{sv})", t)
if code != 0:
    say(f"error: the shortcut wasn't allowed ({code})")
    sys.exit(3)


def on_signal(_c, _s, _p, _i, sig, params):
    args = params.unpack()
    if args[0] != session or args[1] != "talk":
        return
    say("down" if sig == "Activated" else "up")


for sig in ("Activated", "Deactivated"):
    bus.signal_subscribe(NAME, IFACE, sig, PATH, None, 0, on_signal)

say("ready")
loop.run()
