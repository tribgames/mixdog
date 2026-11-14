//! The window a request names by app alone (resolveAppWindowId,
//! input/targeting.ts:87-115). A named app never means the foreground window:
//! it resolves to its one window or the request is refused.

use super::{Host, Res};
use crate::platform::WindowInfo;

/// How many candidates an ambiguous app lists.
const MAX_CANDIDATES: usize = 12;

/// The one visible window of `app`, or why there is none. Always an answer:
/// the usual resolution would fall back to the foreground window.
pub(super) fn resolve_app(host: &Host, app: &str) -> Option<Res<WindowInfo>> {
    Some(match host.desktop.windows() {
        Ok(windows) => pick(&windows, app).cloned(),
        Err(_) => Err("could not enumerate windows for app targeting".into()),
    })
}

/// The exact app name without regard to case; failing that, every window
/// whose app, title or class contains it.
fn pick<'a>(windows: &'a [WindowInfo], app: &str) -> Res<&'a WindowInfo> {
    let requested = app.trim().to_lowercase();
    if requested.is_empty() {
        return Err("app target is empty".into());
    }
    let mut matches: Vec<&WindowInfo> = windows
        .iter()
        .filter(|window| window.app.to_lowercase() == requested)
        .collect();
    if matches.is_empty() {
        matches = windows
            .iter()
            .filter(|window| {
                [&window.app, &window.title, &window.class_name]
                    .iter()
                    .any(|value| value.to_lowercase().contains(&requested))
            })
            .collect();
    }
    match matches.as_slice() {
        [] => Err(format!(
            "window_target_not_found: no visible window matched app \"{app}\""
        )),
        [only] => Ok(only),
        several => {
            let candidates: Vec<String> = several
                .iter()
                .take(MAX_CANDIDATES)
                .map(|window| {
                    let title = if window.title.is_empty() {
                        "<untitled>"
                    } else {
                        window.title.as_str()
                    };
                    format!("{} \"{title}\"", window.id())
                })
                .collect();
            Err(format!(
                "ambiguous_window_target: app \"{app}\" matched {} windows ({}); retry with one exact window_id",
                several.len(),
                candidates.join(" | ")
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(handle: u64, app: &str, title: &str, class_name: &str) -> WindowInfo {
        WindowInfo {
            handle,
            app: app.into(),
            title: title.into(),
            class_name: class_name.into(),
            ..Default::default()
        }
    }

    fn desktop() -> Vec<WindowInfo> {
        vec![
            window(1, "explorer", "Documents", "CabinetWClass"),
            window(2, "Notepad", "notes.txt - Notepad", "Notepad"),
            window(3, "notepad++", "todo.md - Notepad++", "Notepad++"),
            window(4, "chrome", "Inbox", "Chrome_WidgetWin_1"),
            window(5, "chrome", "", "Chrome_WidgetWin_1"),
        ]
    }

    fn picked(windows: &[WindowInfo], app: &str) -> Res<u64> {
        pick(windows, app).map(|found| found.handle)
    }

    #[test]
    fn an_exact_app_name_wins_over_windows_that_only_contain_it() {
        // Window 3 contains "notepad" in all three fields.
        assert_eq!(picked(&desktop(), " NOTEPAD "), Ok(2));
    }

    #[test]
    fn without_an_exact_app_the_app_title_or_class_may_contain_the_name() {
        let windows = desktop();
        assert_eq!(picked(&windows, "explor"), Ok(1));
        assert_eq!(picked(&windows, "todo.md"), Ok(3));
        assert_eq!(picked(&windows, "cabinetw"), Ok(1));
    }

    #[test]
    fn several_matches_are_refused_with_their_window_ids() {
        assert_eq!(
            picked(&desktop(), "Chrome"),
            Err(concat!(
                "ambiguous_window_target: app \"Chrome\" matched 2 windows ",
                "(hwnd:0x4 \"Inbox\" | hwnd:0x5 \"<untitled>\"); retry with one exact window_id"
            )
            .to_string())
        );
        let many: Vec<WindowInfo> = (1..=14).map(|n| window(n, "term", "shell", "T")).collect();
        let error = picked(&many, "term").unwrap_err();
        assert!(error.contains("matched 14 windows"), "{error}");
        assert_eq!(error.matches("hwnd:0x").count(), MAX_CANDIDATES);
    }

    #[test]
    fn no_match_and_an_empty_name_are_refused() {
        let windows = desktop();
        assert_eq!(
            picked(&windows, "Paint"),
            Err("window_target_not_found: no visible window matched app \"Paint\"".to_string())
        );
        assert_eq!(picked(&windows, "  "), Err("app target is empty".to_string()));
    }
}
