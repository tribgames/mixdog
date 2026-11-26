//! The one client capability offered to an agent: reading a text file of the session's folder, or of the folder its
//! attachments are kept in.
//! Writing is not offered, so the agent keeps editing with its own tools and reports diffs.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::fs::FileService;
use mixdog_core_api::domain::fs::ReadRange;
use mixdog_rt::InteractiveIo;
use mixdog_rt::LaneToken;
use serde_json::Value;
use serde_json::json;

use crate::connection::RpcError;

#[async_trait]
pub trait TextFiles: Send + Sync {
    async fn read(&self, path: AbsPath) -> Result<String, String>;
    /// Up to `len` bytes of the file at `path` from `offset`, none at its end. This default reads the whole file.
    async fn read_bytes(&self, path: AbsPath, offset: u64, len: u64) -> Result<Vec<u8>, String> {
        let bytes = self.read(path).await?.into_bytes();
        let start = usize::try_from(offset).unwrap_or(usize::MAX).min(bytes.len());
        let end = start.saturating_add(usize::try_from(len).unwrap_or(usize::MAX)).min(bytes.len());
        Ok(bytes[start..end].to_vec())
    }
    /// The folders beside a session's own whose files its agent may read: where the attachments it is linked to are kept.
    fn readable_roots(&self) -> Vec<AbsPath> {
        Vec::new()
    }
    /// `path` with every link on it followed: the place a read of it reaches.
    async fn resolved(&self, path: AbsPath) -> Result<AbsPath, String>;
    /// Puts `text` in a new file at `path`, its folders made: the file appears with all of its text at once, and one
    /// already there is kept. The agent definitions Mixdog starts a CLI with, each at a place its text names.
    async fn create(&self, path: AbsPath, text: String) -> Result<(), String>;
    /// Makes the folder `path` with its parents; one already there is kept. The temporary folder of an agent's server.
    async fn make_folder(&self, _path: AbsPath) -> Result<(), String> {
        Err("no folder is made here".to_owned())
    }
    /// Removes the folder `path` with all it holds; one that is not there is removed already.
    async fn remove_folder(&self, _path: AbsPath) -> Result<(), String> {
        Err("no folder is removed here".to_owned())
    }
    /// The names of the folders directly in `path`; none where `path` is not there.
    async fn folders(&self, _path: AbsPath) -> Result<Vec<String>, String> {
        Err("no folder is listed here".to_owned())
    }
    /// Puts `text` in the file at `path`, its folders made, in place of one already there: a reader finds the old text
    /// whole or the new text whole. What the agents keep of their builds and of what they told.
    async fn replace(&self, _path: AbsPath, _text: String) -> Result<(), String> {
        Err("no file is written here".to_owned())
    }
    /// Moves the file or folder `from` to `to`, the folders of `to` made; a file at `to` is replaced at once.
    async fn rename(&self, _from: AbsPath, _to: AbsPath) -> Result<(), String> {
        Err("nothing is moved here".to_owned())
    }
    /// Removes the file `path`; one that is not there is removed already.
    async fn remove_file(&self, _path: AbsPath) -> Result<(), String> {
        Err("no file is removed here".to_owned())
    }
}

impl ServiceFiles {
    /// Runs `job` on the files' lane; `what` names what it does, for its failure.
    async fn on_lane<R: Send + 'static>(&self, what: &str, job: impl FnOnce() -> std::io::Result<R> + Send + 'static) -> Result<R, String> {
        match self.lane.submit(&tokio_util::sync::CancellationToken::new(), move |_| job()) {
            Ok(job) => job.await.map_err(|_| format!("{what} failed"))?.map_err(|error| error.to_string()),
            Err(_) => Err(format!("{what} failed")),
        }
    }
}

/// [`TextFiles`] over the core's file service.
pub struct ServiceFiles {
    pub files: Arc<dyn FileService>,
    pub lane: InteractiveIo,
}

#[async_trait]
impl TextFiles for ServiceFiles {
    async fn read(&self, path: AbsPath) -> Result<String, String> {
        let read = self.files.read(self.lane, path, ReadRange::default()).await.map_err(|error| format!("{:?}", error.kind))?;
        String::from_utf8(read.bytes).map_err(|_| NOT_TEXT.to_owned())
    }

    async fn read_bytes(&self, path: AbsPath, offset: u64, len: u64) -> Result<Vec<u8>, String> {
        let read = self.files.read(self.lane, path, ReadRange { offset, max_len: Some(len) }).await.map_err(|error| format!("{:?}", error.kind))?;
        Ok(read.bytes)
    }

    async fn resolved(&self, path: AbsPath) -> Result<AbsPath, String> {
        #[allow(clippy::disallowed_methods, reason = "a lane job")]
        let job = self.lane.submit(&tokio_util::sync::CancellationToken::new(), move |_| std::fs::canonicalize(path.as_path()));
        let resolved = match job {
            Ok(job) => job.await.map_err(|_| "the file could not be looked at".to_owned())?,
            Err(_) => return Err("the file could not be looked at".to_owned()),
        };
        resolved.map_err(|error| error.to_string()).and_then(|path| AbsPath::new(path).ok_or_else(|| "the file has no absolute place".to_owned()))
    }

    async fn create(&self, path: AbsPath, text: String) -> Result<(), String> {
        #[allow(clippy::disallowed_methods, reason = "a lane job")]
        let job = self.lane.submit(&tokio_util::sync::CancellationToken::new(), move |_| {
            let folder = path.as_path().parent().ok_or_else(|| std::io::Error::other("the file has no folder"))?;
            std::fs::create_dir_all(folder)?;
            // Written whole beside its place, then linked into it: a CLI starting meanwhile reads all of it or nothing.
            let staged = folder.join(format!(".{}.staged", uuid::Uuid::new_v4().simple()));
            std::fs::write(&staged, text)?;
            let linked = std::fs::hard_link(&staged, path.as_path());
            std::fs::remove_file(&staged)?;
            match linked {
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
                linked => linked,
            }
        });
        match job {
            Ok(job) => job.await.map_err(|_| "the file could not be written".to_owned())?.map_err(|error| error.to_string()),
            Err(_) => Err("the file could not be written".to_owned()),
        }
    }

    async fn make_folder(&self, path: AbsPath) -> Result<(), String> {
        #[allow(clippy::disallowed_methods, reason = "a lane job")]
        let job = self.lane.submit(&tokio_util::sync::CancellationToken::new(), move |_| std::fs::create_dir_all(path.as_path()));
        match job {
            Ok(job) => job.await.map_err(|_| "the folder could not be made".to_owned())?.map_err(|error| error.to_string()),
            Err(_) => Err("the folder could not be made".to_owned()),
        }
    }

    async fn remove_folder(&self, path: AbsPath) -> Result<(), String> {
        #[allow(clippy::disallowed_methods, reason = "a lane job")]
        let job = self.lane.submit(&tokio_util::sync::CancellationToken::new(), move |_| match std::fs::remove_dir_all(path.as_path()) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            removed => removed,
        });
        match job {
            Ok(job) => job.await.map_err(|_| "the folder could not be removed".to_owned())?.map_err(|error| error.to_string()),
            Err(_) => Err("the folder could not be removed".to_owned()),
        }
    }

    async fn folders(&self, path: AbsPath) -> Result<Vec<String>, String> {
        #[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "a lane job")]
        let job = self.lane.submit(&tokio_util::sync::CancellationToken::new(), move |_| {
            let entries = match std::fs::read_dir(path.as_path()) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
                entries => entries?,
            };
            let mut folders = Vec::new();
            for entry in entries {
                let entry = entry?;
                if entry.file_type()?.is_dir() {
                    folders.push(entry.file_name().to_string_lossy().into_owned());
                }
            }
            Ok::<_, std::io::Error>(folders)
        });
        match job {
            Ok(job) => job.await.map_err(|_| "the folder could not be listed".to_owned())?.map_err(|error| error.to_string()),
            Err(_) => Err("the folder could not be listed".to_owned()),
        }
    }

    async fn replace(&self, path: AbsPath, text: String) -> Result<(), String> {
        // Written whole beside its place, then moved onto it.
        #[allow(clippy::disallowed_methods, reason = "a lane job")]
        let job = move || {
            let folder = path.as_path().parent().ok_or_else(|| std::io::Error::other("the file has no folder"))?;
            std::fs::create_dir_all(folder)?;
            let staged = folder.join(format!(".{}.staged", uuid::Uuid::new_v4().simple()));
            std::fs::write(&staged, text)?;
            let renamed = std::fs::rename(&staged, path.as_path());
            if renamed.is_err() {
                let _ = std::fs::remove_file(&staged);
            }
            renamed
        };
        self.on_lane("writing the file", job).await
    }

    async fn rename(&self, from: AbsPath, to: AbsPath) -> Result<(), String> {
        #[allow(clippy::disallowed_methods, reason = "a lane job")]
        let job = move || {
            if let Some(folder) = to.as_path().parent() {
                std::fs::create_dir_all(folder)?;
            }
            std::fs::rename(from.as_path(), to.as_path())
        };
        self.on_lane("moving the file", job).await
    }

    async fn remove_file(&self, path: AbsPath) -> Result<(), String> {
        #[allow(clippy::disallowed_methods, reason = "a lane job")]
        let job = move || match std::fs::remove_file(path.as_path()) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            removed => removed,
        };
        self.on_lane("removing the file", job).await
    }
}

/// The protocol's answer to a request about a resource that is not there (`RESOURCE_NOT_FOUND`).
pub(crate) const RESOURCE_NOT_FOUND: i64 = -32002;

const NOT_TEXT: &str = "the file is not UTF-8 text";

/// How much of a file a read of some of its lines takes at a time.
const READ_CHUNK: u64 = 64 * 1024;

/// Where a read the agent asked for goes.
enum Place {
    /// The resolved file.
    File(AbsPath),
    /// Nothing is there.
    Missing,
}

/// `path` with every link on it followed: the deepest part of it that is there resolved, with the names below it that
/// are not. `None` for a path that steps out of a part that is not there.
async fn resolved(files: &dyn TextFiles, path: AbsPath) -> Option<(std::path::PathBuf, bool)> {
    let mut at = path.as_path().to_path_buf();
    let mut missing = Vec::new();
    loop {
        if let Ok(found) = files.resolved(AbsPath::new(at.clone())?).await {
            let mut place = found.as_path().to_path_buf();
            place.extend(missing.iter().rev());
            return Some((place, !missing.is_empty()));
        }
        missing.push(at.file_name()?.to_owned());
        at.pop();
    }
}

/// The place to read for `path`, when it names one inside one of `roots` or one of the exact files in `allowed_files`
/// by where it resolves to: a link or junction inside a folder that points out of it is outside, and names are compared
/// as the file system resolves them, so a name that differs only in case from the folder's on a system that ignores
/// case is inside. The place is the resolved one that was checked, so a link changed after the check leads the read
/// nowhere else.
async fn inside(files: &dyn TextFiles, roots: &[AbsPath], allowed_files: &[AbsPath], path: &str) -> Option<Place> {
    let (place, missing) = resolved(files, AbsPath::new(path)?).await?;
    let mut folders = Vec::new();
    for root in roots {
        folders.extend(files.resolved(root.clone()).await);
    }
    let in_root = folders.iter().any(|folder| place.starts_with(folder.as_path()));
    let mut in_attached = false;
    if !in_root {
        for allowed in allowed_files {
            if let Some((allowed_place, _)) = resolved(files, allowed.clone()).await
                && place == allowed_place
            {
                in_attached = true;
                break;
            }
        }
    }
    if !in_root && !in_attached {
        return None;
    }
    Some(if missing { Place::Missing } else { Place::File(AbsPath::new(place)?) })
}

/// The file `path` names, resolved, where it is there and inside one of `roots` as [`inside`] tells.
pub(crate) async fn inside_file(files: &dyn TextFiles, roots: &[AbsPath], path: &str) -> Option<AbsPath> {
    match inside(files, roots, &[], path).await? {
        Place::File(path) => Some(path),
        Place::Missing => None,
    }
}

fn invalid(message: &str) -> RpcError {
    RpcError { code: -32602, message: message.to_owned(), data: Value::Null }
}

/// The request's `key`, a whole number of at least 1, where it gives one.
fn count(params: &Value, key: &str) -> Result<Option<usize>, RpcError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .filter(|count| *count > 0)
            .and_then(|count| usize::try_from(count).ok())
            .map(Some)
            .ok_or_else(|| invalid(&format!("{key} must be a whole number of at least 1"))),
    }
}

/// The lines of the file at `path` from line `first` (0-based), `limit` of them where it is given, read a chunk at a
/// time up to the last line they take.
async fn lines(files: &dyn TextFiles, path: AbsPath, first: usize, limit: Option<usize>) -> Result<String, String> {
    let last = limit.map(|limit| first.saturating_add(limit));
    let (mut taken, mut line, mut offset) = (Vec::new(), 0_usize, 0_u64);
    'read: loop {
        let chunk = files.read_bytes(path.clone(), offset, READ_CHUNK).await?;
        if chunk.is_empty() {
            break;
        }
        offset += chunk.len() as u64;
        for byte in chunk {
            if line >= first {
                taken.push(byte);
            }
            if byte == b'\n' {
                line += 1;
                if last == Some(line) {
                    break 'read;
                }
            }
        }
    }
    String::from_utf8(taken).map_err(|_| NOT_TEXT.to_owned())
}

/// The answer to the agent's `fs/read_text_file` of a file in `cwd`, in a folder of [`TextFiles::readable_roots`], or
/// in `allowed_files` (attached files linked into this session's prompts): `line` is 1-based, `limit` counts lines.
pub async fn read_text_file_with(files: &dyn TextFiles, cwd: &AbsPath, allowed_files: &[AbsPath], params: &Value) -> Result<Value, RpcError> {
    let requested = params.get("path").and_then(Value::as_str).ok_or_else(|| invalid("path is required"))?;
    let (line, limit) = (count(params, "line")?, count(params, "limit")?);
    let roots: Vec<AbsPath> = std::iter::once(cwd.clone()).chain(files.readable_roots()).collect();
    let path = match inside(files, &roots, allowed_files, requested).await {
        Some(Place::File(path)) => path,
        Some(Place::Missing) => return Err(RpcError { code: RESOURCE_NOT_FOUND, message: format!("{requested} was not found"), data: Value::Null }),
        None => return Err(invalid(&format!("{} is outside the session's folder {}", requested, Path::display(cwd.as_path())))),
    };
    let content = match (line, limit) {
        (None, None) => files.read(path).await,
        (line, limit) => lines(files, path, line.unwrap_or(1) - 1, limit).await,
    };
    let content = content.map_err(|message| {
        let code = if message == "NotFound" { RESOURCE_NOT_FOUND } else { -32603 };
        RpcError { code, message, data: Value::Null }
    })?;
    Ok(json!({ "content": content }))
}

/// The answer to the agent's `fs/read_text_file` of a file in `cwd` or in a folder of [`TextFiles::readable_roots`]:
/// `line` is 1-based, `limit` counts lines.
pub async fn read_text_file(files: &dyn TextFiles, cwd: &AbsPath, params: &Value) -> Result<Value, RpcError> {
    read_text_file_with(files, cwd, &[], params).await
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// Files in memory under one folder, each read noted as the bytes it asked for (`None` for a whole read).
    struct Memory {
        folder: AbsPath,
        files: Vec<(AbsPath, String)>,
        reads: Mutex<Vec<Option<(u64, u64)>>>,
    }

    impl Memory {
        fn of(name: &str, text: String) -> Self {
            let folder = AbsPath::new(std::env::temp_dir().join("memory")).expect("absolute");
            Self { files: vec![(folder.join(name), text)], folder, reads: Mutex::default() }
        }

        fn text(&self, path: &AbsPath) -> Result<String, String> {
            self.files.iter().find(|(at, _)| at == path).map(|(_, text)| text.clone()).ok_or_else(|| "NotFound".to_owned())
        }
    }

    #[async_trait]
    impl TextFiles for Memory {
        async fn read(&self, path: AbsPath) -> Result<String, String> {
            self.reads.lock().unwrap().push(None);
            self.text(&path)
        }

        async fn read_bytes(&self, path: AbsPath, offset: u64, len: u64) -> Result<Vec<u8>, String> {
            self.reads.lock().unwrap().push(Some((offset, len)));
            let bytes = self.text(&path)?.into_bytes();
            let start = (offset as usize).min(bytes.len());
            Ok(bytes[start..(start + len as usize).min(bytes.len())].to_vec())
        }

        async fn resolved(&self, path: AbsPath) -> Result<AbsPath, String> {
            let there = path == self.folder || self.files.iter().any(|(at, _)| *at == path);
            if there { Ok(path) } else { Err("NotFound".to_owned()) }
        }

        async fn create(&self, _: AbsPath, _: String) -> Result<(), String> {
            Err("read-only".to_owned())
        }
    }

    /// A read of some lines of a long file takes the chunk that holds them and nothing after it.
    #[tokio::test]
    async fn a_read_of_some_lines_reads_only_as_far_as_its_last_line() {
        let text: String = (1..=300_000).map(|n| format!("line {n}\n")).collect();
        let files = Memory::of("big.txt", text);
        let path = files.folder.join("big.txt");
        let asked = json!({ "path": path.as_path(), "line": 2, "limit": 2 });
        let read = read_text_file(&files, &files.folder, &asked).await.expect("the lines");
        assert_eq!(read["content"], "line 2\nline 3\n");
        assert_eq!(*files.reads.lock().unwrap(), [Some((0, READ_CHUNK))], "the read went past the lines it was asked for");
    }

    /// A `line` or a `limit` that is no whole number of at least 1 is the request's error, and nothing is read.
    #[tokio::test]
    async fn a_line_or_limit_that_is_no_whole_number_of_at_least_one_is_refused() {
        let files = Memory::of("a.txt", "one\ntwo\n".to_owned());
        let path = files.folder.join("a.txt");
        for key in ["line", "limit"] {
            for value in [json!(0), json!(-1), json!(1.5), json!("2")] {
                let mut asked = json!({ "path": path.as_path() });
                asked[key] = value.clone();
                let refused = read_text_file(&files, &files.folder, &asked).await.expect_err("an invalid request");
                assert_eq!(refused.code, -32602, "{key}={value}: {}", refused.message);
            }
        }
        assert!(files.reads.lock().unwrap().is_empty());
    }

    /// A missing file inside `cwd` returns `RESOURCE_NOT_FOUND` (-32002), a case-variant path canonicalizing inside
    /// `cwd` is accepted, and an attached file outside `cwd` is readable while unattached siblings are refused.
    #[tokio::test]
    async fn missing_file_casing_and_attached_outside_cwd_behave_correctly() {
        struct CasingMemory {
            folder: AbsPath,
            outside: AbsPath,
            files: Vec<(AbsPath, String)>,
        }
        #[async_trait]
        impl TextFiles for CasingMemory {
            async fn read(&self, path: AbsPath) -> Result<String, String> {
                self.files
                    .iter()
                    .find(|(at, _)| at.as_path().to_string_lossy().eq_ignore_ascii_case(&path.as_path().to_string_lossy()))
                    .map(|(_, text)| text.clone())
                    .ok_or_else(|| "NotFound".to_owned())
            }
            async fn resolved(&self, path: AbsPath) -> Result<AbsPath, String> {
                let raw = path.as_path().to_string_lossy();
                if self.folder.as_path().to_string_lossy().eq_ignore_ascii_case(&raw) {
                    return Ok(self.folder.clone());
                }
                if self.outside.as_path().to_string_lossy().eq_ignore_ascii_case(&raw) {
                    return Ok(self.outside.clone());
                }
                self.files
                    .iter()
                    .find(|(at, _)| at.as_path().to_string_lossy().eq_ignore_ascii_case(&raw))
                    .map(|(at, _)| at.clone())
                    .ok_or_else(|| "NotFound".to_owned())
            }
            async fn create(&self, _: AbsPath, _: String) -> Result<(), String> {
                Err("read-only".to_owned())
            }
        }

        let base = std::env::temp_dir().join("mixdog-acp-files-case-test");
        let folder = AbsPath::new(base.join("WorkDir")).expect("absolute");
        let outside = AbsPath::new(base.join("Blobs")).expect("absolute");
        let attached = outside.join("attached.txt");
        let sibling = outside.join("secret.txt");
        let files = CasingMemory {
            files: vec![(folder.join("Note.txt"), "inside".into()), (attached.clone(), "blob-text".into()), (sibling.clone(), "nope".into())],
            folder: folder.clone(),
            outside,
        };

        // Missing file inside cwd -> -32002 (RESOURCE_NOT_FOUND).
        let missing = read_text_file(&files, &folder, &json!({ "path": folder.join("absent.txt").as_path() })).await.expect_err("missing");
        assert_eq!(missing.code, RESOURCE_NOT_FOUND);

        // Case-variant path canonicalizing inside cwd -> allowed.
        let lower_path = folder.join("Note.txt").as_path().to_string_lossy().to_ascii_lowercase();
        let read = read_text_file(&files, &folder, &json!({ "path": lower_path })).await.expect("case-variant passes");
        assert_eq!(read["content"], "inside");

        // Attached file outside cwd -> allowed only for the session whose allowed_files includes it; sibling and other sessions still refused.
        let denied_before = read_text_file(&files, &folder, &json!({ "path": attached.as_path() })).await.expect_err("outside before allow");
        assert_eq!(denied_before.code, -32602);
        let allowed =
            read_text_file_with(&files, &folder, std::slice::from_ref(&attached), &json!({ "path": attached.as_path() })).await.expect("attached allowed");
        assert_eq!(allowed["content"], "blob-text");
        let denied_other_session = read_text_file_with(&files, &folder, &[], &json!({ "path": attached.as_path() })).await.expect_err("other session denied");
        assert_eq!(denied_other_session.code, -32602);
        let denied_sibling = read_text_file_with(&files, &folder, std::slice::from_ref(&attached), &json!({ "path": sibling.as_path() }))
            .await
            .expect_err("sibling still denied");
        assert_eq!(denied_sibling.code, -32602);
    }
}
