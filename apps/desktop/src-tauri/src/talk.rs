//! Push-to-talk's hold key (docs/review/voice-plan.md V1b): Ctrl+Alt+Space held anywhere records
//! (in the dashboard, which owns the microphone); letting go sends what Whisper heard. The user's
//! pick (2026-11-17, review Q31/K14); on a Slovak layout Right Alt (AltGr) + Space works too.
//! - Windows takes the key with RegisterHotKey through the shortcut plugin (main.rs's handler).
//! - Linux (Wayland: no app sees other windows' keys) asks KDE's GlobalShortcuts portal, which
//!   reports press and release (`talk_portal.py`); no keyboard device is read.

use tauri::{AppHandle, Manager};

/// The hold key, as the shortcut plugin spells it.
pub const KEY: &str = "Ctrl+Alt+Space";

/// Tells the dashboard the key went down or up.
fn send(app: &AppHandle, down: bool) {
    if let Some(dashboard) = app.get_webview("main") {
        let _ = dashboard.eval(format!(
            "window.dispatchEvent(new CustomEvent('harv-talk', {{ detail: {{ down: {down} }} }}))"
        ));
    }
}

#[cfg(windows)]
mod imp {
    use std::str::FromStr;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tauri::{AppHandle, Manager};
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

    static HELD: AtomicBool = AtomicBool::new(false);

    fn shortcut() -> Shortcut {
        Shortcut::from_str(super::KEY).expect("a valid shortcut")
    }

    /// Takes the key from Windows (RegisterHotKey: the app in front never sees it, and nothing
    /// polls while it's up); the shortcut plugin reports the press and, by watching Space, the release.
    pub fn watch(app: AppHandle) {
        let note = match app.global_shortcut().register(shortcut()) {
            Ok(()) => format!("talk key: {} taken", super::KEY),
            Err(e) => format!("talk key: {} is taken by another program ({e})", super::KEY),
        };
        crate::harv::log(&note);
    }

    /// From the shortcut plugin's handler (main.rs): true when it was the talk key.
    pub fn handle(app: &AppHandle, shortcut: &Shortcut, state: ShortcutState) -> bool {
        if *shortcut != self::shortcut() {
            return false;
        }
        let down = state == ShortcutState::Pressed;
        // Every press watches for its own release: say each change once.
        if HELD.swap(down, Ordering::SeqCst) != down {
            super::send(app, down);
        }
        true
    }

    /// The dashboard records the microphone: WebView2 would ask in a prompt of its own every time,
    /// and the hold key works while Harv's window is hidden, so the prompt can't be seen. Only the
    /// microphone, only for Harv's own dashboard; the browser's pages are other webviews and keep
    /// WebView2's own prompt.
    pub fn allow_microphone(app: &AppHandle) {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
            COREWEBVIEW2_PERMISSION_STATE_ALLOW,
        };
        use webview2_com::{take_pwstr, PermissionRequestedEventHandler};
        let Some(dashboard) = app.get_webview("main") else {
            return;
        };
        let _ = dashboard.with_webview(|platform| unsafe {
            let Ok(core) = platform.controller().CoreWebView2() else {
                return;
            };
            let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                let mut uri = Default::default();
                args.Uri(&mut uri)?;
                let uri = take_pwstr(uri);
                let ours = uri == crate::harv::DASHBOARD
                    || uri.starts_with(&format!("{}/", crate::harv::DASHBOARD));
                if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE && ours {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                }
                Ok(())
            }));
            let mut token = 0i64;
            let _ = core.add_PermissionRequested(&handler, &mut token);
        });
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};
    use std::time::Duration;
    use tauri::{AppHandle, Manager};

    /// The portal helper (system Python with GObject, as on Fedora KDE), run from memory.
    const HELPER: &str = include_str!("talk_portal.py");
    /// The portal's spelling of the key (xdg shortcuts spec).
    const TRIGGER: &str = "CTRL+ALT+space";

    /// Asks KDE's GlobalShortcuts portal for the key (no keyboard is read, so no `input` group);
    /// the helper prints "down"/"up". If it quits (the portal restarted), it starts again later.
    pub fn watch(app: AppHandle) {
        std::thread::spawn(move || {
            let mut tries = 0u32;
            loop {
                tries += 1;
                let child = Command::new("python3")
                    .args(["-u", "-c", HELPER, TRIGGER])
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .spawn();
                let Ok(mut child) = child else {
                    crate::harv::log("talk key: python3 is missing: the hold key is off");
                    return;
                };
                let mut held = false;
                if let Some(out) = child.stdout.take() {
                    for line in BufReader::new(out).lines().map_while(Result::ok) {
                        match line.as_str() {
                            "down" | "up" => {
                                let down = line == "down";
                                if down != held {
                                    held = down;
                                    super::send(&app, down);
                                }
                            }
                            "ready" => crate::harv::log(&format!(
                                "talk key: {} through KDE's shortcuts",
                                super::KEY
                            )),
                            other => crate::harv::log(&format!("talk key: {other}")),
                        }
                    }
                }
                let _ = child.wait();
                if held {
                    super::send(&app, false);
                }
                // Refused or no portal: a few tries, then the key stays off until the app restarts.
                if tries >= 5 {
                    crate::harv::log(
                        "talk key: the shortcut portal keeps failing: the hold key is off",
                    );
                    return;
                }
                std::thread::sleep(Duration::from_secs(30));
            }
        });
    }

    /// WebKitGTK keeps media streams off and denies the microphone unless asked: on, and allowed
    /// for Harv's own dashboard only (the browser's pages are other webviews).
    pub fn allow_microphone(app: &AppHandle) {
        use webkit2gtk::glib::object::Cast;
        use webkit2gtk::{
            PermissionRequestExt, SettingsExt, UserMediaPermissionRequest,
            UserMediaPermissionRequestExt, WebViewExt,
        };
        let Some(dashboard) = app.get_webview("main") else {
            return;
        };
        let _ = dashboard.with_webview(|platform| {
            let view = platform.inner();
            if let Some(settings) = WebViewExt::settings(&view) {
                settings.set_enable_media_stream(true);
            }
            view.connect_permission_request(|view, request| {
                let ours = view
                    .uri()
                    .is_some_and(|u| u.starts_with(crate::harv::DASHBOARD));
                match request.downcast_ref::<UserMediaPermissionRequest>() {
                    Some(media)
                        if ours && media.is_for_audio_device() && !media.is_for_video_device() =>
                    {
                        request.allow();
                        true
                    }
                    _ => false,
                }
            });
        });
    }
}

#[cfg(windows)]
pub use imp::handle;
pub use imp::{allow_microphone, watch};
