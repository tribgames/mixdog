//! OCR, clipboard, and application launch.

use super::windows::effect;
use super::{Host, Res};
use crate::obj;
use crate::platform::AppEntry;
use crate::protocol::{Obj, Req};
use base64::Engine;
use serde_json::{json, Value};

/// A bare name can mean a catalogue entry; a path, URL, or executable file
/// name belongs to the system opener.
fn names_catalogue_entry(target: &str) -> bool {
    let lower = target.to_lowercase();
    let scheme = target
        .split_once(':')
        .is_some_and(|(scheme, _)| !scheme.is_empty() && scheme.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) && scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c)));
    !(target.contains('/') || target.contains('\\') || scheme || [".app", ".desktop", ".sh", ".exe", ".bin"].iter().any(|ext| lower.ends_with(ext)))
}

fn matches_like(value: &str, query: &str) -> bool {
    value.to_lowercase().contains(&query.to_lowercase())
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
        match self.desktop.ocr(&image, req.text("ocr_language").trim(), maximum as usize)? {
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
        let message = if text.is_empty() { "cleared clipboard".to_string() } else { format!("clipboard set: {} chars", text.chars().count()) };
        Ok(self.action_result("clipboard_write", "clipboard", effect(verified), verified, &message, None, "background", None))
    }

    fn find_installed_app(&self, target: &str) -> Res<Option<AppEntry>> {
        if !names_catalogue_entry(target) {
            return Ok(None);
        }
        let installed = self.desktop.installed_apps().unwrap_or_default();
        let mut found: Vec<&AppEntry> = installed.iter().filter(|app| app.name == target).collect();
        if found.is_empty() {
            found = installed.iter().filter(|app| app.name.eq_ignore_ascii_case(target)).collect();
        }
        if found.is_empty() {
            found = installed.iter().filter(|app| matches_like(&app.name, target) || matches_like(&app.app_id, target)).collect();
        }
        match found.len() {
            0 => Ok(None),
            1 => Ok(Some(found[0].clone())),
            count => {
                let names: Vec<&str> = found.iter().take(6).map(|app| app.name.as_str()).collect();
                Err(format!("launch failed [ambiguous_app/0] for '{target}': {count} installed apps match ({})", names.join(", ")))
            }
        }
    }

    pub(super) fn launch(&self, req: &Req) -> Res<Obj> {
        let target = req.text("app");
        if target.trim().is_empty() {
            return Err("launch requires app".into());
        }
        self.authorize_current(0)?;
        let app = self.find_installed_app(&target)?;
        let launched = self.desktop.launch(&target, app.as_ref())?;
        let mut result = self.action_result("launch", launched.route, "unverifiable", false, &format!("launched {target}"), None, "background", None);
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

    pub(super) fn list_installed_apps(&self, req: &Req) -> Res<Obj> {
        let query = req.text("query");
        let (apps, error) = match self.desktop.installed_apps() {
            Ok(apps) => (apps, None),
            Err(error) => (Vec::new(), Some(error)),
        };
        let total = apps.len();
        let rows: Vec<Value> = apps
            .iter()
            .filter(|app| query.trim().is_empty() || matches_like(&app.name, &query) || matches_like(&app.app_id, &query))
            .map(|app| json!({ "name": app.name, "app_id": app.app_id, "packaged": false }))
            .collect();
        let mut payload = json!({ "installed": rows, "matched": rows.len(), "catalogue_total": total });
        if let Some(error) = &error {
            payload["catalogue_error"] = json!(error);
        }
        Ok(obj! { "text" => payload.to_string(), "installed" => rows, "catalogue_total" => total })
    }
}

#[cfg(test)]
mod tests {
    use super::names_catalogue_entry;

    #[test]
    fn paths_and_urls_go_to_the_opener() {
        assert!(names_catalogue_entry("Calculator"));
        assert!(names_catalogue_entry("Text Editor"));
        assert!(!names_catalogue_entry("/usr/bin/gedit"));
        assert!(!names_catalogue_entry("https://example.com"));
        assert!(!names_catalogue_entry("Safari.app"));
    }
}
