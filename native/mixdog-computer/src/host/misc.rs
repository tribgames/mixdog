//! OCR, clipboard, application launch and the app lists.

use super::windows::effect;
use super::{Host, Res};
use crate::obj;
use crate::platform::{AppEntry, WindowInfo};
use crate::protocol::{Obj, Req};
use base64::Engine;
use serde_json::{json, Value};

/// The installed catalogue runs to hundreds of entries, so a listing answers
/// a query and otherwise only says how much more is there
/// (MAX_INSTALLED_APP_MATCHES, input/targeting.ts:17).
const MAX_INSTALLED_APP_MATCHES: usize = 40;

/// File names the system opener owns. On Windows they are the shell's
/// (Find-InstalledApp, runtime-window.ps1:125-126): "control.exe" once
/// matched the catalogue id of FanControl.exe and launched the wrong program.
const OPENER_SUFFIXES: &[&str] = if cfg!(windows) {
    &[".exe", ".com", ".bat", ".cmd", ".msc", ".cpl", ".lnk"]
} else {
    &[".app", ".desktop", ".sh", ".exe", ".bin"]
};

/// A bare name can mean a catalogue entry; a path, URL, or executable file
/// name belongs to the system opener.
fn names_catalogue_entry(target: &str) -> bool {
    let lower = target.to_lowercase();
    let scheme = target.split_once(':').is_some_and(|(scheme, _)| {
        !scheme.is_empty()
            && scheme
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    });
    // A packaged AppId (`Family!App`) is activated as given, never looked up
    // (Do-Launch, runtime-window.ps1:152-155).
    !(target.contains('!')
        || target.contains('/')
        || target.contains('\\')
        || scheme
        || OPENER_SUFFIXES.iter().any(|ext| lower.ends_with(ext)))
}

fn matches_like(value: &str, query: &str) -> bool {
    value.to_lowercase().contains(&query.to_lowercase())
}

/// An entry the system activates by its id instead of starting an executable.
fn packaged(app: &AppEntry) -> bool {
    app.app_id.contains('!')
}

/// The one catalogue entry the bare name `target` means (Find-InstalledApp,
/// runtime-window.ps1:120-143). Several matches stay unlaunched rather than
/// becoming a guess, except that a single packaged app among them wins: it is
/// the one Windows itself would open for a bare name like "notepad".
fn find_catalogue_entry<'a>(installed: &'a [AppEntry], target: &str) -> Res<Option<&'a AppEntry>> {
    // PowerShell `-eq`: one case-insensitive equality, Unicode included.
    let wanted = target.to_lowercase();
    let mut found: Vec<&AppEntry> = installed.iter().filter(|app| app.name.to_lowercase() == wanted).collect();
    if found.is_empty() {
        found = installed
            .iter()
            .filter(|app| matches_like(&app.name, target) || matches_like(&app.app_id, target))
            .collect();
    }
    if found.len() > 1 {
        let mut packaged_apps = found.iter().filter(|app| packaged(app));
        if let (Some(only), None) = (packaged_apps.next(), packaged_apps.next()) {
            return Ok(Some(only));
        }
        let names: Vec<&str> = found.iter().take(6).map(|app| app.name.as_str()).collect();
        return Err(format!(
            "launch failed [ambiguous_app/0] for '{target}': {} installed apps match ({})",
            found.len(),
            names.join(", ")
        ));
    }
    Ok(found.first().copied())
}

/// The running apps: windows grouped per app process, focused apps first,
/// then by name (windowsGroupedByApp, input/targeting.ts:36-82).
fn running_apps(windows: &[WindowInfo]) -> Vec<Value> {
    struct Group<'a> {
        name: &'a str,
        key: String,
        pid: i64,
        focused: bool,
        minimized: bool,
        windows: Vec<Value>,
    }
    let mut groups: Vec<Group> = Vec::new();
    for window in windows {
        let key = window.app.to_lowercase();
        let at = groups
            .iter()
            .position(|group| group.pid == window.pid && group.key == key)
            .unwrap_or_else(|| {
                groups.push(Group {
                    name: &window.app,
                    key,
                    pid: window.pid,
                    focused: false,
                    minimized: true,
                    windows: Vec::new(),
                });
                groups.len() - 1
            });
        let group = &mut groups[at];
        group.focused |= window.focused;
        group.minimized &= window.minimized;
        group.windows.push(json!({
            "window_id": window.id(),
            "title": window.title,
            "class_name": window.class_name,
            "minimized": window.minimized,
            "maximized": window.maximized,
        }));
    }
    // A stable sort: apps that compare equal keep the window order.
    groups.sort_by(|left, right| {
        right
            .focused
            .cmp(&left.focused)
            .then_with(|| left.key.cmp(&right.key))
    });
    groups
        .into_iter()
        .map(|group| {
            let window_count = group.windows.len();
            json!({
                "name": group.name,
                "pid": group.pid,
                "focused": group.focused,
                "minimized": group.minimized,
                "windows": group.windows,
                "window_count": window_count,
            })
        })
        .collect()
}

/// What list kind=apps answers (listComputerApps, input/targeting.ts:151-170):
/// with a query the installed matches, capped; without one only their total.
fn apps_payload(apps: Vec<Value>, query: &str, installed: &[Value], total: usize) -> Value {
    if query.trim().is_empty() {
        return json!({ "apps": apps, "installed_total": total });
    }
    json!({
        "apps": apps,
        "installed": &installed[..installed.len().min(MAX_INSTALLED_APP_MATCHES)],
        "installed_matched": installed.len(),
        "installed_total": total,
    })
}

impl Host {
    pub(super) fn ocr_image(&self, req: &Req) -> Res<Obj> {
        let encoded = req.text("image_base64");
        if encoded.trim().is_empty() {
            return Err("ocr_image requires image_base64".into());
        }
        let maximum = req.int("max_ocr_words").unwrap_or(300);
        if !(1..=1000).contains(&maximum) {
            return Err("max_ocr_words must be 1..1000".into());
        }
        let image = base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .map_err(|error| format!("ocr_image: image_base64 is not valid base64 ({error})"))?;
        match self
            .desktop
            .ocr(&image, req.text("ocr_language").trim(), maximum as usize)?
        {
            Value::Object(result) => Ok(result),
            _ => Err("ocr_image: recognizer returned no result".into()),
        }
    }

    pub(super) fn ocr_status(&self, req: &Req) -> Obj {
        match self.desktop.ocr_status(req.text("ocr_language").trim()) {
            Value::Object(status) => status,
            _ => obj! { "text" => "OCR readiness", "available" => false },
        }
    }

    pub(super) fn clipboard_read(&self) -> Res<Obj> {
        let mut text = self.desktop.clipboard_read()?;
        if text.is_empty() {
            return Ok(obj! { "text" => "Clipboard is empty or not text." });
        }
        if text.chars().count() > 30_000 {
            text = text.chars().take(30_000).collect::<String>() + "... (truncated)";
        }
        Ok(obj! { "text" => text })
    }

    pub(super) fn clipboard_write(&self, req: &Req) -> Res<Obj> {
        self.authorize_current(0)?;
        let text = req.text("text");
        let verified = self.desktop.clipboard_write(&text)?;
        let message = if text.is_empty() {
            "cleared clipboard".to_string()
        } else {
            format!("clipboard set: {} chars", text.chars().count())
        };
        Ok(self.action_result(
            "clipboard_write",
            "clipboard",
            effect(verified),
            verified,
            &message,
            None,
            "background",
            None,
        ))
    }

    fn find_installed_app(&self, target: &str) -> Res<Option<AppEntry>> {
        if !names_catalogue_entry(target) {
            return Ok(None);
        }
        let installed = self.desktop.installed_apps().unwrap_or_default();
        Ok(find_catalogue_entry(&installed, target)?.cloned())
    }

    pub(super) fn launch(&self, req: &Req) -> Res<Obj> {
        let target = req.text("app");
        if target.trim().is_empty() {
            return Err("launch requires app".into());
        }
        self.authorize_current(0)?;
        let app = self.find_installed_app(&target)?;
        let launched = self.desktop.launch(&target, app.as_ref())?;
        let mut result = self.action_result(
            "launch",
            launched.route,
            "unverifiable",
            false,
            &format!("launched {target}"),
            None,
            "background",
            None,
        );
        if !launched.app_id.is_empty() {
            result.insert("app_id".into(), json!(launched.app_id));
        }
        if launched.pid > 0 {
            result.insert("pid".into(), json!(launched.pid));
            if !launched.app_hint.is_empty() {
                result.insert("app_hint".into(), json!(launched.app_hint));
            }
        }
        Ok(result)
    }

    /// The catalogue rows `query` matches (all of them without one), the
    /// catalogue's size, and why it could not be read.
    fn installed_rows(&self, query: &str) -> (Vec<Value>, usize, Option<String>) {
        let (apps, error) = match self.desktop.installed_apps() {
            Ok(apps) => (apps, None),
            Err(error) => (Vec::new(), Some(error)),
        };
        let rows = apps
            .iter()
            .filter(|app| {
                query.trim().is_empty()
                    || matches_like(&app.name, query)
                    || matches_like(&app.app_id, query)
            })
            .map(|app| json!({ "name": app.name, "app_id": app.app_id, "packaged": packaged(app) }))
            .collect();
        (rows, apps.len(), error)
    }

    pub(super) fn list_installed_apps(&self, req: &Req) -> Res<Obj> {
        let (rows, total, error) = self.installed_rows(&req.text("query"));
        let mut payload =
            json!({ "installed": rows, "matched": rows.len(), "catalogue_total": total });
        if let Some(error) = &error {
            payload["catalogue_error"] = json!(error);
        }
        Ok(obj! { "text" => payload.to_string(), "installed" => rows, "catalogue_total" => total })
    }

    /// The running apps with their windows, then what the installed
    /// catalogue holds for the query (listComputerApps,
    /// input/targeting.ts:151-170).
    pub(super) fn list_apps(&self, req: &Req) -> Res<Obj> {
        let windows = self
            .desktop
            .windows()
            .map_err(|_| "could not enumerate apps".to_string())?;
        let query = req.text("query");
        let (installed, total, _) = self.installed_rows(&query);
        let payload = apps_payload(running_apps(&windows), &query, &installed, total);
        Ok(obj! { "text" => payload.to_string() })
    }

    /// Whether a saved-login owner's process has ended, as the OS proves it;
    /// never touches the desktop (Do-ProcessFate, runtime-saved-login.ps1:330-347).
    pub(super) fn process_fate(&self, req: &Req) -> Res<Obj> {
        match self.desktop.process_fate(&req.text("pid"), &req.text("created")) {
            Value::Object(fate) => Ok(fate),
            other => Err(format!("process_fate: the desktop answered {other}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_and_urls_go_to_the_opener() {
        assert!(names_catalogue_entry("Calculator"));
        assert!(names_catalogue_entry("Text Editor"));
        assert!(!names_catalogue_entry("/usr/bin/gedit"));
        assert!(!names_catalogue_entry("https://example.com"));
        assert!(!names_catalogue_entry("control.exe"));
        // A packaged AppId is activated as given, never looked up.
        assert!(!names_catalogue_entry("Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"));
    }

    #[cfg(not(windows))]
    #[test]
    fn bundles_and_scripts_go_to_the_opener() {
        assert!(!names_catalogue_entry("Safari.app"));
        assert!(!names_catalogue_entry("run.sh"));
    }

    #[cfg(windows)]
    #[test]
    fn the_shell_owns_its_file_suffixes_on_windows() {
        for target in ["devmgmt.msc", "main.cpl", "setup.bat", "build.CMD", "edit.com", "Paint.lnk"] {
            assert!(!names_catalogue_entry(target), "{target}");
        }
        // Not a shell suffix here: a catalogue name may end in it.
        assert!(names_catalogue_entry("Safari.app"));
        assert!(names_catalogue_entry("devmgmt"));
    }

    fn entry(name: &str, app_id: &str) -> AppEntry {
        AppEntry { name: name.into(), app_id: app_id.into() }
    }

    fn catalogue() -> Vec<AppEntry> {
        vec![
            entry("Notepad", "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"),
            entry("Notepad++", "{6D809377-6AF0-444B-8957-A3773F02200E}\\Notepad++\\notepad++.exe"),
            entry("Paint", "Microsoft.Paint_8wekyb3d8bbwe!App"),
            entry("Paint 3D", "Microsoft.MSPaint_8wekyb3d8bbwe!Microsoft.MSPaint"),
            entry("Word", "Microsoft.Office.WINWORD.EXE.15"),
            entry("WordPad", "{6D809377-6AF0-444B-8957-A3773F02200E}\\wordpad.exe"),
            entry("Fan Control", "C:\\Tools\\FanControl\\FanControl.exe"),
            entry("Fan Control Docs", "C:\\Tools\\FanControl\\docs.url"),
        ]
    }

    fn found(target: &str) -> Res<Option<String>> {
        let installed = catalogue();
        find_catalogue_entry(&installed, target).map(|app| app.map(|app| app.name.clone()))
    }

    #[test]
    fn a_catalogue_name_matches_exactly_before_it_matches_partly() {
        assert_eq!(found("Paint"), Ok(Some("Paint".into())));
        assert_eq!(found("wordpad"), Ok(Some("WordPad".into())));
        assert_eq!(found("WINWORD"), Ok(Some("Word".into())));
        assert_eq!(found("Calculator"), Ok(None));
        // One case-insensitive tier: names differing only in case both match.
        let cased = vec![entry("Paint", "paint.exe"), entry("paint", "Microsoft.Paint_8wekyb3d8bbwe!App")];
        assert_eq!(find_catalogue_entry(&cased, "PAINT").map(|app| app.map(|app| app.app_id.clone())), Ok(Some("Microsoft.Paint_8wekyb3d8bbwe!App".into())));
    }

    #[test]
    fn one_packaged_app_among_several_matches_wins() {
        // Both the packaged Notepad and Notepad++ contain it.
        assert_eq!(found("notepa"), Ok(Some("Notepad".into())));
    }

    #[test]
    fn several_matches_without_one_packaged_app_stay_unlaunched() {
        // Two packaged entries.
        assert_eq!(
            found("pain"),
            Err("launch failed [ambiguous_app/0] for 'pain': 2 installed apps match (Paint, Paint 3D)".into())
        );
        // None packaged.
        assert_eq!(
            found("fancontrol"),
            Err(
                "launch failed [ambiguous_app/0] for 'fancontrol': 2 installed apps match (Fan Control, Fan Control Docs)"
                    .into()
            )
        );
        let many: Vec<AppEntry> = (1..=8).map(|n| entry(&format!("Tool {n}"), "tool.exe")).collect();
        let error = find_catalogue_entry(&many, "tool").unwrap_err();
        assert!(
            error.ends_with("8 installed apps match (Tool 1, Tool 2, Tool 3, Tool 4, Tool 5, Tool 6)"),
            "{error}"
        );
    }

    fn window(handle: u64, app: &str, pid: i64, focused: bool, minimized: bool) -> WindowInfo {
        WindowInfo {
            handle,
            app: app.into(),
            pid,
            focused,
            minimized,
            title: format!("w{handle}"),
            class_name: "C".into(),
            ..Default::default()
        }
    }

    #[test]
    fn windows_group_per_app_process_with_the_focused_app_first() {
        let apps = running_apps(&[
            window(1, "notepad", 10, false, true),
            window(2, "Chrome", 20, false, false),
            window(3, "explorer", 30, true, false),
            window(4, "chrome", 20, false, true),
            window(5, "chrome", 21, false, true),
            window(6, "notepad", 10, false, true),
        ]);
        let summary: Vec<(String, i64, bool, bool, u64)> = apps
            .iter()
            .map(|app| {
                (
                    app["name"].as_str().unwrap_or_default().to_string(),
                    app["pid"].as_i64().unwrap_or_default(),
                    app["focused"] == json!(true),
                    app["minimized"] == json!(true),
                    app["window_count"].as_u64().unwrap_or_default(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            [
                ("explorer".to_string(), 30, true, false, 1),
                // One process's windows whatever the case of the app name;
                // minimized only when every window is.
                ("Chrome".to_string(), 20, false, false, 2),
                ("chrome".to_string(), 21, false, true, 1),
                ("notepad".to_string(), 10, false, true, 2),
            ]
        );
        assert_eq!(
            apps[1]["windows"],
            json!([
                { "window_id": "hwnd:0x2", "title": "w2", "class_name": "C", "minimized": false, "maximized": false },
                { "window_id": "hwnd:0x4", "title": "w4", "class_name": "C", "minimized": true, "maximized": false },
            ])
        );
    }

    #[test]
    fn the_installed_catalogue_is_listed_only_for_a_query_and_capped() {
        let installed: Vec<Value> = (0..45).map(|n| json!({ "name": format!("app {n}") })).collect();
        assert_eq!(
            apps_payload(Vec::new(), "  ", &installed, 300),
            json!({ "apps": [], "installed_total": 300 })
        );
        let listed = apps_payload(vec![json!({ "name": "x" })], "app", &installed, 300);
        assert_eq!(listed["apps"], json!([{ "name": "x" }]));
        assert_eq!(listed["installed"].as_array().map(Vec::len), Some(MAX_INSTALLED_APP_MATCHES));
        assert_eq!(listed["installed"][39], json!({ "name": "app 39" }));
        assert_eq!(listed["installed_matched"], json!(45));
        assert_eq!(listed["installed_total"], json!(300));
        let few = apps_payload(Vec::new(), "app 4", &installed[..3], 300);
        assert_eq!(few["installed"].as_array().map(Vec::len), Some(3));
    }
}
