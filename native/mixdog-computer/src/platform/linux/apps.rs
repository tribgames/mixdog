//! Desktop entries, launching detached from this host, OCR through the
//! Tesseract command, and clipboard tools for Wayland sessions.

use crate::platform::{AppEntry, Launched};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::Write;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn data_dirs() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let mut dirs = vec![std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".local/share"))];
    let system = std::env::var("XDG_DATA_DIRS").unwrap_or_else(|_| "/usr/local/share:/usr/share".into());
    dirs.extend(system.split(':').filter(|dir| !dir.is_empty()).map(PathBuf::from));
    dirs.push(home.join(".local/share/flatpak/exports/share"));
    dirs.push(PathBuf::from("/var/lib/flatpak/exports/share"));
    dirs.push(PathBuf::from("/var/lib/snapd/desktop"));
    dirs
}

/// The `[Desktop Entry]` group of one desktop file.
fn desktop_entry(path: &Path) -> Option<BTreeMap<String, String>> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut entries = BTreeMap::new();
    let mut in_group = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_group = line == "[Desktop Entry]";
            continue;
        }
        if !in_group || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            entries.entry(key.trim().to_string()).or_insert_with(|| value.trim().to_string());
        }
    }
    Some(entries)
}

pub fn installed() -> Vec<AppEntry> {
    let mut apps: BTreeMap<String, AppEntry> = BTreeMap::new();
    for dir in data_dirs() {
        let Ok(entries) = std::fs::read_dir(dir.join("applications")) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("desktop") {
                continue;
            }
            let id = path.file_stem().and_then(|stem| stem.to_str()).unwrap_or_default().to_string();
            if apps.contains_key(&id) {
                continue;
            }
            let Some(fields) = desktop_entry(&path) else { continue };
            let hidden = ["NoDisplay", "Hidden"].iter().any(|key| fields.get(*key).is_some_and(|value| value == "true"));
            if hidden || fields.get("Type").is_some_and(|kind| kind != "Application") || !fields.contains_key("Exec") {
                continue;
            }
            let name = fields.get("Name").cloned().unwrap_or_else(|| id.clone());
            apps.insert(id.clone(), AppEntry { name, app_id: id });
        }
    }
    let mut list: Vec<AppEntry> = apps.into_values().collect();
    list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    list
}

fn find_desktop_file(id: &str) -> Option<PathBuf> {
    data_dirs().into_iter().map(|dir| dir.join("applications").join(format!("{id}.desktop"))).find(|path| path.is_file())
}

/// The Exec line split into arguments, with field codes removed.
fn exec_arguments(exec: &str) -> Vec<String> {
    let mut arguments = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut chars = exec.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => quoted = !quoted,
            '\\' if quoted => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            c if c.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    arguments.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(c),
        }
    }
    if !current.is_empty() {
        arguments.push(current);
    }
    arguments
        .into_iter()
        .filter(|argument| !(argument.len() == 2 && argument.starts_with('%')))
        .map(|argument| argument.replace("%%", "%"))
        .collect()
}

fn spawn_detached(program: &str, arguments: &[String]) -> std::io::Result<u32> {
    let mut command = Command::new(program);
    command.args(arguments).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    // SAFETY: setsid in the child only detaches it from this host's session.
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    command.spawn().map(|child| child.id())
}

fn on_path(name: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|paths| std::env::split_paths(&paths).any(|dir| dir.join(name).is_file()))
}

fn failure(target: &str, error: &std::io::Error) -> String {
    let category = match error.kind() {
        std::io::ErrorKind::NotFound => "target_not_found",
        std::io::ErrorKind::PermissionDenied => "access_denied",
        _ => "shell_launch_failed",
    };
    format!("launch failed [{category}/{}] for '{target}': {error}", error.raw_os_error().unwrap_or(0))
}

pub fn launch(target: &str, app: Option<&AppEntry>) -> Result<Launched, String> {
    if let Some(app) = app {
        let path = find_desktop_file(&app.app_id).ok_or_else(|| format!("launch failed [target_not_found/2] for '{target}': desktop entry {} is gone", app.app_id))?;
        let fields = desktop_entry(&path).unwrap_or_default();
        let arguments = exec_arguments(fields.get("Exec").map(String::as_str).unwrap_or_default());
        let (program, rest) = arguments.split_first().ok_or_else(|| format!("launch failed [shell_launch_failed/0] for '{target}': empty Exec line"))?;
        let pid = spawn_detached(program, rest).map_err(|error| failure(target, &error))?;
        return Ok(Launched { route: "desktop_entry", pid: pid as i64, app_id: app.app_id.clone(), app_hint: fields.get("Name").cloned().unwrap_or_default() });
    }
    if target.contains('/') || target.contains(':') {
        if Path::new(target).is_file() && std::fs::metadata(target).is_ok_and(|meta| std::os::unix::fs::PermissionsExt::mode(&meta.permissions()) & 0o111 != 0) {
            let pid = spawn_detached(target, &[]).map_err(|error| failure(target, &error))?;
            return Ok(Launched { route: "exec", pid: pid as i64, app_id: String::new(), app_hint: String::new() });
        }
        spawn_detached("xdg-open", &[target.to_string()]).map_err(|error| failure(target, &error))?;
        return Ok(Launched { route: "xdg_open", pid: 0, app_id: String::new(), app_hint: String::new() });
    }
    if on_path(target) {
        let pid = spawn_detached(target, &[]).map_err(|error| failure(target, &error))?;
        return Ok(Launched { route: "exec", pid: pid as i64, app_id: String::new(), app_hint: target.to_string() });
    }
    let hint = if target.contains(' ') { "; launch takes one executable, path, file, or URL and passes no command-line arguments" } else { "" };
    Err(format!("launch failed [target_not_found/2] for '{target}': no installed application or executable has that name{hint}"))
}

fn tesseract_languages() -> Option<Vec<String>> {
    let output = Command::new("tesseract").arg("--list-langs").output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout).to_string() + &String::from_utf8_lossy(&output.stderr);
    Some(text.lines().skip(1).map(|line| line.trim().to_string()).filter(|line| !line.is_empty() && !line.contains(' ')).collect())
}

/// Maps a BCP-47 tag to Tesseract's three-letter language data names.
fn tesseract_language(tag: &str) -> String {
    let primary = tag.split(['-', '_']).next().unwrap_or("").to_lowercase();
    match primary.as_str() {
        "en" => "eng", "ko" => "kor", "ja" => "jpn", "zh" => "chi_sim", "de" => "deu", "fr" => "fra", "es" => "spa",
        "it" => "ita", "pt" => "por", "ru" => "rus", "nl" => "nld", "pl" => "pol", "tr" => "tur", "vi" => "vie", "ar" => "ara",
        "" => "eng",
        other => return other.to_string(),
    }
    .to_string()
}

const TESSERACT_HINT: &str = "ocr_unavailable: install Tesseract (for example `sudo apt install tesseract-ocr tesseract-ocr-kor`) to read text from pixels";

pub fn ocr_status(language: &str) -> Value {
    let installed = tesseract_languages();
    let requested = (!language.is_empty()).then(|| language.to_string());
    let wanted = tesseract_language(language);
    let available = installed.as_ref().is_some_and(|langs| langs.contains(&wanted));
    json!({
        "text": "Tesseract OCR readiness",
        "available": available,
        "requested_language": requested,
        "active_language": if available { Some(wanted) } else { None },
        "installed_languages": installed.unwrap_or_default(),
        "hint": if available { Value::Null } else { json!(TESSERACT_HINT) },
    })
}

pub fn ocr(image: &[u8], language: &str, max_words: usize) -> Result<Value, String> {
    let mut languages = vec![tesseract_language(language)];
    if language.is_empty() {
        if let Some(installed) = tesseract_languages() {
            languages = ["eng", "kor"].iter().filter(|lang| installed.iter().any(|have| have == *lang)).map(|lang| lang.to_string()).collect();
            if languages.is_empty() {
                languages = installed.into_iter().filter(|lang| lang != "osd").take(1).collect();
            }
        }
    }
    let mut child = Command::new("tesseract")
        .args(["stdin", "stdout", "-l", &languages.join("+"), "--psm", "3", "tsv"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| TESSERACT_HINT.to_string())?;
    child.stdin.take().ok_or("ocr_failed: no input pipe")?.write_all(image).map_err(|error| format!("ocr_failed: {error}"))?;
    let output = child.wait_with_output().map_err(|error| format!("ocr_failed: {error}"))?;
    if !output.status.success() {
        return Err(format!("ocr_failed: tesseract: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(parse_tsv(&String::from_utf8_lossy(&output.stdout), &languages.join("+"), max_words))
}

/// Tesseract TSV rows: level page block par line word left top width height conf text.
fn parse_tsv(tsv: &str, language: &str, max_words: usize) -> Value {
    let mut image = (0i64, 0i64);
    let mut lines: Vec<(String, i64, i64, i64, i64, Vec<String>)> = Vec::new();
    let mut keys: BTreeMap<(i64, i64, i64, i64), usize> = BTreeMap::new();
    let mut words = Vec::new();
    let mut total = 0usize;
    for row in tsv.lines().skip(1) {
        let cols: Vec<&str> = row.split('\t').collect();
        if cols.len() < 12 {
            continue;
        }
        let number = |index: usize| cols[index].trim().parse::<i64>().unwrap_or(0);
        let (level, left, top, width, height) = (number(0), number(6), number(7), number(8), number(9));
        if level == 1 {
            image = (width, height);
            continue;
        }
        if level != 5 || cols[11].trim().is_empty() {
            continue;
        }
        let key = (number(1), number(2), number(3), number(4));
        let line = *keys.entry(key).or_insert_with(|| {
            lines.push((String::new(), i64::MAX, i64::MAX, i64::MIN, i64::MIN, Vec::new()));
            lines.len() - 1
        });
        let entry = &mut lines[line];
        entry.1 = entry.1.min(left);
        entry.2 = entry.2.min(top);
        entry.3 = entry.3.max(left + width);
        entry.4 = entry.4.max(top + height);
        entry.5.push(cols[11].trim().to_string());
        if words.len() < max_words {
            words.push(json!({
                "text": cols[11].trim(),
                "line": line,
                "x": left, "y": top, "width": width, "height": height,
                "center_x": left + width / 2, "center_y": top + height / 2,
            }));
        }
        total += 1;
    }
    let lines: Vec<Value> = lines
        .into_iter()
        .enumerate()
        .map(|(index, (_, left, top, right, bottom, text))| {
            json!({ "line": index, "text": text.join(" "), "x": left, "y": top, "width": right - left, "height": bottom - top })
        })
        .collect();
    json!({
        "text": format!("OCR: {} lines, {total} words", lines.len()),
        "language": language,
        "image_width": image.0,
        "image_height": image.1,
        "lines": lines,
        "words": words,
        "total_words": total,
        "truncated_words": total.saturating_sub(max_words.min(total)),
    })
}

const CLIPBOARD_HINT: &str = "clipboard_unavailable: install wl-clipboard (`wl-copy`/`wl-paste`) for clipboard access on Wayland";

pub fn wayland_clipboard_read() -> Result<String, String> {
    let output = Command::new("wl-paste").args(["--no-newline", "--type", "text/plain"]).output().map_err(|_| CLIPBOARD_HINT.to_string())?;
    Ok(if output.status.success() { String::from_utf8_lossy(&output.stdout).into_owned() } else { String::new() })
}

pub fn wayland_clipboard_write(text: &str) -> Result<bool, String> {
    if text.is_empty() {
        let status = Command::new("wl-copy").arg("--clear").status().map_err(|_| CLIPBOARD_HINT.to_string())?;
        return Ok(status.success());
    }
    let mut child = Command::new("wl-copy").stdin(Stdio::piped()).spawn().map_err(|_| CLIPBOARD_HINT.to_string())?;
    child.stdin.take().ok_or("clipboard_unavailable: no input pipe")?.write_all(text.as_bytes()).map_err(|error| error.to_string())?;
    child.wait().map_err(|error| error.to_string())?;
    Ok(wayland_clipboard_read()? == text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exec_field_codes_are_dropped() {
        assert_eq!(exec_arguments("gedit %U"), vec!["gedit"]);
        assert_eq!(exec_arguments("\"/opt/My App/app\" --flag %f"), vec!["/opt/My App/app", "--flag"]);
    }

    #[test]
    fn tsv_rows_group_into_lines() {
        let tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n\
1\t1\t0\t0\t0\t0\t0\t0\t200\t100\t-1\t\n\
5\t1\t1\t1\t1\t1\t10\t10\t30\t12\t95\tHello\n\
5\t1\t1\t1\t1\t2\t50\t10\t40\t12\t95\tworld\n";
        let result = parse_tsv(tsv, "eng", 10);
        assert_eq!(result["image_width"], 200);
        assert_eq!(result["lines"][0]["text"], "Hello world");
        assert_eq!(result["lines"][0]["width"], 80);
        assert_eq!(result["total_words"], 2);
    }

    #[test]
    fn language_tags_map_to_tesseract_names() {
        assert_eq!(tesseract_language("ko-KR"), "kor");
        assert_eq!(tesseract_language(""), "eng");
    }
}
