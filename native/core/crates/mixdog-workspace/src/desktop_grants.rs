//! The desktop's one-file grants (Node: `SelectedFileAccess`, `selected-file-access.ts` and `selected-file-grants.ts`):
//! permission to read one exact file outside every registered project, minted when a window's picker, drop or chat link
//! describes the path and redeemed by the file calls that follow. Unlike [`crate::grants`] (a paired phone's table, in
//! memory, one hour) this store is persisted at [`GRANTS_FILE`] under the data directory so a restart keeps the tokens a
//! window still holds. A token is a random uuid; only its SHA-256 keys the table and the file. The newest
//! [`MAX_DESKTOP_GRANTS`] live, a described file becomes the newest, and describing a file again hands back the token it
//! already has while that grant lives, so a link check never evicts an open editor's grant.

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::error::WsError;
use crate::error::WsResult;
use crate::lanes::Lanes;
use crate::lanes::run_in;
use crate::nodeerr::AtPath;
use crate::pathguard::comparable;
use crate::pathguard::lexical;
use crate::pathguard::resolve;

/// `MAX_SELECTED_FILE_GRANTS`.
pub const MAX_DESKTOP_GRANTS: usize = 100;
/// The store's file, relative to the data directory.
pub const GRANTS_FILE: &str = "desktop/selected-file-grants.json";

const UNAVAILABLE: &str = "The selected-file permission is unavailable.";
const MISMATCH: &str = "The selected-file permission does not match this path.";
const MAX_PATH_TEXT: usize = 16_384;
const MAX_TOKEN_TEXT: usize = 128;
const MAX_ARG_TEXT: usize = 32_768;

/// One described path (`DesktopLocalPathEntry`). A file inside a project carries that project and the path in it, a file
/// outside carries its own folder and name (and the token when one was minted), a folder carries neither.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPathEntry {
    pub absolute_path: String,
    pub name: String,
    pub dir: bool,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rel_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
}

/// What a redeemed grant opens: the granted file as a root (its folder) and the one name in it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Granted {
    pub root: PathBuf,
    pub rel: String,
    pub absolute: PathBuf,
}

/// The grants in the order they were last described, oldest first (a `Map`'s insertion order), as `(tokenHash, file)`.
type Grants = Vec<(String, PathBuf)>;

#[derive(Default)]
struct State {
    loaded: bool,
    grants: Grants,
    /// The token this process issued per file (comparable path), while its grant lives.
    tokens: HashMap<PathBuf, String>,
}

pub struct DesktopGrantStore {
    path: PathBuf,
    lanes: Lanes,
    /// One queue for the load, every commit and every read of the table: a reader never sees a half-loaded map.
    state: Mutex<State>,
}

impl DesktopGrantStore {
    pub fn new(path: PathBuf, lanes: Lanes) -> Arc<Self> {
        Arc::new(Self { path, lanes, state: Mutex::new(State::default()) })
    }

    /// Describes each path (1..=100). `mint` is false for a chat link: a file outside every project is then addressed as its own
    /// folder's file with no token, so nothing is granted, persisted or capped. The picker and drop mint.
    pub async fn describe(&self, paths: &[String], mint: bool, projects: &[PathBuf]) -> WsResult<Vec<LocalPathEntry>> {
        if paths.is_empty() || paths.len() > 100 {
            return Err(WsError::invalid("paths are invalid."));
        }
        let absolutes = paths.iter().map(|raw| absolute_local_path(raw)).collect::<WsResult<Vec<_>>>()?;
        let stats = {
            let absolutes = absolutes.clone();
            run_in(self.lanes.interactive, &CancellationToken::new(), move |proof| {
                absolutes
                    .iter()
                    .map(|path| mixdog_fsio::metadata(proof, path).at("stat", path).map(|info| (info.is_dir(), info.len())))
                    .collect::<WsResult<Vec<_>>>()
            })
            .await??
        };
        let mut rows = Vec::with_capacity(absolutes.len());
        // The files that need a grant: the index of their row, and the file.
        let mut minted: Vec<(usize, PathBuf)> = Vec::new();
        for (absolute, (dir, size)) in absolutes.iter().zip(stats) {
            let mut row = LocalPathEntry {
                absolute_path: absolute.to_string_lossy().into_owned(),
                name: base_name(absolute).unwrap_or_else(|| absolute.to_string_lossy().into_owned()),
                dir,
                size,
                project_path: None,
                rel_path: None,
                access_token: None,
            };
            if !dir {
                if let Some((project, rel)) = owning_project(projects, absolute) {
                    row.project_path = Some(project.to_string_lossy().into_owned());
                    row.rel_path = Some(rel);
                } else {
                    row.project_path = Some(dir_name(absolute).to_string_lossy().into_owned());
                    row.rel_path = base_name(absolute);
                    if mint {
                        minted.push((rows.len(), absolute.clone()));
                    }
                }
            }
            rows.push(row);
        }
        if minted.is_empty() {
            return Ok(rows);
        }
        // Everything was inspected before authority changes; only publication is serialized.
        let mut state = self.state.lock().await;
        self.load(&mut state).await?;
        // Every link verification and hover describes its file again: a fresh token each time would evict the grants of open
        // editors and links (cap 100).
        let mut grants = state.grants.clone();
        let mut tokens: Vec<(PathBuf, String)> = Vec::new();
        for (index, file) in &minted {
            let key = comparable(file);
            let live = |token: &String| state.grants.iter().any(|(hash, _)| *hash == token_hash(token));
            let token = tokens
                .iter()
                .find(|(known, _)| *known == key)
                .map(|(_, token)| token.clone())
                .or_else(|| state.tokens.get(&key).filter(|token| live(token)).cloned())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            // A described file becomes the most recently used grant.
            let hash = token_hash(&token);
            grants.retain(|(known, _)| *known != hash);
            grants.push((hash, file.clone()));
            rows[*index].access_token = Some(token.clone());
            tokens.push((key, token));
        }
        if grants.len() > MAX_DESKTOP_GRANTS {
            grants.drain(..grants.len() - MAX_DESKTOP_GRANTS);
        }
        self.persist(&grants).await?;
        state.tokens.extend(tokens);
        state.tokens.retain(|_, token| grants.iter().any(|(hash, _)| *hash == token_hash(token)));
        state.grants = grants;
        Ok(rows)
    }

    /// The file a token grants, when the path asked for is that file (`requireGrant`).
    pub async fn redeem(&self, token: &str, project_path: &str, rel_path: &str) -> WsResult<Granted> {
        let token = required_string(token, "file access token", MAX_TOKEN_TEXT)?;
        let project_path = required_string(project_path, "projectPath", MAX_ARG_TEXT)?;
        let rel_path = required_string(rel_path, "relPath", MAX_ARG_TEXT)?;
        let granted = self.granted_file(&token).await?.ok_or_else(|| WsError::coded("SELECTED_FILE_GRANT_UNAVAILABLE", UNAVAILABLE))?;
        let requested = resolve(&Path::new(&project_path).join(&rel_path));
        if comparable(&requested) != comparable(&granted) {
            return Err(WsError::coded("MIXDOG_LOCAL_ACCESS_DENIED", MISMATCH));
        }
        Ok(Granted { root: dir_name(&granted), rel: base_name(&granted).unwrap_or_default(), absolute: granted })
    }

    /// Whether the token's grant lives and names exactly `absolute` (false once evicted).
    pub async fn still_granted(&self, token: &str, absolute: &Path) -> WsResult<bool> {
        let token = required_string(token, "file access token", MAX_TOKEN_TEXT)?;
        Ok(self.granted_file(&token).await?.is_some_and(|granted| comparable(&granted) == comparable(&lexical(absolute))))
    }

    async fn granted_file(&self, token: &str) -> WsResult<Option<PathBuf>> {
        let mut state = self.state.lock().await;
        self.load(&mut state).await?;
        let key = token_hash(token);
        Ok(state.grants.iter().find(|(hash, _)| *hash == key).map(|(_, file)| file.clone()))
    }

    /// Reads the file once. A failure to read it, or to write converted rows back, fails the call and leaves the store unloaded, so the
    /// next call retries: a disk failure never becomes an empty authoritative map that a later selection overwrites.
    async fn load(&self, state: &mut State) -> WsResult<()> {
        if state.loaded {
            return Ok(());
        }
        let path = self.path.clone();
        let text = run_in(self.lanes.interactive, &CancellationToken::new(), move |proof| match mixdog_fsio::read(proof, &path) {
            Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(crate::nodeerr::io_error(&error, "open", &path)),
        })
        .await??;
        let (grants, migrated) = parse_grants(text.as_deref().unwrap_or("[]"));
        if migrated {
            self.persist(&grants).await?;
        }
        state.grants = grants;
        state.loaded = true;
        Ok(())
    }

    /// An owner-only atomic replace of the file, with its folder flushed.
    async fn persist(&self, grants: &Grants) -> WsResult<()> {
        let path = self.path.clone();
        let data = serialize_grants(grants);
        run_in(self.lanes.durability, &CancellationToken::new(), move |lane| {
            let opts = mixdog_statefile::Opts { secret: true, fsync_dir: true, ..mixdog_statefile::Opts::default() };
            mixdog_statefile::write_file(lane, &path, &data, &opts).map(drop).map_err(|error| match error {
                mixdog_statefile::StateError::Io(error) => crate::nodeerr::io_error(&error, "rename", &path),
                other => WsError::plain(other.to_string()),
            })
        })
        .await?
    }
}

/// `absoluteLocalPath`: a shape-checked absolute path, resolved without touching the disk. A rooted path with no drive (`\foo`)
/// counts as absolute on Windows, as Node's `isAbsolute` has it, and `resolve` gives it the current drive.
fn absolute_local_path(raw: &str) -> WsResult<PathBuf> {
    let text = raw.trim();
    if text.is_empty() || text.chars().count() > MAX_PATH_TEXT || text.contains('\0') {
        return Err(WsError::invalid("path is invalid."));
    }
    let path = Path::new(text);
    if !path.has_root() {
        return Err(WsError::invalid("path must be absolute."));
    }
    Ok(resolve(path))
}

/// `requiredString`: trimmed, not empty, within `maximum` characters.
fn required_string(value: &str, name: &str, maximum: usize) -> WsResult<String> {
    let text = value.trim();
    if text.is_empty() || text.chars().count() > maximum {
        return Err(WsError::invalid(format!("{name} is invalid.")));
    }
    Ok(text.to_string())
}

/// `path.basename`: the last component's text, none for a root.
fn base_name(path: &Path) -> Option<String> {
    path.file_name().map(|name| name.to_string_lossy().into_owned()).filter(|name| !name.is_empty())
}

/// `path.dirname`: the folder, a root being its own.
fn dir_name(path: &Path) -> PathBuf {
    path.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or(path).to_path_buf()
}

/// `owningProject`: the deepest registered project that contains the file, with the file's path in it (`/` separated); none when
/// it lies outside every project.
fn owning_project<'a>(projects: &'a [PathBuf], file: &Path) -> Option<(&'a PathBuf, String)> {
    let comparable_file = comparable(file);
    let (project, root) = projects
        .iter()
        .map(|project| (project, lexical(project)))
        .filter(|(_, root)| comparable_file.starts_with(comparable(root)))
        .max_by_key(|(_, root)| root.as_os_str().len())?;
    let skip = root.components().count();
    let rel = file.components().skip(skip).map(|part| part.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/");
    Some((project, rel))
}

/// `selectedFileGrantKey`: the SHA-256 of the token, in hex.
fn token_hash(token: &str) -> String {
    Sha256::digest(token.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `parseSelectedFileGrants`: the newest [`MAX_DESKTOP_GRANTS`] rows that name an absolute file. A row with a `tokenHash` is kept
/// as it is, a legacy `{token, file}` row is converted (`migrated`: the caller writes the file again). A document that is not
/// JSON, or not a list, holds nothing.
fn parse_grants(text: &str) -> (Grants, bool) {
    let mut grants: Grants = Vec::new();
    let mut migrated = false;
    let Ok(Value::Array(rows)) = serde_json::from_str::<Value>(text) else { return (grants, migrated) };
    let skip = rows.len().saturating_sub(MAX_DESKTOP_GRANTS);
    for row in &rows[skip..] {
        let Some(record) = row.as_object() else { continue };
        let file = record.get("file").and_then(Value::as_str).unwrap_or_default();
        if !Path::new(file).is_absolute() {
            continue;
        }
        let file = lexical(Path::new(file));
        let hash = record.get("tokenHash").and_then(Value::as_str).unwrap_or_default();
        let key = if hash.len() == 64 && hash.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')) {
            hash.to_string()
        } else {
            let legacy = record.get("token").and_then(Value::as_str).unwrap_or_default();
            if legacy.is_empty() {
                continue;
            }
            migrated = true;
            token_hash(legacy)
        };
        // `Map.set`: a repeated key keeps its place and takes the later file.
        match grants.iter_mut().find(|(known, _)| *known == key) {
            Some(slot) => slot.1 = file,
            None => grants.push((key, file)),
        }
    }
    (grants, migrated)
}

/// `serializeSelectedFileGrants`: `[{tokenHash, file}]`, the newest [`MAX_DESKTOP_GRANTS`].
fn serialize_grants(grants: &Grants) -> Vec<u8> {
    let skip = grants.len().saturating_sub(MAX_DESKTOP_GRANTS);
    let rows: Vec<Value> = grants[skip..]
        .iter()
        .map(|(hash, file)| serde_json::json!({ "tokenHash": hash, "file": file.to_string_lossy() }))
        .collect();
    serde_json::to_vec(&rows).unwrap_or_else(|_| b"[]".to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        _dir: tempfile::TempDir,
        root: PathBuf,
        files: Vec<PathBuf>,
        store_path: PathBuf,
        lanes: Lanes,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let root = crate::pathguard::canonical(dir.path()).unwrap();
            let files = ["a.txt", "b.txt"].map(|name| root.join(name)).to_vec();
            for file in &files {
                std::fs::write(file, "fixture").unwrap();
            }
            let tokens = mixdog_rt::testing::tokens();
            let lanes = Lanes {
                interactive: tokens.interactive_io,
                durability: tokens.durability_io,
                maintenance: tokens.maintenance_io,
                cpu_bulk: tokens.cpu_bulk,
            };
            let store_path = root.join("grants.json");
            Self { _dir: dir, root, files, store_path, lanes }
        }
        fn store(&self) -> Arc<DesktopGrantStore> {
            DesktopGrantStore::new(self.store_path.clone(), self.lanes)
        }
        fn seed(&self, text: &str) {
            std::fs::write(&self.store_path, text).unwrap();
        }
        /// The file as 1.4.5 wrote it for these `(token, file)` pairs.
        fn seed_grants(&self, grants: &[(&str, &Path)]) {
            let rows: Grants = grants.iter().map(|(token, file)| (token_hash(token), file.to_path_buf())).collect();
            std::fs::write(&self.store_path, serialize_grants(&rows)).unwrap();
        }
        fn persisted(&self) -> Grants {
            parse_grants(&std::fs::read_to_string(&self.store_path).unwrap()).0
        }
        fn many(&self, count: usize) -> Vec<PathBuf> {
            (0..count)
                .map(|index| {
                    let file = self.root.join(format!("other-{index}.txt"));
                    std::fs::write(&file, "other").unwrap();
                    file
                })
                .collect()
        }
    }

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    async fn redeem(store: &DesktopGrantStore, token: &str, file: &Path) -> WsResult<Granted> {
        store.redeem(token, &text(&dir_name(file)), &base_name(file).unwrap()).await
    }

    fn token_of(row: &LocalPathEntry) -> String {
        row.access_token.clone().expect("a minted token")
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn concurrent_reads_share_the_initial_load() {
        let f = Fixture::new();
        f.seed_grants(&[("stored-fixture-token", &f.files[0])]);
        let store = f.store();
        let (first, second) = tokio::join!(redeem(&store, "stored-fixture-token", &f.files[0]), redeem(&store, "stored-fixture-token", &f.files[0]));
        assert_eq!(first.unwrap().absolute, f.files[0]);
        assert_eq!(second.unwrap().absolute, f.files[0]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_failed_read_is_retried_and_loses_no_grant() {
        let f = Fixture::new();
        // A folder where the file belongs: reading it fails with something other than "missing".
        std::fs::create_dir(&f.store_path).unwrap();
        let store = f.store();
        assert!(redeem(&store, "stored-fixture-token", &f.files[0]).await.is_err());
        std::fs::remove_dir(&f.store_path).unwrap();
        f.seed_grants(&[("stored-fixture-token", &f.files[0])]);
        assert_eq!(redeem(&store, "stored-fixture-token", &f.files[0]).await.unwrap().absolute, f.files[0]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_rejected_selection_leaves_no_grant_behind() {
        let f = Fixture::new();
        let store = f.store();
        let missing = text(&f.root.join("missing.txt"));
        let error = store.describe(&[text(&f.files[0]), missing], true, &[]).await.unwrap_err();
        assert_eq!(error.reason.code(), "ENOENT", "{error}");
        let rows = store.describe(&[text(&f.files[1])], true, &[]).await.unwrap();
        assert_eq!(f.persisted().len(), 1);
        assert_eq!(redeem(&store, &token_of(&rows[0]), &f.files[1]).await.unwrap().absolute, f.files[1]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_failed_publication_does_not_leak_into_a_later_save() {
        let f = Fixture::new();
        let store = f.store();
        let kept = store.describe(&[text(&f.files[0])], true, &[]).await.unwrap();
        // A folder where the file is published: the rename fails.
        std::fs::remove_file(&f.store_path).unwrap();
        std::fs::create_dir(&f.store_path).unwrap();
        let lost = store.describe(&[text(&f.files[1])], true, &[]).await;
        assert!(lost.is_err());
        std::fs::remove_dir(&f.store_path).unwrap();
        let third = f.many(1);
        let rows = store.describe(&[text(&third[0])], true, &[]).await.unwrap();
        let persisted = f.persisted();
        assert_eq!(persisted.len(), 2);
        assert!(!persisted.iter().any(|(_, file)| *file == f.files[1]));
        assert!(redeem(&store, &token_of(&kept[0]), &f.files[0]).await.is_ok());
        assert!(redeem(&store, &token_of(&rows[0]), &third[0]).await.is_ok());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn describing_a_file_again_keeps_its_token_so_link_checks_never_evict_it() {
        let f = Fixture::new();
        let store = f.store();
        let opened = store.describe(&[text(&f.files[0])], true, &[]).await.unwrap();
        for _ in 0..101 {
            store.describe(&[text(&f.files[1])], true, &[]).await.unwrap();
        }
        assert!(redeem(&store, &token_of(&opened[0]), &f.files[0]).await.is_ok());
        let again = store.describe(&[text(&f.files[0])], true, &[]).await.unwrap();
        assert_eq!(again[0].access_token, opened[0].access_token);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_oldest_grant_is_evicted_past_the_cap_and_a_new_token_follows() {
        let f = Fixture::new();
        let store = f.store();
        let held = store.describe(&[text(&f.files[0])], true, &[]).await.unwrap();
        let held_token = token_of(&held[0]);
        for file in f.many(MAX_DESKTOP_GRANTS) {
            store.describe(&[text(&file)], true, &[]).await.unwrap();
        }
        assert_eq!(f.persisted().len(), MAX_DESKTOP_GRANTS);
        let error = redeem(&store, &held_token, &f.files[0]).await.unwrap_err();
        assert_eq!(error.reason.code(), "SELECTED_FILE_GRANT_UNAVAILABLE");
        assert_eq!(error.message, "The selected-file permission is unavailable.");
        assert!(!store.still_granted(&held_token, &f.files[0]).await.unwrap());
        // Described again, the file is granted again under a new token.
        let renewed = store.describe(&[text(&f.files[0])], true, &[]).await.unwrap();
        assert_ne!(token_of(&renewed[0]), held_token);
        assert!(store.still_granted(&token_of(&renewed[0]), &f.files[0]).await.unwrap());
        assert!(!store.still_granted(&token_of(&renewed[0]), &f.files[1]).await.unwrap());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_re_described_file_becomes_the_newest_grant() {
        let f = Fixture::new();
        let store = f.store();
        let first = store.describe(&[text(&f.files[0])], true, &[]).await.unwrap();
        let others = f.many(MAX_DESKTOP_GRANTS - 1);
        let mut other_tokens = Vec::new();
        for file in &others {
            other_tokens.push(token_of(&store.describe(&[text(file)], true, &[]).await.unwrap()[0]));
        }
        store.describe(&[text(&f.files[0])], true, &[]).await.unwrap();
        store.describe(&[text(&f.files[1])], true, &[]).await.unwrap();
        // The second file pushed out the oldest other file, not the one described again.
        assert!(redeem(&store, &token_of(&first[0]), &f.files[0]).await.is_ok());
        assert!(!store.still_granted(&other_tokens[0], &others[0]).await.unwrap());
        assert!(store.still_granted(&other_tokens[1], &others[1]).await.unwrap());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_chat_link_outside_every_project_has_its_own_folder_and_no_token() {
        let f = Fixture::new();
        let store = f.store();
        let others = f.many(150);
        let all: Vec<String> = f.files.iter().chain(&others).take(100).map(|file| text(file)).collect();
        for row in store.describe(&all, false, &[]).await.unwrap() {
            assert_eq!(row.access_token, None);
            assert_eq!(row.project_path, Some(text(&f.root)));
        }
        let rest: Vec<String> = others[100..].iter().map(|file| text(file)).collect();
        let rows = store.describe(&rest, false, &[]).await.unwrap();
        let rels: Vec<String> = rows.iter().map(|row| row.rel_path.clone().unwrap()).collect();
        assert_eq!(rels, others[100..].iter().map(|file| base_name(file).unwrap()).collect::<Vec<_>>());
        assert!(!f.store_path.exists(), "the grants file is never written for a chat link");
        // A folder has no entry fields.
        let folder = store.describe(&[text(&f.root)], false, &[]).await.unwrap();
        assert!(folder[0].dir);
        assert_eq!((folder[0].project_path.as_ref(), folder[0].rel_path.as_ref()), (None, None));
        // The picker and drop still get their persisted grants, a folder none.
        let picked = store.describe(&[text(&f.files[0]), text(&f.root)], true, &[]).await.unwrap();
        assert!(picked[0].access_token.is_some());
        assert!(picked[1].access_token.is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_file_inside_a_registered_project_is_that_project_file() {
        let f = Fixture::new();
        let store = f.store();
        let nested = f.root.join("src");
        std::fs::create_dir(&nested).unwrap();
        std::fs::write(nested.join("deep.txt"), "x").unwrap();
        let projects = [f.root.clone(), nested.clone()];
        for mint in [false, true] {
            let rows = store.describe(&[text(&f.files[0]), text(&nested.join("deep.txt"))], mint, &projects).await.unwrap();
            assert_eq!(rows[0].project_path, Some(text(&f.root)));
            assert_eq!(rows[0].rel_path.as_deref(), Some("a.txt"));
            assert_eq!(rows[1].project_path, Some(text(&nested)), "the deepest project owns it");
            assert_eq!(rows[1].rel_path.as_deref(), Some("deep.txt"));
            assert!(rows.iter().all(|row| row.access_token.is_none()));
        }
        assert!(!f.store_path.exists());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn concurrent_selections_survive_a_reload_and_a_mismatch_is_refused() {
        let f = Fixture::new();
        let store = f.store();
        let (a, b) = tokio::join!(store.describe(&[text(&f.files[0])], true, &[]), store.describe(&[text(&f.files[1])], true, &[]));
        let (a, b) = (token_of(&a.unwrap()[0]), token_of(&b.unwrap()[0]));
        let reloaded = f.store();
        assert_eq!(redeem(&reloaded, &a, &f.files[0]).await.unwrap().absolute, f.files[0]);
        assert_eq!(redeem(&reloaded, &b, &f.files[1]).await.unwrap().absolute, f.files[1]);
        let granted = redeem(&reloaded, &a, &f.files[0]).await.unwrap();
        assert_eq!((granted.root, granted.rel), (f.root.clone(), "a.txt".to_string()));
        let error = redeem(&reloaded, &a, &f.files[1]).await.unwrap_err();
        assert_eq!(error.reason.code(), "MIXDOG_LOCAL_ACCESS_DENIED");
        assert_eq!(error.message, "The selected-file permission does not match this path.");
        // The path may be spelled with `.` and `..`.
        let spelled = reloaded.redeem(&a, &text(&f.root.join("x").join("..")), "a.txt").await.unwrap();
        assert_eq!(spelled.absolute, f.files[0]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_store_written_by_1_4_5_loads_and_redeems() {
        let f = Fixture::new();
        let row = |token: &str, file: &Path| format!(r#"{{"tokenHash":"{}","file":{}}}"#, token_hash(token), serde_json::to_string(&text(file)).unwrap());
        f.seed(&format!("[{},{}]", row("t-a", &f.files[0]), row("t-b", &f.files[1])));
        let store = f.store();
        assert!(redeem(&store, "t-a", &f.files[0]).await.is_ok());
        assert!(redeem(&store, "t-b", &f.files[1]).await.is_ok());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn legacy_token_rows_are_converted_and_written_again() {
        let f = Fixture::new();
        let legacy = serde_json::json!([{ "token": "plain-token", "file": text(&f.files[0]) }, { "token": "", "file": text(&f.files[1]) }, { "token": "x", "file": "relative.txt" }, 7]);
        f.seed(&legacy.to_string());
        let store = f.store();
        assert!(redeem(&store, "plain-token", &f.files[0]).await.is_ok());
        let written = std::fs::read_to_string(&f.store_path).unwrap();
        assert!(!written.contains("plain-token"), "{written}");
        assert_eq!(f.persisted(), vec![(token_hash("plain-token"), f.files[0].clone())]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_missing_or_malformed_store_holds_nothing() {
        let f = Fixture::new();
        let store = f.store();
        let error = redeem(&store, "anything", &f.files[0]).await.unwrap_err();
        assert_eq!(error.reason.code(), "SELECTED_FILE_GRANT_UNAVAILABLE");
        for document in ["", "{not json", "{\"a\":1}"] {
            f.seed(document);
            assert!(redeem(&f.store(), "anything", &f.files[0]).await.is_err());
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn arguments_are_checked_like_the_main_process_checked_them() {
        let f = Fixture::new();
        let store = f.store();
        for paths in [vec![], vec!["relative.txt".to_string()], vec!["  ".to_string()], vec!["a\0b".to_string()], vec![text(&f.files[0]); 101]] {
            assert_eq!(store.describe(&paths, true, &[]).await.unwrap_err().reason.code(), "invalidParams");
        }
        assert_eq!(store.redeem("", "/", "a").await.unwrap_err().reason.code(), "invalidParams");
        assert_eq!(store.redeem(&"t".repeat(129), "/", "a").await.unwrap_err().reason.code(), "invalidParams");
    }

    #[test]
    fn the_file_keeps_the_newest_hundred_rows_and_a_repeated_key_keeps_its_place() {
        let dir = std::env::temp_dir();
        let rows: Vec<Value> = (0..120).map(|index| serde_json::json!({ "tokenHash": token_hash(&index.to_string()), "file": text(&dir.join(format!("f{index}"))) })).collect();
        let (grants, migrated) = parse_grants(&Value::Array(rows).to_string());
        assert!(!migrated);
        assert_eq!(grants.len(), 100);
        assert_eq!(grants[0].0, token_hash("20"));
        let doubled = serde_json::json!([{ "tokenHash": token_hash("a"), "file": text(&dir.join("one")) }, { "tokenHash": token_hash("b"), "file": text(&dir.join("two")) }, { "tokenHash": token_hash("a"), "file": text(&dir.join("three")) }]);
        let (grants, _) = parse_grants(&doubled.to_string());
        assert_eq!(grants, vec![(token_hash("a"), dir.join("three")), (token_hash("b"), dir.join("two"))]);
    }
}
