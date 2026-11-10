//! The one-file grants of a paired phone (`createSelectedFileGrants`, `remote-methods.ts`): permission to read one exact
//! file outside every registered project, minted when the phone describes the path (or opens an attachment) and redeemed
//! by the file calls that follow. Held per paired device (the credential, so a reconnect keeps the tokens the client
//! already has), a token names one exact path and nothing else, each lives an hour (renewed when the same file is minted
//! again), a grant minted for a conversation ends with it, and a device holds the newest [`MAX_GRANTS`]. The tokens
//! are random; only their SHA-256 keys the table, as `selectedFileGrantKey` does.

use std::collections::HashSet;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

use sha2::Digest;
use sha2::Sha256;

use crate::error::Reason;
use crate::error::WsError;
use crate::error::WsResult;
use crate::pathguard::lexical;
use crate::transfer::IdleClock;

/// `MAX_SELECTED_FILE_GRANTS`.
pub const MAX_GRANTS: usize = 100;
/// `BRIDGE_GRANT_TTL_MS`.
pub const GRANT_TTL: Duration = Duration::from_secs(60 * 60);

pub const GRANT_UNAVAILABLE_CODE: &str = "SELECTED_FILE_GRANT_UNAVAILABLE";
const UNAVAILABLE: &str = "The selected-file permission is unavailable.";
const MISMATCH: &str = "The selected-file permission does not match this path.";

/// Whether a conversation still exists (Node: `catalog.has(sessionId)` of the download service).
#[async_trait::async_trait]
pub trait SessionCatalog: Send + Sync {
    async fn has(&self, session_id: &str) -> WsResult<bool>;

    /// The conversation's row in the host's current catalog (Node's `host.listSessions()` entry, `sessionRow`): `None` for one the
    /// catalog does not list. A catalog that cannot say lists none, so a download of it is refused.
    async fn row(&self, _session_id: &str) -> WsResult<Option<SessionRow>> {
        Ok(None)
    }

    /// The file the host's media store holds for an asset id (Node's `invokeCapability('resolveMediaFile', [id, { variant: 'original',
    /// generate: false }])`): `None` for an asset the store does not know or whose bytes are gone (Node's `null` or `available: false`).
    /// A catalog without a media store has none.
    async fn media(&self, _asset_id: &str) -> WsResult<Option<MediaEntry>> {
        Ok(None)
    }
}

/// What the host's media store resolves an asset to: the file's path and, when the store states one, its type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaEntry {
    pub path: String,
    pub mime: Option<String>,
}

/// What a download needs of a conversation (Node's `DesktopSessionSummary`): whether it is a project conversation, its project as the
/// conversation states it, and its folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRow {
    pub project: bool,
    pub project_path: Option<String>,
    pub cwd: String,
}

type Table = Mutex<Vec<(String, Grant)>>;

struct Grant {
    path: PathBuf,
    session_id: String,
    expires_at: Instant,
    token: String,
}

/// What a redeemed grant names: the file's folder and name, which the read opens and verifies again.
#[derive(Debug, PartialEq, Eq)]
pub struct Granted {
    pub root: PathBuf,
    pub rel: String,
    pub absolute: PathBuf,
}

pub struct GrantStore {
    clock: Arc<dyn IdleClock>,
    catalog: Arc<dyn SessionCatalog>,
    /// Per credential, the device's table of grants (insertion ordered: the most recently used last).
    devices: Mutex<HashMap<String, Arc<Table>>>,
    /// The table each connection took when it first used a grant: Node's method table holds the device's table object from then on.
    bound: Mutex<HashMap<u64, Arc<Table>>>,
    /// Conversations the published catalog has contained: only these can be "gone" (Node: `seenSessions.has(id) && !catalog.has(id)`,
    /// `seenSessions` filled by `retainCatalog` on each publication, `file-downloads.ts:472`).
    seen: Mutex<HashSet<String>>,
    /// Told the credential of a device that unpaired, so what else the device holds ends in the same step (the downloads).
    unpaired: std::sync::OnceLock<Arc<dyn Fn(&str) + Send + Sync>>,
    /// Told the conversations each publication lists, in the step it is published (the downloads' catalog membership).
    listed: std::sync::OnceLock<Arc<dyn Fn(&[&str]) + Send + Sync>>,
}

/// `selectedFileGrantKey`.
fn key_of(token: &str) -> String {
    Sha256::digest(token.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `comparablePath`: lower case on Windows.
fn comparable(path: &Path) -> String {
    let text = path.to_string_lossy().into_owned();
    if cfg!(windows) { text.to_lowercase() } else { text }
}

fn same_path(granted: &Path, requested: &Path) -> bool {
    comparable(granted) == comparable(requested)
}

/// `requiredString(value, name, maximum)`: trimmed, not empty, at most `maximum` UTF-16 units.
fn required(value: &str, name: &str, maximum: usize) -> WsResult<String> {
    let text = value.trim();
    if text.is_empty() || text.encode_utf16().count() > maximum {
        return Err(WsError::invalid(format!("{name} is invalid.")));
    }
    Ok(text.to_owned())
}

impl GrantStore {
    pub fn new(clock: Arc<dyn IdleClock>, catalog: Arc<dyn SessionCatalog>) -> Self {
        Self { clock, catalog, devices: Mutex::default(), bound: Mutex::default(), seen: Mutex::default(), unpaired: std::sync::OnceLock::new(), listed: std::sync::OnceLock::new() }
    }

    /// Connects what is told the conversations each catalog publication lists. Set once.
    pub fn on_listed(&self, hook: Arc<dyn Fn(&[&str]) + Send + Sync>) {
        let _ = self.listed.set(hook);
    }

    /// Connects what else ends when a device unpairs. Set once.
    pub fn on_unpaired(&self, hook: Arc<dyn Fn(&str) + Send + Sync>) {
        let _ = self.unpaired.set(hook);
    }

    /// Whether a published catalog has listed the conversation (Node's `seenSessions`): only such a conversation can be gone.
    pub fn has_seen(&self, session_id: &str) -> bool {
        self.seen.lock().expect("grant sessions").contains(session_id)
    }

    /// Unpair (`dropFileGrants`): the device's table is dropped, so a connection of it that arrives afterwards starts with no grant.
    /// A connection that already took the table keeps it for as long as it lives, as Node's method table keeps the object
    /// (`remote-relay-device-methods.ts` `methodsFor` / `dropFileGrants`); the relay ends such a connection when it removed the pairing.
    pub fn revoke_device(&self, credential: &str) {
        self.devices.lock().expect("grants").remove(credential);
        if let Some(unpaired) = self.unpaired.get() {
            unpaired(credential);
        }
    }

    /// The relay handle closed. Node's download service and device grant tables are the handle's own (`remote-relay.ts:185`), so its
    /// `close` ends every device's grants (`clearFileGrants`, `:654`) and the next handle starts with no seen conversation: the grant
    /// tables and the seen conversations go together (dropping the seen set alone would let a held grant outlive its conversation's
    /// removal). This is the only bound Node's `seenSessions` has.
    pub fn relay_closed(&self) {
        // The grants themselves end, also in a table a connection still holds until its teardown: nothing granted before the close is
        // redeemed after it (Node's method tables die with the old handle's connections).
        for table in self.bound.lock().expect("grants").values() {
            table.lock().expect("grants").clear();
        }
        for table in self.devices.lock().expect("grants").values() {
            table.lock().expect("grants").clear();
        }
        self.devices.lock().expect("grants").clear();
        self.seen.lock().expect("grant sessions").clear();
    }

    /// Node's `session_row` is the catalog's; the media store's file for an asset is too (see [`SessionCatalog::media`]).
    pub async fn media(&self, asset_id: &str) -> WsResult<Option<MediaEntry>> {
        self.catalog.media(asset_id).await
    }

    /// The connection ended: it holds no table any more.
    pub fn release(&self, connection: u64) {
        self.bound.lock().expect("grants").remove(&connection);
    }

    /// The table of `credential` this connection holds, taken now if it has none.
    fn table(&self, credential: &str, connection: u64) -> Arc<Table> {
        let mut bound = self.bound.lock().expect("grants");
        bound.entry(connection).or_insert_with(|| self.devices.lock().expect("grants").entry(credential.to_owned()).or_default().clone()).clone()
    }

    /// Node's `sessionRow`: the conversation a download names, as the catalog lists it now.
    pub async fn session_row(&self, session_id: &str) -> WsResult<Option<SessionRow>> {
        self.catalog.row(session_id).await
    }

    pub async fn conversation_gone(&self, session_id: &str) -> WsResult<bool> {
        if session_id.is_empty() || !self.seen.lock().expect("grant sessions").contains(session_id) {
            return Ok(false);
        }
        Ok(!self.catalog.has(session_id).await?)
    }

    /// `rememberFileGrant(absolutePath, sessionId)`: the live grant of this device for this file and conversation
    /// is renewed and keeps its token; otherwise a new token is made and the device's oldest go past the cap.
    pub async fn mint(&self, credential: &str, connection: u64, path: &Path, session_id: &str) -> WsResult<String> {
        let gone = self.conversation_gone(session_id).await?;
        let now = self.clock.now();
        let table = self.table(credential, connection);
        let mut grants = table.lock().expect("grants");
        let mut at = 0;
        while at < grants.len() {
            if grants[at].1.session_id != session_id || !same_path(&grants[at].1.path, path) {
                at += 1;
                continue;
            }
            let (key, mut grant) = grants.remove(at);
            if grant.expires_at <= now || gone {
                continue;
            }
            grant.expires_at = now + GRANT_TTL;
            let token = grant.token.clone();
            grants.push((key, grant));
            return Ok(token);
        }
        let token = uuid::Uuid::new_v4().to_string();
        grants.push((
            key_of(&token),
            Grant { path: path.to_path_buf(), session_id: session_id.to_owned(), expires_at: now + GRANT_TTL, token: token.clone() },
        ));
        while grants.len() > MAX_GRANTS {
            grants.remove(0);
        }
        Ok(token)
    }

    /// `grantedFile(accessToken, projectPath, relPath)`, check for check as Node orders them: the token
    /// (1..=128 characters), the grant being held, alive and its conversation present, then the two path
    /// arguments, then the requested path being exactly the granted file.
    pub async fn redeem(&self, credential: &str, connection: u64, token: &str, project_path: &str, rel_path: &str) -> WsResult<Granted> {
        let token = required(token, "file access token", 128)?;
        let key = key_of(&token);
        let session_id = {
            let grants = self.table(credential, connection);
            let grants = grants.lock().expect("grants");
            grants.iter().find(|(held, _)| *held == key).map(|(_, grant)| grant.session_id.clone())
        };
        let gone = match &session_id {
            Some(session_id) => self.conversation_gone(session_id).await?,
            None => false,
        };
        let now = self.clock.now();
        let granted = {
            let table = self.table(credential, connection);
            let mut grants = table.lock().expect("grants");
            let at = grants.iter().position(|(held, _)| *held == key);
            let live = at.is_some_and(|at| grants[at].1.expires_at > now && !gone);
            if !live {
                if let Some(at) = at {
                    grants.remove(at);
                }
                return Err(WsError::new(Reason::GrantUnavailable, UNAVAILABLE));
            }
            grants[at.expect("live")].1.path.clone()
        };
        let project = required(project_path, "projectPath", 32_768)?;
        let rel = required(rel_path, "relPath", 32_768)?;
        let base = std::path::absolute(&project).map_err(|_| WsError::invalid("projectPath is invalid."))?;
        let requested = lexical(&base.join(rel));
        if !same_path(&granted, &requested) {
            return Err(WsError::new(Reason::GrantMismatch, MISMATCH));
        }
        let root = granted.parent().map(Path::to_path_buf).unwrap_or_default();
        let name = granted.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        Ok(Granted { root, rel: name, absolute: granted })
    }
}

impl GrantStore {
    /// Whether this device holds a live grant for exactly `path` (the grant `redeem` would honour for a token naming it:
    /// alive, its conversation present). A file call that names the file by its path, not by the token, is the
    /// device's own grant only when this holds.
    pub async fn holds(&self, credential: &str, connection: u64, path: &Path) -> WsResult<bool> {
        let held: Vec<(String, Instant)> = {
            let table = self.table(credential, connection);
            let grants = table.lock().expect("grants");
            grants.iter().filter(|(_, grant)| same_path(&grant.path, path)).map(|(_, grant)| (grant.session_id.clone(), grant.expires_at)).collect()
        };
        let now = self.clock.now();
        for (session_id, expires_at) in held {
            if expires_at > now && !self.conversation_gone(&session_id).await? {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

impl mixdog_core_api::state::CatalogObserver for GrantStore {
    /// A catalog publication: every session in it is seen from now on.
    fn published(&self, session_ids: &[&str]) {
        self.seen.lock().expect("grant sessions").extend(session_ids.iter().map(|id| (*id).to_owned()));
        if let Some(listed) = self.listed.get() {
            listed(session_ids);
        }
    }
}

/// `owningProject`: the deepest registered project that contains the file, and the file's path in it with `/`.
pub fn owning_project<'a>(projects: &'a [String], file: &Path) -> Option<(&'a str, String)> {
    let target = comparable(file);
    let separator = std::path::MAIN_SEPARATOR;
    projects
        .iter()
        .filter_map(|project| {
            let root = lexical(&std::path::absolute(project).ok()?);
            let prefix = comparable(&root);
            (target.starts_with(&format!("{prefix}{separator}")) || target == prefix).then_some((project.as_str(), root))
        })
        .max_by_key(|(_, root)| root.as_os_str().len())
        .map(|(project, root)| {
            let relative = file.strip_prefix(&root).map(Path::to_path_buf).unwrap_or_else(|_| {
                // A case-folded match on Windows: strip by length.
                let rest = file.to_string_lossy().chars().skip(root.to_string_lossy().chars().count()).collect::<String>();
                PathBuf::from(rest.trim_start_matches(['/', '\\']))
            });
            (project, relative.to_string_lossy().replace('\\', "/"))
        })
}
#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicU64;
    use std::sync::atomic::Ordering;

    use super::*;

    struct Manual(Instant, AtomicU64);

    impl IdleClock for Manual {
        fn now(&self) -> Instant {
            self.0 + Duration::from_millis(self.1.load(Ordering::SeqCst))
        }
    }

    #[derive(Default)]
    struct Catalog(Mutex<HashSet<String>>);

    #[async_trait::async_trait]
    impl SessionCatalog for Catalog {
        async fn has(&self, session_id: &str) -> WsResult<bool> {
            Ok(!self.0.lock().unwrap().contains(session_id))
        }
    }

    /// Node's flow (`fixtures/desktop/grants/record.mjs`, recorded on win32), replayed step for step: the same
    /// mints and redemptions, an hour of life moved by a manual clock, the conversation going away, the cap.
    #[tokio::test]
    async fn the_grant_flow_matches_the_recorded_node_steps() {
        let recorded: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/desktop/grants/corpus.json"
        )))
        .unwrap();
        let clock = Arc::new(Manual(Instant::now(), AtomicU64::new(0)));
        let catalog = Arc::new(Catalog::default());
        let store = GrantStore::new(clock.clone(), catalog.clone());
        let base = std::env::temp_dir().join("outside");
        let file = |name: &str| base.join(name);
        let mut tokens: HashMap<String, String> = HashMap::new();
        let mut steps = recorded["steps"].as_array().unwrap().iter();

        // The recorded step must be the one this replay is at, so the two cannot drift apart.
        let mut next = |label: &str| -> serde_json::Value {
            let step = steps.next().unwrap_or_else(|| panic!("no recorded step for {label}"));
            assert_eq!(step["label"], label);
            step.clone()
        };
        macro_rules! mint {
            ($name:expr, $path:expr, $session:expr) => {{
                let token = store.mint("dev", 1, &$path, $session).await.unwrap();
                tokens.insert($name.to_owned(), token);
            }};
        }
        let same = |tokens: &HashMap<String, String>, a: &str, b: &str| tokens[a] == tokens[b];
        // A step's answer is the redeemed file, or the error: same sentence, same code.
        let check = |recorded: &serde_json::Value, got: WsResult<Granted>, base: &Path, name: &str| {
            let label = recorded["label"].as_str().unwrap();
            match (recorded.get("ok"), got) {
                (Some(ok), Ok(granted)) => {
                    assert_eq!(granted.rel, ok["rel"].as_str().unwrap(), "{label}");
                    assert_eq!(granted.absolute, base.join(name), "{label}");
                    assert_eq!(granted.root, base, "{label}");
                }
                (Some(_), Err(error)) => panic!("{label}: Node granted it, got {error}"),
                (None, Ok(_)) => panic!("{label}: Node refused it with {}", recorded["error"]),
                (None, Err(error)) => {
                    assert_eq!(error.message, recorded["error"]["message"].as_str().unwrap(), "{label}");
                    if let Some(code) = recorded["error"]["code"].as_str() {
                        assert_eq!(error.reason.code(), code, "{label}");
                    }
                }
            }
        };
        let tok = |tokens: &HashMap<String, String>, name: &str| tokens.get(name).cloned().unwrap_or_else(|| name.to_owned());
        let advance = |minutes: u64| {
            clock.1.fetch_add(minutes * 60_000, Ordering::SeqCst);
        };

        mint!("a", file("a.txt"), "");
        next("mint a.txt for no conversation");
        mint!("a2", file("a.txt"), "");
        let step = next("mint a.txt again: the same token");
        assert_eq!(step["ok"]["same"], same(&tokens, "a", "a2"));
        mint!("a-s1", file("a.txt"), "s1");
        let step = next("mint a.txt for a conversation: another token");
        assert_eq!(step["ok"]["same"], same(&tokens, "a", "a-s1"));
        mint!("a-s1b", file("a.txt"), "s1");
        let step = next("mint a.txt for that conversation again: its token");
        assert_eq!(step["ok"]["same"], same(&tokens, "a-s1", "a-s1b"));

        let step = next("redeem with the folder and name");
        check(&step, store.redeem("dev", 1, &tok(&tokens, "a"), base.to_str().unwrap(), "a.txt").await, &base, "a.txt");
        // Windows compares file names without case; elsewhere the names differ.
        let step = next("redeem with the folder and the name in another case");
        let got = store.redeem("dev", 1, &tok(&tokens, "a"), base.to_str().unwrap(), "A.TXT").await;
        if cfg!(windows) {
            check(&step, got, &base, "a.txt");
        } else {
            assert_eq!(got.unwrap_err().message, "The selected-file permission does not match this path.");
        }
        let step = next("redeem with a relative path inside the folder");
        check(&step, store.redeem("dev", 1, &tok(&tokens, "a"), base.to_str().unwrap(), "sub/../a.txt").await, &base, "a.txt");
        let step = next("redeem for another file");
        check(&step, store.redeem("dev", 1, &tok(&tokens, "a"), base.to_str().unwrap(), "b.txt").await, &base, "b.txt");
        let step = next("redeem for the parent folder");
        let parent = base.parent().unwrap().to_str().unwrap().to_owned();
        check(&step, store.redeem("dev", 1, &tok(&tokens, "a"), &parent, "outside/a.txt").await, &base, "a.txt");
        let step = next("redeem an unknown token");
        check(&step, store.redeem("dev", 1, "no-such-token", base.to_str().unwrap(), "a.txt").await, &base, "a.txt");
        let step = next("redeem an empty token");
        check(&step, store.redeem("dev", 1, "", base.to_str().unwrap(), "a.txt").await, &base, "a.txt");
        let step = next("redeem a token longer than 128");
        check(&step, store.redeem("dev", 1, &"x".repeat(129), base.to_str().unwrap(), "a.txt").await, &base, "a.txt");
        // "a token that is not a string" cannot be sent: the request decoder refuses it before the store.
        next("redeem a token that is not a string");
        let step = next("redeem with an empty project path");
        check(&step, store.redeem("dev", 1, &tok(&tokens, "a"), "", "a.txt").await, &base, "a.txt");
        let step = next("redeem with an empty rel path");
        check(&step, store.redeem("dev", 1, &tok(&tokens, "a"), base.to_str().unwrap(), "").await, &base, "a.txt");

        advance(59);
        let step = next("redeem after 59 minutes");
        check(&step, store.redeem("dev", 1, &tok(&tokens, "a"), base.to_str().unwrap(), "a.txt").await, &base, "a.txt");
        mint!("a3", file("a.txt"), "");
        let step = next("mint a.txt again at 59 minutes: the same token, one more hour");
        assert_eq!(step["ok"]["same"], same(&tokens, "a", "a3"));
        advance(59);
        let step = next("redeem 118 minutes in: alive through the renewal");
        check(&step, store.redeem("dev", 1, &tok(&tokens, "a"), base.to_str().unwrap(), "a.txt").await, &base, "a.txt");
        advance(61);
        let step = next("redeem past the hour after the renewal");
        check(&step, store.redeem("dev", 1, &tok(&tokens, "a"), base.to_str().unwrap(), "a.txt").await, &base, "a.txt");
        let step = next("redeem it again: the grant was deleted");
        check(&step, store.redeem("dev", 1, &tok(&tokens, "a"), base.to_str().unwrap(), "a.txt").await, &base, "a.txt");
        mint!("a4", file("a.txt"), "");
        let step = next("mint a.txt after it expired: a new token");
        assert_eq!(step["ok"]["same"], same(&tokens, "a", "a4"));

        mint!("a-s1", file("a.txt"), "s1");
        let step = next("redeem the conversation token while its conversation lives");
        check(&step, store.redeem("dev", 1, &tok(&tokens, "a-s1"), base.to_str().unwrap(), "a.txt").await, &base, "a.txt");
        // Node's download service has seen the conversation in a published catalog before it leaves it.
        mixdog_core_api::state::CatalogObserver::published(&store, &["s1"]);
        catalog.0.lock().unwrap().insert("s1".to_owned());
        let step = next("redeem the conversation token once the conversation is gone");
        check(&step, store.redeem("dev", 1, &tok(&tokens, "a-s1"), base.to_str().unwrap(), "a.txt").await, &base, "a.txt");
        mint!("a-s1c", file("a.txt"), "s1");
        let step = next("mint for the gone conversation: a new token");
        assert_eq!(step["ok"]["same"], same(&tokens, "a-s1", "a-s1c"));
        catalog.0.lock().unwrap().remove("s1");

        for i in 0..100 {
            mint!(format!("f{i}"), file(&format!("f{i}.txt")), "");
        }
        let redeem_file = |token: String, file: &'static str| {
            let base = base.clone();
            let store = &store;
            async move { store.redeem("dev", 1, &token, base.to_str().unwrap(), file).await }
        };
        let step = next("the newest hundred are held: the first of them");
        check(&step, redeem_file(tok(&tokens, "f0"), "f0.txt").await, &base, "f0.txt");
        let step = next("the newest hundred are held: the last of them");
        check(&step, redeem_file(tok(&tokens, "f99"), "f99.txt").await, &base, "f99.txt");
        let step = next("a grant older than those hundred is gone");
        check(&step, redeem_file(tok(&tokens, "a4"), "a.txt").await, &base, "a.txt");
        let token = store.mint("dev", 1, &file("f100.txt"), "").await.unwrap();
        tokens.insert("f100".to_owned(), token);
        let step = next("one more evicts the oldest remaining (f0)");
        check(&step, redeem_file(tok(&tokens, "f0"), "f0.txt").await, &base, "f0.txt");
        let step = next("and the next oldest is held");
        check(&step, redeem_file(tok(&tokens, "f1"), "f1.txt").await, &base, "f1.txt");
        let step = next("and the one just minted is held");
        check(&step, redeem_file(tok(&tokens, "f100"), "f100.txt").await, &base, "f100.txt");
        assert!(steps.next().is_none(), "every recorded step was replayed");
    }

    /// A conversation no published catalog ever listed is not "gone" however the catalog answers (`seenSessions.has`).
    #[tokio::test]
    async fn a_conversation_is_gone_only_once_a_published_catalog_has_listed_it() {
        let clock = Arc::new(Manual(Instant::now(), AtomicU64::new(0)));
        let catalog = Arc::new(Catalog::default());
        catalog.0.lock().unwrap().insert("s1".to_owned());
        let store = GrantStore::new(clock, catalog);
        let dir = std::env::temp_dir().join("outside");
        let token = store.mint("dev", 1, &dir.join("a.txt"), "s1").await.unwrap();
        assert!(store.redeem("dev", 1, &token, dir.to_str().unwrap(), "a.txt").await.is_ok(), "never listed: not gone");
        mixdog_core_api::state::CatalogObserver::published(&store, &["s1"]);
        let gone = store.redeem("dev", 1, &token, dir.to_str().unwrap(), "a.txt").await.unwrap_err();
        assert_eq!(gone.reason.code(), GRANT_UNAVAILABLE_CODE);
    }

    /// A relay close ends the grants themselves: a grant whose conversation was removed before the close, held in a table a connection
    /// keeps until its teardown, is not redeemed after the close resets what the store has seen (Node's old service keeps its history).
    #[tokio::test]
    async fn nothing_granted_before_a_relay_close_is_redeemed_after_it() {
        let clock = Arc::new(Manual(Instant::now(), AtomicU64::new(0)));
        // `Catalog` holds the conversations that are gone.
        let catalog = Arc::new(Catalog::default());
        let store = GrantStore::new(clock, catalog.clone());
        let dir = std::env::temp_dir().join("outside");
        let token = store.mint("dev", 1, &dir.join("a.txt"), "s1").await.unwrap();
        mixdog_core_api::state::CatalogObserver::published(&store, &["s1"]);
        catalog.0.lock().unwrap().insert("s1".to_owned());
        // An unpair dropped the device's table; connection 1 still holds it until its teardown.
        store.revoke_device("dev");
        store.relay_closed();
        let after = store.redeem("dev", 1, &token, dir.to_str().unwrap(), "a.txt").await.unwrap_err();
        assert_eq!(after.reason.code(), GRANT_UNAVAILABLE_CODE, "the still-bound connection's grant ended with the relay");
    }

    #[tokio::test]
    async fn a_device_holds_only_its_own_grants() {
        let clock = Arc::new(Manual(Instant::now(), AtomicU64::new(0)));
        let store = GrantStore::new(clock, Arc::new(Catalog::default()));
        let file = std::env::temp_dir().join("outside").join("a.txt");
        let token = store.mint("phone-a", 1, &file, "").await.unwrap();
        let dir = std::env::temp_dir().join("outside");
        assert!(store.redeem("phone-a", 1, &token, dir.to_str().unwrap(), "a.txt").await.is_ok());
        let other = store.redeem("phone-b", 2, &token, dir.to_str().unwrap(), "a.txt").await.unwrap_err();
        assert_eq!(other.reason.code(), GRANT_UNAVAILABLE_CODE);
    }

    /// `dropFileGrants` (`remote-relay-device-methods.ts`) deletes the device's table, and a connection already holding the table object
    /// keeps using it (the unpair recording `unpair-access.json`, `link.read` after: the attached phone still reads, a new connection is refused).
    #[tokio::test]
    async fn an_unpair_leaves_an_attached_connection_its_grants_and_a_new_connection_none() {
        let clock = Arc::new(Manual(Instant::now(), AtomicU64::new(0)));
        let store = GrantStore::new(clock, Arc::new(Catalog::default()));
        let dir = std::env::temp_dir().join("outside");
        let token = store.mint("phone-a", 1, &dir.join("a.txt"), "").await.unwrap();
        store.revoke_device("phone-a");
        assert!(store.redeem("phone-a", 1, &token, dir.to_str().unwrap(), "a.txt").await.is_ok(), "the attached connection keeps its table");
        let fresh = store.redeem("phone-a", 2, &token, dir.to_str().unwrap(), "a.txt").await.unwrap_err();
        assert_eq!(fresh.reason.code(), GRANT_UNAVAILABLE_CODE);
        store.release(1);
        let released = store.redeem("phone-a", 1, &token, dir.to_str().unwrap(), "a.txt").await.unwrap_err();
        assert_eq!(released.reason.code(), GRANT_UNAVAILABLE_CODE, "a connection that ended holds nothing");
    }

    #[test]
    fn the_deepest_project_owns_a_file() {
        let root = std::env::temp_dir();
        let outer = root.join("p");
        let inner = root.join("p").join("inner");
        let projects = vec![outer.to_string_lossy().into_owned(), inner.to_string_lossy().into_owned()];
        let (project, relative) = owning_project(&projects, &inner.join("src").join("a.rs")).unwrap();
        assert_eq!((project, relative.as_str()), (projects[1].as_str(), "src/a.rs"));
        assert!(owning_project(&projects, &root.join("elsewhere").join("a.rs")).is_none());
    }
}