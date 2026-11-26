//! Harv's browser (docs/PLAN.md §6x): real web views of the system's engine (WebView2 on
//! Windows, WebKitGTK on Linux) placed over the dashboard's Browser tab, so pages are as sharp
//! and quick as in any browser. One browser per computer, with page tabs, shared by every chat:
//! the dashboard places and drives it, and Harv's browser tools reach it through the dashboard.
//! Its logins live in ~/.harv/browser-data, apart from the dashboard's own. The pages get no
//! access to the app's commands (capabilities/main.json grants them to the "main" webview only).

use std::collections::{HashMap, HashSet};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
#[cfg(not(target_os = "linux"))]
use tauri::webview::DownloadEvent;
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl};

/// A page's webview label: "browser-<tab id>-<n>" (a fresh one each time a sleeping tab wakes, so
/// a closing old view never clashes with the new one).
const PREFIX: &str = "browser-";

/// Live page tabs kept at most: the showing one plus the most recently used. Each live tab is a
/// whole engine process (~0.5 GB on the notebook, and hidden pages keep running their scripts:
/// ten made it run hot, 2026-11-18). Older tabs sleep: they stay in the strip with their
/// address and title, and wake (reload) when picked, like Chrome's and Edge's sleeping tabs.
const AWAKE: usize = 3;

/// Downloads remembered (the newest), so Harv and the Browser view can say where a file landed.
const DOWNLOADS_KEPT: usize = 10;

#[derive(Default)]
pub struct Browser {
    inner: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// Page ids in tab order.
    pages: Vec<u32>,
    active: Option<u32>,
    next: u32,
    /// Where the Browser tab's page area is in the window (logical px), and whether it shows.
    bounds: Option<(f64, f64, f64, f64)>,
    visible: bool,
    /// Titles and whether a page is loading, from the engine's events.
    titles: HashMap<u32, String>,
    loading: HashSet<u32>,
    /// Each live tab's current webview label (a sleeping tab has none).
    views: HashMap<u32, String>,
    /// Where a sleeping tab was, to wake it there.
    urls: HashMap<u32, String>,
    /// Tabs by last use, most recent first.
    used: Vec<u32>,
    views_made: u32,
    /// Recent downloads, oldest first.
    downloads: Vec<DownloadInfo>,
    downloads_made: u32,
}

/// A file a page downloaded: where it goes and how it went ("downloading", "done", "failed").
#[derive(Serialize, Clone, Debug, PartialEq)]
struct DownloadInfo {
    id: u32,
    url: String,
    path: String,
    state: String,
}

/// A download starts (pure, for tests): remembered under a new id, the oldest past DOWNLOADS_KEPT dropped.
fn download_started(downloads: &mut Vec<DownloadInfo>, id: u32, url: &str, path: &str) {
    downloads.push(DownloadInfo {
        id,
        url: url.into(),
        path: path.into(),
        state: "downloading".into(),
    });
    let extra = downloads.len().saturating_sub(DOWNLOADS_KEPT);
    downloads.drain(..extra);
}

/// Where a download is being written, learned after it started (pure, for tests): Linux's engine
/// names the file itself and says so when it creates it.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn download_located(downloads: &mut [DownloadInfo], url: &str, path: &str) -> bool {
    let Some(d) = downloads
        .iter_mut()
        .rev()
        .find(|d| d.url == url && d.state == "downloading")
    else {
        return false;
    };
    d.path = path.into();
    true
}

/// A download ended (pure, for tests): the newest unfinished one from `url` gets its outcome (and
/// its final path, when the engine says). On Linux every page registers its own handler on the
/// one shared engine context, so the same end arrives several times: only the first counts.
fn download_finished(
    downloads: &mut [DownloadInfo],
    url: &str,
    path: Option<&str>,
    ok: bool,
) -> bool {
    let Some(d) = downloads
        .iter_mut()
        .rev()
        .find(|d| d.url == url && d.state == "downloading")
    else {
        return false;
    };
    if let Some(path) = path.filter(|p| !p.is_empty()) {
        d.path = path.into();
    }
    d.state = if ok { "done" } else { "failed" }.into();
    true
}

#[derive(Serialize, Clone)]
struct PageInfo {
    id: u32,
    url: String,
    title: String,
    loading: bool,
    asleep: bool,
}

#[derive(Serialize, Clone)]
struct BrowserState {
    pages: Vec<PageInfo>,
    active: Option<u32>,
    downloads: Vec<DownloadInfo>,
}

fn view_label(app: &AppHandle, id: u32) -> Option<String> {
    app.state::<Browser>()
        .inner
        .lock()
        .unwrap()
        .views
        .get(&id)
        .cloned()
}

/// A live tab's webview, waking the tab first if it sleeps.
fn page(app: &AppHandle, id: u32) -> Result<Webview, String> {
    wake(app, id)?;
    view_label(app, id)
        .and_then(|l| app.get_webview(&l))
        .ok_or_else(|| format!("No browser page {id}."))
}

/// The tabs to keep live (pure, for tests): the active one plus the most recently used, up to
/// AWAKE; returns the live tabs that should sleep now.
fn to_sleep(live: &[u32], used: &[u32], active: Option<u32>) -> Vec<u32> {
    let mut keep: Vec<u32> = active.into_iter().collect();
    for id in used {
        if keep.len() >= AWAKE {
            break;
        }
        if live.contains(id) && !keep.contains(id) {
            keep.push(*id);
        }
    }
    live.iter()
        .copied()
        .filter(|id| !keep.contains(id))
        .collect()
}

/// Moves tab `id` to position `to` in the strip (pure, for tests); false when it isn't there.
fn move_page(pages: &mut Vec<u32>, id: u32, to: usize) -> bool {
    let Some(from) = pages.iter().position(|&p| p == id) else {
        return false;
    };
    let page = pages.remove(from);
    pages.insert(to.min(pages.len()), page);
    true
}

/// Marks a tab as just used (most recent first).
fn touch(app: &AppHandle, id: u32) {
    let browser = app.state::<Browser>();
    let mut s = browser.inner.lock().unwrap();
    s.used.retain(|&u| u != id);
    s.used.insert(0, id);
}

/// Puts tabs past AWAKE to sleep: their address is kept and their webview closed.
fn sleep_extra(app: &AppHandle) {
    let (live, used, active) = {
        let browser = app.state::<Browser>();
        let s = browser.inner.lock().unwrap();
        let live: Vec<u32> = s
            .pages
            .iter()
            .copied()
            .filter(|id| s.views.contains_key(id))
            .collect();
        (live, s.used.clone(), s.active)
    };
    for id in to_sleep(&live, &used, active) {
        let Some(view) = view_label(app, id).and_then(|l| app.get_webview(&l)) else {
            continue;
        };
        // Asked before the lock (the engine answers on the main thread).
        let url = view.url().ok().map(|u| u.to_string());
        {
            let browser = app.state::<Browser>();
            let mut s = browser.inner.lock().unwrap();
            s.views.remove(&id);
            s.loading.remove(&id);
            if let Some(url) = url {
                s.urls.insert(id, url);
            }
        }
        let _ = close_view(&view);
    }
}

/// Closes a page's webview for good. On Linux the overlay holds the page's widget, which kept
/// every closed page's WebKit process alive (eight left after five tabs, 2026-11-18): it lets go first.
fn close_view(view: &Webview) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    overlay::release(view);
    view.close().map_err(|e| e.to_string())
}

/// Wakes a sleeping tab: a new webview at its saved address (logins stay: one data folder).
fn wake(app: &AppHandle, id: u32) -> Result<(), String> {
    let saved = {
        let browser = app.state::<Browser>();
        let s = browser.inner.lock().unwrap();
        if !s.pages.contains(&id) {
            return Err(format!("No browser page {id}."));
        }
        if s.views.contains_key(&id) {
            return Ok(());
        }
        s.urls
            .get(&id)
            .cloned()
            .unwrap_or_else(|| "about:blank".into())
    };
    let url = parse_url(&saved).or_else(|_| parse_url("about:blank"))?;
    make_view(app, id, url)?;
    touch(app, id);
    layout(app);
    Ok(())
}

/// Only web pages and the user's files: no javascript:, data: or the app's own schemes.
fn parse_url(url: &str) -> Result<Url, String> {
    let parsed = Url::parse(url).map_err(|e| format!("Not a web address: {url} ({e})"))?;
    match parsed.scheme() {
        "http" | "https" | "file" => Ok(parsed),
        "about" if url == "about:blank" => Ok(parsed),
        other => Err(format!("The browser doesn't open {other}: links.")),
    }
}

/// Tells the dashboard what the browser holds now (its tabs, titles, addresses).
fn emit_state(app: &AppHandle) {
    let _ = app.emit_to("main", "browser-state", state(app));
}

/// What the browser holds now: its tabs (live or asleep), titles, addresses.
fn state(app: &AppHandle) -> BrowserState {
    // Copied out first: asking the engine for an address waits on the main thread, whose page
    // events take this lock (holding it here could deadlock).
    type Row = (u32, String, bool, Option<String>, String);
    let (pages, active, downloads) = {
        let browser = app.state::<Browser>();
        let s = browser.inner.lock().unwrap();
        let pages: Vec<Row> = s
            .pages
            .iter()
            .map(|&id| {
                (
                    id,
                    s.titles.get(&id).cloned().unwrap_or_default(),
                    s.loading.contains(&id),
                    s.views.get(&id).cloned(),
                    s.urls.get(&id).cloned().unwrap_or_default(),
                )
            })
            .collect();
        (pages, s.active, s.downloads.clone())
    };
    BrowserState {
        pages: pages
            .into_iter()
            .map(|(id, title, loading, view, saved)| PageInfo {
                id,
                url: view
                    .as_ref()
                    .and_then(|l| app.get_webview(l))
                    .and_then(|w| w.url().ok())
                    .map(|u| u.to_string())
                    .unwrap_or(saved),
                title,
                loading,
                asleep: view.is_none(),
            })
            .collect(),
        active,
        downloads,
    }
}

/// Shows the active page over the Browser tab's area (when it's showing) and hides the rest.
fn layout(app: &AppHandle) {
    let (views, active, visible, bounds) = {
        let browser = app.state::<Browser>();
        let s = browser.inner.lock().unwrap();
        let views: Vec<(u32, String)> = s.views.iter().map(|(&id, l)| (id, l.clone())).collect();
        (views, s.active, s.visible, s.bounds)
    };
    for (id, label) in views {
        let Some(view) = app.get_webview(&label) else {
            continue;
        };
        match (Some(id) == active && visible, bounds) {
            (true, Some((x, y, w, h))) => {
                #[cfg(target_os = "linux")]
                overlay::place(&view, x, y, w.max(1.0), h.max(1.0));
                #[cfg(not(target_os = "linux"))]
                {
                    let _ = view.set_position(LogicalPosition::new(x, y));
                    let _ = view.set_size(LogicalSize::new(w.max(1.0), h.max(1.0)));
                }
                let _ = view.show();
            }
            _ => {
                let _ = view.hide();
            }
        }
    }
}

/// The window was shown again: put each page back as it should be (see `crate::show`).
pub fn relayout(app: &AppHandle) {
    layout(app);
}

/// A new page tab at `url`, made the active one; older tabs past AWAKE fall asleep.
fn open(app: &AppHandle, url: Url) -> Result<u32, String> {
    let id = {
        let browser = app.state::<Browser>();
        let mut s = browser.inner.lock().unwrap();
        s.next += 1;
        s.next
    };
    make_view(app, id, url)?;
    {
        let browser = app.state::<Browser>();
        let mut s = browser.inner.lock().unwrap();
        s.pages.push(id);
        s.active = Some(id);
    }
    touch(app, id);
    sleep_extra(app);
    Ok(id)
}

/// Makes tab `id`'s webview at `url` (hidden; layout() shows it).
fn make_view(app: &AppHandle, id: u32, url: Url) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or("The app's window isn't there.")?;
    let browser = app.state::<Browser>();
    let label = {
        let mut s = browser.inner.lock().unwrap();
        s.views_made += 1;
        format!("{PREFIX}{id}-{}", s.views_made)
    };
    let data = crate::harv::harv_home().join("browser-data");
    let _ = std::fs::create_dir_all(&data);
    let titles = app.clone();
    let loads = app.clone();
    let popups = app.clone();
    let builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(url))
        .data_directory(data)
        .on_document_title_changed(move |_view, title| {
            titles
                .state::<Browser>()
                .inner
                .lock()
                .unwrap()
                .titles
                .insert(id, title);
            emit_state(&titles);
        })
        .on_page_load(move |view, payload| {
            {
                let browser = loads.state::<Browser>();
                let mut s = browser.inner.lock().unwrap();
                // A view put to sleep may still report; only the tab's live view counts.
                if s.views.get(&id).map(String::as_str) != Some(view.label()) {
                    return;
                }
                match payload.event() {
                    PageLoadEvent::Started => s.loading.insert(id),
                    PageLoadEvent::Finished => s.loading.remove(&id),
                };
            }
            emit_state(&loads);
        })
        // A link that opens a new window (target=_blank, window.open) opens as a new page tab.
        .on_new_window(move |url, _features| {
            let app = popups.clone();
            std::thread::spawn(move || {
                // A page may open web pages only, never a local file (the full review, U29: a normal
                // browser refuses that too). Harv and the user still open file: links themselves.
                if matches!(url.scheme(), "http" | "https") && parse_url(url.as_str()).is_ok() {
                    let _ = open(&app, url);
                    layout(&app);
                    emit_state(&app);
                }
            });
            NewWindowResponse::Deny
        });
    // Windows: each page's own download handler (WebView2 asks the page that downloads). The file
    // goes to the user's Downloads folder under WebView2's own unique name; handling it hides
    // WebView2's download flyout, so the Browser view shows the download instead. Linux hooks its
    // one shared engine context instead (gtk_downloads, after the view is made).
    #[cfg(not(target_os = "linux"))]
    let builder = {
        let downloads = app.clone();
        builder.on_download(move |_view, event| {
            match event {
                DownloadEvent::Requested { url, destination } => {
                    note_download_started(&downloads, url.as_str(), &destination.to_string_lossy())
                }
                DownloadEvent::Finished { url, path, success } => {
                    let path = path.map(|p| p.to_string_lossy().to_string());
                    note_download_finished(&downloads, url.as_str(), path.as_deref(), success);
                }
                _ => {}
            }
            true
        })
    };
    // Created hidden at the tab's place (or a corner); layout() shows it when the tab is visible.
    let (x, y, w, h) = browser
        .inner
        .lock()
        .unwrap()
        .bounds
        .unwrap_or((0.0, 0.0, 800.0, 600.0));
    let view = window
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w, h))
        .map_err(|e| format!("Couldn't make a browser page: {e}"))?;
    #[cfg(target_os = "linux")]
    {
        overlay::adopt(&view);
        gtk_downloads::hook(app, &view);
    }
    let _ = view.hide();
    browser.inner.lock().unwrap().views.insert(id, label);
    Ok(())
}

/// Tells the dashboard off the calling (engine's) thread: the state asks the pages for their addresses.
fn emit_later(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || emit_state(&app));
}

/// A page started downloading `url` into `path`: remembered, so Harv's tools and the Browser view
/// can say where it landed (2026-11-24).
fn note_download_started(app: &AppHandle, url: &str, path: &str) {
    {
        let browser = app.state::<Browser>();
        let mut s = browser.inner.lock().unwrap();
        s.downloads_made += 1;
        let id = s.downloads_made;
        download_started(&mut s.downloads, id, url, path);
    }
    emit_later(app);
}

/// Linux: where a download is being written (the engine picked the name).
#[cfg(target_os = "linux")]
fn note_download_located(app: &AppHandle, url: &str, path: &str) {
    let changed = {
        let browser = app.state::<Browser>();
        let mut s = browser.inner.lock().unwrap();
        download_located(&mut s.downloads, url, path)
    };
    if changed {
        emit_later(app);
    }
}

/// A download ended (its final path when the engine says).
fn note_download_finished(app: &AppHandle, url: &str, path: Option<&str>, ok: bool) {
    let changed = {
        let browser = app.state::<Browser>();
        let mut s = browser.inner.lock().unwrap();
        download_finished(&mut s.downloads, url, path, ok)
    };
    if changed {
        emit_later(app);
    }
}

/// Runs a script in a page and returns its result (the script's last value, as JSON). Scripts
/// must be synchronous: the engines don't wait for promises. A thrown error comes back as
/// { "error": … } (WebView2 drops exceptions, so every script is wrapped).
fn eval(app: &AppHandle, id: u32, script: &str) -> Result<Value, String> {
    let view = page(app, id)?;
    let wrapped = format!(
        "(() => {{ try {{ return JSON.stringify({{ ok: (() => {{ {script} }})() }}); }} catch (e) {{ return JSON.stringify({{ error: String(e && e.message || e) }}); }} }})()"
    );
    let (tx, rx) = mpsc::channel::<String>();
    view.eval_with_callback(wrapped, move |result| {
        let _ = tx.send(result);
    })
    .map_err(|e| format!("Couldn't run a script in the page: {e}"))?;
    let raw = rx
        .recv_timeout(Duration::from_secs(20))
        .map_err(|_| "The page didn't answer in time (still loading?).".to_string())?;
    // The engine returns the script's value as JSON: here a JSON string holding our JSON.
    let inner: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    let text = inner.as_str().unwrap_or("null");
    let out: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    if let Some(err) = out.get("error") {
        return Err(format!(
            "The page script failed: {}",
            err.as_str().unwrap_or("?")
        ));
    }
    Ok(out.get("ok").cloned().unwrap_or(Value::Null))
}

fn active(app: &AppHandle, id: Option<u32>) -> Result<u32, String> {
    id.or(app.state::<Browser>().inner.lock().unwrap().active)
        .ok_or_else(|| "No page is open in the browser.".to_string())
}

/// The dashboard (re)loads: no page shows until its Browser view places them again. Without
/// this a restart left the pages over the chat (the user's report, 2026-10-28).
pub fn dashboard_loading(app: &AppHandle) {
    app.state::<Browser>().inner.lock().unwrap().visible = false;
    layout(app);
}

/// Everything the dashboard asks of the browser: open, navigate, back, forward, reload, close,
/// select a page, place the browser over its tab, run a script in a page, or list the pages.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn browser(
    app: AppHandle,
    action: String,
    id: Option<u32>,
    url: Option<String>,
    script: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    w: Option<f64>,
    h: Option<f64>,
    visible: Option<bool>,
    index: Option<u32>,
) -> Result<Value, String> {
    // Webviews are made and driven off the command thread (eval waits for the page's answer).
    tauri::async_runtime::spawn_blocking(move || {
        let result = match action.as_str() {
            "open" => {
                let target = parse_url(url.as_deref().unwrap_or("about:blank"))?;
                let id = open(&app, target)?;
                layout(&app);
                json!({ "id": id })
            }
            "navigate" => {
                let target = parse_url(url.as_deref().unwrap_or(""))?;
                let id = active(&app, id)?;
                page(&app, id)?
                    .navigate(target)
                    .map_err(|e| e.to_string())?;
                json!({ "id": id })
            }
            "back" | "forward" => {
                let id = active(&app, id)?;
                let go = if action == "back" { "back" } else { "forward" };
                page(&app, id)?
                    .eval(format!("history.{go}()"))
                    .map_err(|e| e.to_string())?;
                json!({ "id": id })
            }
            "reload" => {
                let id = active(&app, id)?;
                page(&app, id)?.reload().map_err(|e| e.to_string())?;
                json!({ "id": id })
            }
            "close" => {
                let id = active(&app, id)?;
                // A sleeping tab has no view to close.
                if let Some(view) = view_label(&app, id).and_then(|l| app.get_webview(&l)) {
                    close_view(&view)?;
                }
                let next = {
                    let browser = app.state::<Browser>();
                    let mut s = browser.inner.lock().unwrap();
                    let at = s.pages.iter().position(|&p| p == id);
                    s.pages.retain(|&p| p != id);
                    s.titles.remove(&id);
                    s.loading.remove(&id);
                    s.views.remove(&id);
                    s.urls.remove(&id);
                    s.used.retain(|&u| u != id);
                    if s.active == Some(id) {
                        s.active = at
                            .and_then(|i| {
                                s.pages.get(i.min(s.pages.len().saturating_sub(1))).copied()
                            })
                            .or(s.pages.last().copied());
                    }
                    s.active
                };
                // The tab that shows now may be asleep.
                if let Some(next) = next {
                    let _ = wake(&app, next);
                }
                layout(&app);
                json!({ "id": id })
            }
            "select" => {
                let id = id.ok_or("Which page?")?;
                app.state::<Browser>().inner.lock().unwrap().active = Some(id);
                page(&app, id)?;
                touch(&app, id);
                sleep_extra(&app);
                layout(&app);
                json!({ "id": id })
            }
            // The user drags a tab to a new place in the strip (their report, 2026-11-20).
            "move" => {
                let id = id.ok_or("Which page?")?;
                let to = index.ok_or("Move it where?")? as usize;
                let browser = app.state::<Browser>();
                let mut s = browser.inner.lock().unwrap();
                if !move_page(&mut s.pages, id, to) {
                    return Err("No such page.".into());
                }
                json!({ "id": id })
            }
            "list" => serde_json::to_value(state(&app)).map_err(|e| e.to_string())?,
            "place" => {
                {
                    let browser = app.state::<Browser>();
                    let mut s = browser.inner.lock().unwrap();
                    if let (Some(x), Some(y), Some(w), Some(h)) = (x, y, w, h) {
                        s.bounds = Some((x, y, w, h));
                    }
                    s.visible = visible.unwrap_or(s.visible);
                }
                layout(&app);
                // Nothing changed for the dashboard's tabs; no state event.
                return Ok(Value::Null);
            }
            "eval" => {
                let id = active(&app, id)?;
                eval(&app, id, script.as_deref().unwrap_or("return null"))?
            }
            other => return Err(format!("Unknown browser action {other}.")),
        };
        emit_state(&app);
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Linux: Tauri packs a window's webviews one under the other in its vertical box, so a page
/// showed below the whole dashboard and ignored its place (the user's report, 2026-10-28).
/// The first page moves the dashboard into a GtkOverlay in that box; every page floats over
/// it at the place layout() gives. Runs on GTK's thread through with_webview.
#[cfg(target_os = "linux")]
mod overlay {
    use std::cell::RefCell;
    use std::collections::HashMap;

    use gtk::prelude::*;
    use tauri::Webview;
    use webkit2gtk::WebViewExt;

    thread_local! {
        /// Each page's place in the overlay (logical px), by its widget name (the page's label).
        static PLACES: RefCell<HashMap<String, (i32, i32, i32, i32)>> = RefCell::new(HashMap::new());
    }

    /// The overlay in the window's box, made around the dashboard the first time.
    fn overlay_in(boxed: &gtk::Box, page: &gtk::Widget) -> gtk::Overlay {
        let children = boxed.children();
        if let Some(found) = children
            .iter()
            .find_map(|c| c.clone().downcast::<gtk::Overlay>().ok())
        {
            return found;
        }
        let overlay = gtk::Overlay::new();
        // Exact places: an overlay child otherwise gets its own preferred size.
        overlay.connect_get_child_position(|_, child| {
            let name = child.widget_name().to_string();
            PLACES.with(|p| {
                p.borrow()
                    .get(&name)
                    .map(|&(x, y, w, h)| gtk::Allocation::new(x, y, w, h))
            })
        });
        if let Some(dashboard) = children.iter().find(|c| *c != page) {
            boxed.remove(dashboard);
            overlay.add(dashboard);
        }
        boxed.pack_start(&overlay, true, true, 0);
        overlay.show();
        overlay
    }

    /// Moves a new page from the window's box into the overlay.
    pub fn adopt(view: &Webview) {
        let name = view.label().to_string();
        let _ = view.with_webview(move |platform| {
            let page: gtk::Widget = platform.inner().upcast();
            page.set_widget_name(&name);
            let Some(boxed) = page.parent().and_then(|p| p.downcast::<gtk::Box>().ok()) else {
                return;
            };
            let overlay = overlay_in(&boxed, &page);
            boxed.remove(&page);
            overlay.add_overlay(&page);
        });
    }

    /// Takes a page out of the overlay (dropping its hold on the widget), so Tauri's close can
    /// free it and its engine process ends.
    pub fn release(view: &Webview) {
        let name = view.label().to_string();
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        // Waited for: it runs on GTK's thread, and the close that follows must not overtake it.
        let _ = view.with_webview(move |platform| {
            PLACES.with(|p| p.borrow_mut().remove(&name));
            let _guard = Done(tx);
            // WebKit keeps a closed page's process around for reuse (~170 MB each, eight after
            // five tabs, 2026-11-18): end it outright.
            platform.inner().terminate_web_process();
            let page: gtk::Widget = platform.inner().upcast();
            if let Some(parent) = page
                .parent()
                .and_then(|p| p.downcast::<gtk::Container>().ok())
            {
                parent.remove(&page);
            }
            // Tauri's close of a child webview doesn't free it on Linux: destroying the widget
            // ends its engine process. Sound: it's out of every container, and a second
            // destroy (Tauri's) does nothing.
            unsafe { page.destroy() };
        });
        let _ = rx.recv_timeout(std::time::Duration::from_secs(3));
    }

    /// Says "done" when dropped, so a panic in the closure doesn't leave the caller waiting.
    struct Done(std::sync::mpsc::Sender<()>);
    impl Drop for Done {
        fn drop(&mut self) {
            let _ = self.0.send(());
        }
    }

    /// Puts a page at its place over the dashboard.
    pub fn place(view: &Webview, x: f64, y: f64, w: f64, h: f64) {
        let name = view.label().to_string();
        let place = (
            x.round() as i32,
            y.round() as i32,
            w.round() as i32,
            h.round() as i32,
        );
        let _ = view.with_webview(move |platform| {
            PLACES.with(|p| p.borrow_mut().insert(name, place));
            let page: gtk::Widget = platform.inner().upcast();
            page.queue_resize();
        });
    }
}

/// Linux: every page shares one WebKit context, and Tauri's per-page download handlers all hang on
/// it; WebKit asks only the first one registered, and once that page has closed Tauri's handler
/// cancels every download (the notebook downloaded nothing, 2026-11-24). So the context is watched
/// once here, for all pages. WebKit itself puts the file in the Downloads folder (XDG) under its
/// own name (it never asked a destination handler here: 2.54, 2026-11-24); this only listens.
#[cfg(target_os = "linux")]
mod gtk_downloads {
    use std::cell::RefCell;
    use std::collections::HashSet;

    use gtk::gio;
    use gtk::prelude::*;
    use tauri::{AppHandle, Webview};
    use webkit2gtk::{Download, DownloadExt, URIRequestExt, WebContextExt, WebViewExt};

    thread_local! {
        /// Contexts already watched (by address; runs on GTK's thread).
        static HOOKED: RefCell<HashSet<usize>> = RefCell::new(HashSet::new());
    }

    fn url_of(download: &Download) -> String {
        download
            .request()
            .and_then(|r| r.uri())
            .map(|u| u.to_string())
            .unwrap_or_default()
    }

    /// The engine names a destination as a file: URI (WebKitGTK 4.x) or a plain path.
    fn local_path(destination: &str) -> String {
        if destination.starts_with("file:") {
            if let Some(path) = gio::File::for_uri(destination).path() {
                return path.to_string_lossy().to_string();
            }
        }
        destination.to_string()
    }

    pub fn hook(app: &AppHandle, view: &Webview) {
        let app = app.clone();
        let _ = view.with_webview(move |platform| {
            let Some(context) = platform.inner().context() else {
                return;
            };
            let key = context.as_ptr() as usize;
            if !HOOKED.with(|h| h.borrow_mut().insert(key)) {
                return;
            }
            context.connect_download_started(move |_, download| {
                let url = url_of(download);
                super::note_download_started(&app, &url, "");
                let located = app.clone();
                download.connect_created_destination(move |download, destination| {
                    super::note_download_located(
                        &located,
                        &url_of(download),
                        &local_path(destination),
                    )
                });
                // A failed download also says "finished" after: the first word counts.
                let failed = app.clone();
                download.connect_failed(move |download, error| {
                    crate::harv::log(&format!("browser download failed: {error}"));
                    super::note_download_finished(&failed, &url_of(download), None, false)
                });
                let finished = app.clone();
                download.connect_finished(move |download| {
                    let path = download.destination().map(|d| local_path(&d));
                    super::note_download_finished(
                        &finished,
                        &url_of(download),
                        path.as_deref(),
                        true,
                    )
                });
            });
        });
    }
}

#[cfg(test)]
mod tests {
    use super::{
        download_finished, download_located, download_started, move_page, to_sleep, AWAKE,
        DOWNLOADS_KEPT,
    };

    #[test]
    fn remembers_downloads_and_counts_each_end_once() {
        let mut d = Vec::new();
        download_started(&mut d, 1, "https://a.test/f.pdf", "/home/u/Downloads/f.pdf");
        download_started(
            &mut d,
            2,
            "https://a.test/f.pdf",
            "/home/u/Downloads/f (1).pdf",
        );
        // The newest unfinished one from that address ends first; a repeat of the same end does nothing more.
        assert!(download_finished(
            &mut d,
            "https://a.test/f.pdf",
            None,
            true
        ));
        assert_eq!(
            (d[1].state.as_str(), d[0].state.as_str()),
            ("done", "downloading")
        );
        assert!(download_finished(
            &mut d,
            "https://a.test/f.pdf",
            Some(""),
            false
        ));
        assert_eq!(d[0].state, "failed");
        assert_eq!(d[0].path, "/home/u/Downloads/f.pdf");
        assert!(!download_finished(
            &mut d,
            "https://a.test/f.pdf",
            None,
            true
        ));
        // The engine's final path wins (WebView2 may number the name).
        download_started(&mut d, 3, "https://b.test/x", "C:/D/x.zip");
        assert!(download_finished(
            &mut d,
            "https://b.test/x",
            Some("C:/D/x (2).zip"),
            true
        ));
        assert_eq!(d[2].path, "C:/D/x (2).zip");
        // Linux learns the path after the start.
        download_started(&mut d, 30, "https://e.test/y", "");
        assert!(download_located(
            &mut d,
            "https://e.test/y",
            "/home/u/Downloads/y.pdf"
        ));
        assert_eq!(d.last().unwrap().path, "/home/u/Downloads/y.pdf");
        assert!(!download_located(&mut d, "https://nobody.test", "/x"));
        // Only the newest are kept.
        for i in 4..20 {
            download_started(&mut d, i, "https://c.test", "/p");
        }
        assert_eq!(d.len(), DOWNLOADS_KEPT);
        assert_eq!(d.last().unwrap().id, 19);
    }

    #[test]
    fn moves_a_tab_to_its_new_place() {
        let mut pages = vec![1, 2, 3, 4];
        assert!(move_page(&mut pages, 1, 2));
        assert_eq!(pages, vec![2, 3, 1, 4]);
        assert!(move_page(&mut pages, 4, 0));
        assert_eq!(pages, vec![4, 2, 3, 1]);
        // Past the end lands last; an unknown tab changes nothing.
        assert!(move_page(&mut pages, 2, 99));
        assert_eq!(pages, vec![4, 3, 1, 2]);
        assert!(!move_page(&mut pages, 7, 0));
        assert_eq!(pages, vec![4, 3, 1, 2]);
    }

    #[test]
    fn keeps_the_active_tab_and_the_most_recent_awake() {
        assert_eq!(AWAKE, 3);
        // Tabs 1-5 live, used most recently 5, 4, 2; tab 1 shows.
        assert_eq!(
            to_sleep(&[1, 2, 3, 4, 5], &[5, 4, 2, 1, 3], Some(1)),
            vec![2, 3]
        );
        // Few enough: nothing sleeps.
        assert!(to_sleep(&[1, 2], &[2, 1], Some(2)).is_empty());
        // The showing tab never sleeps, even if it was used long ago.
        assert!(!to_sleep(&[1, 2, 3, 4], &[2, 3, 4, 1], Some(1)).contains(&1));
    }
}

/// The pages and the active one, for a dashboard that (re)loads.
#[tauri::command]
pub fn browser_state(app: AppHandle) {
    emit_state(&app);
}
