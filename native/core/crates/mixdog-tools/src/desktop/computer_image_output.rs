//! `image_output: "file"` for the computer surface (`observation/capture-image-output.ts`, `frame-files.ts`): the pixels move
//! to a file beside the run instead of into the conversation. The host chooses the path, so a caller never names a file and
//! this can never become an arbitrary write; old frames are pruned so a long session cannot fill the disk. A failed write is
//! an error the caller answers by keeping the inline frame, because losing the pixels silently would be worse than spending
//! the tokens.

use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use mixdog_core_api::domain::computer::ComputerError;

/// Newest frames kept on disk for the computer surface.
const FRAME_MAX_FILES: usize = 40;
/// The largest single frame written.
const FRAME_MAX_BYTES: usize = 100 * 1024 * 1024;
/// The most bytes the kept frames may hold together.
const FRAME_MAX_TOTAL_BYTES: u64 = 500 * 1024 * 1024;

/// A write and its prune run as one step, so an eviction can never land after a later write of the same name.
static WRITES: Mutex<()> = Mutex::new(());

/// Where computer frames are written: `<data>/frames/computer/<session>/<frame>.<ext>`.
#[derive(Clone, Debug)]
pub struct ImageOutput {
    root: PathBuf,
}

struct Entry {
    path: PathBuf,
    modified_at: u128,
    bytes: u64,
}

fn failed(message: impl Into<String>) -> ComputerError {
    ComputerError::Failed { code: "image_file_failed".to_owned(), message: message.into() }
}

fn extension(mime: &str) -> &'static str {
    match mime {
        "application/pdf" => "pdf",
        "image/png" => "png",
        _ => "jpg",
    }
}

/// Keeps `[A-Za-z0-9_.-]` and turns every run of anything else into one `_` (`/[^\w.-]+/g`), cut to `limit` characters.
fn sanitized(text: &str, limit: usize) -> String {
    let mut out = String::new();
    let mut in_run = false;
    for c in text.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('_');
            in_run = true;
        }
    }
    out.chars().take(limit).collect()
}

fn modified_nanos(time: SystemTime) -> u128 {
    time.duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_nanos())
}

fn is_frame_file(path: &Path) -> bool {
    path.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| {
        ext.eq_ignore_ascii_case("jpg") || ext.eq_ignore_ascii_case("png") || ext.eq_ignore_ascii_case("pdf")
    })
}

/// The frame files of every session folder under the root.
fn scan(root: &Path) -> Vec<Entry> {
    let mut entries = Vec::new();
    let Ok(sessions) = fs::read_dir(root) else { return entries };
    for session in sessions.flatten() {
        let Ok(files) = fs::read_dir(session.path()) else { continue };
        for file in files.flatten() {
            let path = file.path();
            if !is_frame_file(&path) {
                continue;
            }
            // A file removed between listing and stat counts for nothing, as in `scanFrames`.
            let (modified_at, bytes) = match file.metadata() {
                Ok(info) => (info.modified().map_or(0, modified_nanos), info.len()),
                Err(_) => (0, 0),
            };
            entries.push(Entry { path, modified_at, bytes });
        }
    }
    entries
}

/// Keeps the newest `FRAME_MAX_FILES` frames within `FRAME_MAX_TOTAL_BYTES`, the one just written first of all
/// (`pruneFrames`), and removes the rest and any session folder left empty.
fn prune(root: &Path, protected: &Path) {
    let mut files = scan(root);
    files.sort_by(|left, right| {
        (right.path == protected)
            .cmp(&(left.path == protected))
            .then(right.modified_at.cmp(&left.modified_at))
            .then(left.path.cmp(&right.path))
    });
    let mut retained = 0u64;
    let mut kept = 0usize;
    for entry in &files {
        if kept < FRAME_MAX_FILES && retained + entry.bytes <= FRAME_MAX_TOTAL_BYTES {
            retained += entry.bytes;
            kept += 1;
        } else {
            let _ = fs::remove_file(&entry.path);
            if let Some(folder) = entry.path.parent() {
                let _ = fs::remove_dir(folder);
            }
        }
    }
}

impl ImageOutput {
    /// `data_dir` is the Mixdog data directory the backend already holds (`ComputerConfig::data_dir`).
    pub fn new(data_dir: &Path) -> Self {
        Self { root: data_dir.join("frames").join("computer") }
    }

    /// The same frame files under another surface's folder (the browser engine's `<data>/frames/browser`).
    pub fn at(root: PathBuf) -> Self {
        Self { root }
    }

    /// Writes the pixels for `frame_id` of `session` and prunes older frames; returns the file's path.
    pub fn write(&self, session: &str, frame_id: &str, bytes: &[u8], mime: &str) -> Result<PathBuf, ComputerError> {
        if bytes.is_empty() || bytes.len() > FRAME_MAX_BYTES {
            return Err(failed("the image is empty or larger than a frame file may be"));
        }
        let session = match sanitized(session, 60) {
            name if name.is_empty() => "session".to_owned(),
            name => name,
        };
        let stamp = match sanitized(frame_id, 40) {
            name if name.is_empty() => base36(modified_nanos(SystemTime::now()) / 1_000_000),
            name => name,
        };
        let directory = self.root.join(&session);
        let path = directory.join(format!("{session}-{stamp}.{}", extension(mime)));
        let _guard = WRITES.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        fs::create_dir_all(&directory).map_err(|error| failed(format!("frame folder: {error}")))?;
        fs::write(&path, bytes).map_err(|error| failed(format!("frame file: {error}")))?;
        prune(&self.root, &path);
        Ok(path)
    }
}

fn base36(mut value: u128) -> String {
    if value == 0 {
        return "0".to_owned();
    }
    let mut digits = Vec::new();
    while value > 0 {
        digits.push(char::from_digit((value % 36) as u32, 36).unwrap_or('0'));
        value /= 36;
    }
    digits.iter().rev().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::time::Duration;

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mixdog-image-output-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn the_file_lands_under_the_session_folder_with_the_mime_extension() {
        let data = temp_root("layout");
        let output = ImageOutput::new(&data);
        let jpg = output.write("sess/one", "f1", b"jpeg", "image/jpeg").unwrap();
        let png = output.write("sess/one", "f2", b"png", "image/png").unwrap();
        let pdf = output.write("sess/one", "f3", b"pdf", "application/pdf").unwrap();
        let folder = data.join("frames").join("computer").join("sess_one");
        assert_eq!(jpg, folder.join("sess_one-f1.jpg"));
        assert_eq!(png, folder.join("sess_one-f2.png"));
        assert_eq!(pdf, folder.join("sess_one-f3.pdf"));
        assert_eq!(fs::read(&jpg).unwrap(), b"jpeg");
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn names_are_sanitised_and_bounded_and_default_when_empty() {
        assert_eq!(sanitized("a b/c", 60), "a_b_c");
        assert_eq!(sanitized("x".repeat(80).as_str(), 60).len(), 60);
        assert_eq!(base36(35), "z");
        let data = temp_root("names");
        let output = ImageOutput::new(&data);
        let path = output.write("", "", b"x", "image/jpeg").unwrap();
        assert!(path.starts_with(data.join("frames").join("computer").join("session")));
        assert!(path.file_name().unwrap().to_str().unwrap().starts_with("session-"));
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn an_empty_image_is_refused() {
        let data = temp_root("empty");
        assert!(ImageOutput::new(&data).write("s", "f", b"", "image/jpeg").is_err());
        assert!(!data.exists());
    }

    #[test]
    fn only_the_newest_frames_are_kept_and_the_one_just_written_always() {
        let data = temp_root("prune");
        let output = ImageOutput::new(&data);
        let folder = data.join("frames").join("computer").join("s");
        fs::create_dir_all(&folder).unwrap();
        // 45 older frames with distinct, increasing modification times.
        let base = SystemTime::now() - Duration::from_secs(10_000);
        for index in 0..45u64 {
            let file = File::create(folder.join(format!("s-old{index}.jpg"))).unwrap();
            file.set_modified(base + Duration::from_secs(index)).unwrap();
        }
        // Another session's old frame competes in the same budget and its emptied folder goes.
        let other = data.join("frames").join("computer").join("t");
        fs::create_dir_all(&other).unwrap();
        File::create(other.join("t-old.jpg")).unwrap().set_modified(base - Duration::from_secs(5)).unwrap();
        let written = output.write("s", "new", b"fresh", "image/jpeg").unwrap();
        let left: Vec<_> = scan(&data.join("frames").join("computer"));
        assert_eq!(left.len(), FRAME_MAX_FILES);
        assert!(written.exists());
        assert!(!folder.join("s-old0.jpg").exists());
        assert!(folder.join("s-old44.jpg").exists());
        assert!(!other.exists());
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn a_write_into_an_unwritable_place_is_an_error_not_a_panic() {
        let data = temp_root("blocked");
        fs::create_dir_all(&data).unwrap();
        // `frames` is a file, so the folder cannot be created.
        fs::write(data.join("frames"), b"not a folder").unwrap();
        let result = ImageOutput::new(&data).write("s", "f", b"x", "image/jpeg");
        assert!(matches!(result, Err(ComputerError::Failed { .. })));
        let _ = fs::remove_dir_all(&data);
    }
}
