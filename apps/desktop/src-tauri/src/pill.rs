//! Desktop control's pill (docs/PLAN.md §6t item 1 "The pill"): while Harv uses the mouse and
//! keyboard, a small glass window floats over every other window, top centre of the monitor Harv
//! acts on (it follows the action across monitors), with what Harv is doing and a STOP button. It never takes the focus (Harv's typing has to land in the app it
//! works in), stays out of screenshots (Windows-MCP's and the user's), and is the bundled
//! `pill.html`, so it gets only the commands it needs (capabilities/pill.json).
//!
//! Since pass C round 2 (docs/review/pass-c.md C2) the same window is also Harv's face on the
//! desktop when his own window isn't in front: a small pill while he works (face, what he's doing,
//! the chat, his six moons), amber while something waits for the user's yes (it shrinks to a dot
//! after a few seconds), a short "replied" note when a reply ends. Nothing at rest. Desktop control
//! always wins; a full-screen app in front hides the rest (checked once a second on Windows).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, Monitor, WebviewUrl, WebviewWindowBuilder};

use crate::tray;

const LABEL: &str = "pill";
/// The screen glow's window (glow.html).
const GLOW: &str = "glow";
const WIDTH: f64 = 460.0;
const HEIGHT: f64 = 64.0;
/// Space between the top of the screen and the pill.
const TOP: f64 = 14.0;
/// GTK keeps a fixed-size window at its natural size (the web view's 200 px high, 2026-11-16), so on
/// Linux the pill and glow are resizable: set_size and KWin's script can size them. No edges to drag.
const RESIZABLE: bool = cfg!(target_os = "linux");
/// The pill's title (`EnumWindows` finds it by this on Windows; KWin's script by it on Linux).
const PILL_TITLE: &str = "Harv is using your desktop";
/// The face pill's title on Linux (pill_kwin.js hides it while Harv's window is in sight).
#[cfg(target_os = "linux")]
const FACE_TITLE: &str = "Harv's face";

/// The monitor the pill was last put on (it only moves when the action moves to another one).
static PLACED_ON: Mutex<Option<String>> = Mutex::new(None);
/// Desktop control is showing the pill (it wins over Harv's face).
static CONTROLLING: AtomicBool = AtomicBool::new(false);
/// What the face pill should show while desktop control isn't using the window; None = nothing.
static AMBIENT: Mutex<Option<Ambient>> = Mutex::new(None);
/// The full-screen check runs (one thread, started with the first face pill).
static WATCHING: AtomicBool = AtomicBool::new(false);

/// The face pill's state, from the dashboard (`apps/web/src/lib/pill.ts`).
#[derive(Clone, serde::Deserialize, serde::Serialize, PartialEq)]
pub struct Ambient {
    /// "work", "waiting", "dot", "asleep" or "notice".
    pub mode: String,
    pub text: String,
    pub chat: String,
    /// Other chats in the same kind of state ("+2").
    #[serde(default)]
    pub more: u32,
    /// The moon in use (memory, files, shell, web, helpers, desktop).
    #[serde(default)]
    pub moon: Option<String>,
    /// Harv's motion switch is off: no animation on the pill either.
    #[serde(default)]
    pub still: bool,
    /// scripts/pill-demo.mjs: shown even with Harv's window in sight.
    #[serde(default)]
    pub demo: bool,
}

/// The user slid the face pill up (its ︿ button): only a small arrow tab stays at the top edge
/// until they click it. Kept while the app runs; desktop control's pill is never hidden (STOP).
static COLLAPSED: AtomicBool = AtomicBool::new(false);

/// The pill's window size for a mode (logical pixels): the arrow tab, a dot for a long wait, the face pill, the control pill.
fn size_of(mode: &str, collapsed: bool) -> (f64, f64) {
    match mode {
        "control" => (WIDTH, HEIGHT),
        _ if collapsed => (64.0, 22.0),
        "dot" => (48.0, 48.0),
        _ => (380.0, 56.0),
    }
}

/// The pill's text, or `None` to hide it. Called by the dashboard (`desktop.control` events);
/// `at` is where Harv acts, in physical pixels of the whole desktop (Windows-MCP's coordinates).
/// Async on purpose: a synchronous command runs on the main thread, and building a window there
/// waits for that same thread, so the whole app froze on Windows (found in the first live test).
#[tauri::command]
pub async fn desktop_pill(
    app: AppHandle,
    action: Option<String>,
    chat: Option<String>,
    at: Option<(f64, f64)>,
) {
    match action {
        Some(action) => {
            CONTROLLING.store(true, Ordering::SeqCst);
            show(&app, &action, chat.as_deref().unwrap_or(""), at)
        }
        None => {
            if CONTROLLING.swap(false, Ordering::SeqCst) {
                hide(&app)
            }
        }
    }
}

/// Harv's face on the desktop (pass C, C2), or `None` for nothing. The dashboard sends it only while
/// Harv's window isn't in front; desktop control's pill wins while it runs.
#[tauri::command]
pub async fn harv_pill(app: AppHandle, state: Option<Ambient>) {
    // No "same as before, skip": the dashboard sends only changes plus a resend every 20 s, and a
    // resend must be able to fix a pill left on screen (a stale "working" pill stayed up, 2026-11-13).
    AMBIENT.lock().unwrap().clone_from(&state);
    if CONTROLLING.load(Ordering::SeqCst) {
        return;
    }
    match state {
        Some(state) => show_ambient(&app, &state),
        None => {
            if let Some(window) = app.get_webview_window(LABEL) {
                hide_quietly(&window);
            }
        }
    }
}

/// A click on the face pill: Harv's window comes up with that chat.
#[tauri::command]
pub async fn pill_open(app: AppHandle) {
    if CONTROLLING.load(Ordering::SeqCst) {
        return;
    }
    crate::show(&app);
    if let Some(dashboard) = app.get_webview("main") {
        let _ = dashboard.eval("window.dispatchEvent(new Event('harv-pill-open'))");
    }
}

/// The face pill's ︿ (slide up) and the arrow tab (bring it back), from pill.html.
#[tauri::command]
pub async fn pill_collapse(app: AppHandle, collapsed: bool) {
    COLLAPSED.store(collapsed, Ordering::SeqCst);
    if CONTROLLING.load(Ordering::SeqCst) {
        return;
    }
    let state = AMBIENT.lock().unwrap().clone();
    if let Some(state) = state {
        show_ambient(&app, &state);
    }
}

fn show_ambient(app: &AppHandle, state: &Ambient) {
    let collapsed = COLLAPSED.load(Ordering::SeqCst);
    let mut value = serde_json::to_value(state).unwrap_or_default();
    value["collapsed"] = serde_json::Value::Bool(collapsed);
    let json = value.to_string();
    let window = match app.get_webview_window(LABEL) {
        Some(window) => {
            let _ = window.eval(format!("window.setPill && window.setPill({json})"));
            window
        }
        None => match create(app, &json) {
            Ok(window) => window,
            Err(e) => {
                crate::harv::log(&format!("presence: the desktop pill couldn't open ({e})"));
                return;
            }
        },
    };
    // On Linux KWin tells the face from the control pill by its title (pill_kwin.js).
    #[cfg(target_os = "linux")]
    let _ = window.set_title(FACE_TITLE);
    let (w, h) = size_of(&state.mode, collapsed);
    let _ = window.set_size(tauri::LogicalSize::new(w, h));
    // On the monitor Harv's window is on (or the primary); the arrow tab hangs from the very top edge.
    if let Some(monitor) = monitor_at(app, &window, None) {
        place(&window, &monitor, w, if collapsed { 0.0 } else { TOP });
        *PLACED_ON.lock().unwrap() = None;
    }
    if face_hidden(app) {
        hide_quietly(&window);
    } else {
        show_quietly(&window);
    }
    watch_fullscreen(app);
}

/// Once a second while the face pill is wanted: a full-screen app in front (a game, a video) or Harv's own window in sight hides it,
/// and it comes back when that app goes. Desktop control's pill is left alone.
fn watch_fullscreen(app: &AppHandle) {
    if WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut hidden = false;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
            if CONTROLLING.load(Ordering::SeqCst) || AMBIENT.lock().unwrap().is_none() {
                hidden = false;
                continue;
            }
            let Some(window) = app.get_webview_window(LABEL) else {
                continue;
            };
            let full = face_hidden(&app);
            if full && !hidden {
                hide_quietly(&window);
                hidden = true;
            } else if !full && hidden {
                show_quietly(&window);
                hidden = false;
            }
        }
    });
}

/// The window in front covers its whole monitor (a game, a full-screen video), not counting the desktop itself.
#[cfg(windows)]
fn fullscreen_in_front() -> bool {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindowRect,
    };
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return false;
        }
        let mut class = [0u16; 64];
        let n = GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32).max(0) as usize;
        let class = String::from_utf16_lossy(&class[..n]);
        if matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd") {
            return false;
        }
        let mut r: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut r) == 0 {
            return false;
        }
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(monitor, &mut info) == 0 {
            return false;
        }
        let m = info.rcMonitor;
        r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom
    }
}

#[cfg(not(windows))]
fn fullscreen_in_front() -> bool {
    false
}

/// Is a full-screen app in front right now? Harv's notices stay silent then (docs/PLAN.md §6ad).
#[tauri::command]
pub fn fullscreen_now() -> bool {
    fullscreen_in_front()
}

/// The face pill stays away: a full-screen app is in front, or the user can see Harv's window anyway
/// (it's open on the other monitor while they work on this one: the user's report, 2026-11-14).
fn face_hidden(app: &AppHandle) -> bool {
    let demo = AMBIENT.lock().unwrap().as_ref().is_some_and(|a| a.demo);
    fullscreen_in_front() || (!demo && harv_in_sight(app))
}

/// Harv's window is up and mostly uncovered, even without the focus: the window at the middle of
/// most of five spots on it (its centre and the middles of its quarters) is Harv's own.
#[cfg(windows)]
fn harv_in_sight(app: &AppHandle) -> bool {
    use windows_sys::Win32::Foundation::{POINT, RECT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetWindowRect, IsIconic, IsWindowVisible, WindowFromPoint, GA_ROOT,
    };
    let Some(Ok(hwnd)) = app.get_window("main").map(|w| w.hwnd()) else {
        return false;
    };
    let hwnd = hwnd.0 as _;
    unsafe {
        if IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 {
            return false;
        }
        let mut r: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut r) == 0 {
            return false;
        }
        let (w, h) = (r.right - r.left, r.bottom - r.top);
        let spots = [(2, 2), (1, 1), (3, 1), (1, 3), (3, 3)];
        let ours = spots
            .iter()
            .filter(|(x, y)| {
                let p = POINT {
                    x: r.left + w * x / 4,
                    y: r.top + h * y / 4,
                };
                GetAncestor(WindowFromPoint(p), GA_ROOT) == hwnd
            })
            .count();
        ours >= 3
    }
}

#[cfg(not(windows))]
fn harv_in_sight(_app: &AppHandle) -> bool {
    false
}

/// STOP on the pill: the dashboard stops the chat that's using the desktop.
#[tauri::command]
pub async fn pill_stop(app: AppHandle) {
    crate::harv::log("desktop control: STOP pressed on the pill");
    hide(&app);
    if let Some(dashboard) = app.get_webview("main") {
        let _ = dashboard.eval("window.dispatchEvent(new Event('harv-pill-stop'))");
    }
}

fn show(app: &AppHandle, action: &str, chat: &str, at: Option<(f64, f64)>) {
    let text = serde_json::json!({ "mode": "control", "text": action, "chat": chat }).to_string();
    let window = match app.get_webview_window(LABEL) {
        Some(window) => {
            let _ = window.eval(format!("window.setPill && window.setPill({text})"));
            window
        }
        // A new pill's page isn't loaded yet: it gets its first text before its own script runs.
        None => match create(app, &text) {
            Ok(window) => window,
            Err(e) => {
                crate::harv::log(&format!("desktop control: the pill couldn't open ({e})"));
                return;
            }
        },
    };
    #[cfg(target_os = "linux")]
    let _ = window.set_title(PILL_TITLE);
    let visible = window.is_visible().unwrap_or(false);
    let mut glow_shown = false;
    if let Some(monitor) = monitor_at(app, &window, at) {
        let name = monitor.name().cloned().unwrap_or_default();
        let mut placed = PLACED_ON.lock().unwrap();
        // A face pill showing before has no PLACED_ON: it's resized and moved to the control pill.
        let moved = !visible || placed.as_deref() != Some(name.as_str());
        if moved {
            let _ = window.set_size(tauri::LogicalSize::new(WIDTH, HEIGHT));
            place(&window, &monitor, WIDTH, TOP);
            *placed = Some(name);
        }
        glow_shown = show_glow(app, &monitor, moved);
        if moved {
            step_aside(app, &monitor);
        }
    }
    // Shown (or raised again) after the glow, so the pill stays on top of it.
    if !visible || glow_shown {
        show_quietly(&window);
    }
    tray::set_desktop(app, true);
}

fn hide(app: &AppHandle) {
    let mut was_shown = false;
    if let Some(window) = app.get_webview_window(LABEL) {
        was_shown = window.is_visible().unwrap_or(false);
        hide_quietly(&window);
    }
    *PLACED_ON.lock().unwrap() = None;
    if let Some(glow) = app.get_webview_window(GLOW) {
        hide_quietly(&glow);
    }
    tray::set_desktop(app, false);
    // Done with the desktop: back to Harv's window (the user's wish, 2026-11-09), also when it stepped aside.
    if was_shown {
        crate::show(app);
    }
}

/// Harv's own window on the monitor Harv acts on covered the app it works in (its Snapshots showed
/// mostly Harv's chat, 2026-11-10): it's minimized while Harv works there, and `hide` brings it back.
fn step_aside(app: &AppHandle, monitor: &Monitor) {
    let Some(main) = app.get_window("main") else {
        return;
    };
    let on_it = main
        .current_monitor()
        .ok()
        .flatten()
        .is_some_and(|m| m.name() == monitor.name());
    if on_it && main.is_visible().unwrap_or(false) && !main.is_minimized().unwrap_or(false) {
        crate::harv::log(
            "desktop control: Harv's window steps aside from the monitor Harv works on",
        );
        let _ = main.minimize();
    }
}

/// The screen glow (`glow.html`, the user's wish 2026-11-10): a soft frame around the whole monitor
/// Harv acts on, under the pill. Every click goes through it, it never takes the focus, and it stays
/// out of screenshots. True when it was just shown.
fn show_glow(app: &AppHandle, monitor: &Monitor, moved: bool) -> bool {
    let glow = match app.get_webview_window(GLOW) {
        Some(glow) => glow,
        None => match create_glow(app) {
            Ok(glow) => glow,
            Err(e) => {
                crate::harv::log(&format!(
                    "desktop control: the screen glow couldn't open ({e})"
                ));
                return false;
            }
        },
    };
    let visible = glow.is_visible().unwrap_or(false);
    if moved || !visible {
        let (p, s) = (monitor.position(), monitor.size());
        let _ = glow.set_position(tauri::PhysicalPosition::new(p.x, p.y));
        // One pixel short of the monitor: Windows takes a topmost window that covers a whole monitor
        // for a full-screen app (it would hold back notifications, and automatic lights read it too).
        let _ = glow.set_size(tauri::PhysicalSize::new(
            s.width,
            s.height.saturating_sub(1),
        ));
    }
    if !visible {
        show_quietly(&glow);
        #[cfg(target_os = "linux")]
        let _ = glow.set_ignore_cursor_events(true);
    }
    !visible
}

fn create_glow(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let glow = WebviewWindowBuilder::new(app, GLOW, WebviewUrl::App("glow.html".into()))
        .title("Harv is using this screen")
        .inner_size(WIDTH, HEIGHT)
        .resizable(RESIZABLE)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .visible(false)
        .build()?;
    // On Linux tao unwraps the GDK window, which exists only once shown: it panicked and took the
    // app down at the first real desktop action (2026-11-16). There it's set in show_glow instead.
    #[cfg(not(target_os = "linux"))]
    glow.set_ignore_cursor_events(true)?;
    #[cfg(windows)]
    keep_out_of_screenshots(&glow);
    Ok(glow)
}

fn create(app: &AppHandle, text: &str) -> tauri::Result<tauri::WebviewWindow> {
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("pill.html".into()))
        .initialization_script(format!("window.__pill = {text};"))
        .title(PILL_TITLE)
        .inner_size(WIDTH, HEIGHT)
        .resizable(RESIZABLE)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .visible(false)
        .build()?;
    #[cfg(windows)]
    keep_out_of_screenshots(&window);
    Ok(window)
}

/// The monitor with the point Harv acts on; without one, the monitor Harv's window is on (or the primary).
fn monitor_at(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    at: Option<(f64, f64)>,
) -> Option<Monitor> {
    let hit = at.and_then(|(x, y)| {
        window.available_monitors().ok()?.into_iter().find(|m| {
            let (p, s) = (m.position(), m.size());
            x >= p.x as f64
                && x < p.x as f64 + s.width as f64
                && y >= p.y as f64
                && y < p.y as f64 + s.height as f64
        })
    });
    hit.or_else(|| {
        app.get_window("main")
            .and_then(|w| w.current_monitor().ok().flatten())
    })
    .or_else(|| window.primary_monitor().ok().flatten())
}

/// Top centre of that monitor, in its own pixels (monitors can have different scaling).
fn place(window: &tauri::WebviewWindow, monitor: &Monitor, width: f64, top: f64) {
    let scale = monitor.scale_factor();
    let (p, s) = (monitor.position(), monitor.size());
    let _ = window.set_position(tauri::PhysicalPosition::new(
        p.x + ((s.width as f64 - width * scale) / 2.0) as i32,
        p.y + (top * scale) as i32,
    ));
}

/// Shows the pill without taking the focus from the app Harv works in. Tauri's `show()` activates
/// the window even with `focusable(false)` (the first live test: the pill became the foreground
/// window), so on Windows it's shown by hand: never activated, not even by a click on STOP, and
/// kept on top of everything.
#[cfg(windows)]
fn show_quietly(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE, HWND_TOPMOST,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SW_SHOWNOACTIVATE,
        WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    };
    let Ok(hwnd) = window.hwnd() else {
        let _ = window.show();
        return;
    };
    let hwnd = hwnd.0 as _;
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let quiet = (WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST) as isize;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | quiet);
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
    }
}

#[cfg(not(windows))]
fn show_quietly(window: &tauri::WebviewWindow) {
    let _ = window.show();
}

/// Hidden the same way it was shown: Tauri never saw the pill shown, so its `hide()` did nothing.
#[cfg(windows)]
fn hide_quietly(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
    match window.hwnd() {
        Ok(hwnd) => unsafe {
            ShowWindow(hwnd.0 as _, SW_HIDE);
        },
        Err(_) => {
            let _ = window.hide();
        }
    }
}

#[cfg(not(windows))]
fn hide_quietly(window: &tauri::WebviewWindow) {
    let _ = window.hide();
}

/// Screenshots (Windows-MCP's Screenshot, the user's own) leave the pill out, so Harv never
/// reads its own pill as part of the app it works in.
#[cfg(windows)]
fn keep_out_of_screenshots(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
    };
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            SetWindowDisplayAffinity(hwnd.0 as _, WDA_EXCLUDEFROMCAPTURE);
        }
    }
}
