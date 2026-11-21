//! The pins Mixdog writes in its own `known_hosts`, and the commit of a confirmed or replaced key.
//!
//! A pin the app wrote says so in its trailing comment: `mixdog-pin-v1=<owner>[,<owner>...]`, an owner being the lowercase hex
//! SHA-256 of `SshTarget::key()` of the server that confirmed it (the format earlier builds read and write). The mark is what
//! makes a line the app's own: only a marked line is ever rotated in place. A line without the mark is never edited: hashed names, comma lists, wildcards, negations, `@cert-authority`, `@revoked`, comments and every pin written before
//! the mark existed stay byte for byte. Forgetting a server removes its saved entry only; its pins stay, so a server added again
//! finds its key already trusted. Nothing here asks ssh or reads the user's `~/.ssh`.
//!
//! Every change of the file runs as one transaction under `ssh/state.lock` (see `mixdog_config::with_state_lock`).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::command::SshTarget;
use crate::known_hosts::{KnownHostEntry, KnownHostMarker, host_field_matches, parse as parse_known};
use crate::mixdog_config::{locked, publish_file, read_state};

pub(crate) const RESERVED_PREFIX: &str = "mixdog-pin-v";
const MARK: &str = "mixdog-pin-v1=";

/// Why Mixdog's ssh state could not be read or changed. None of these is an empty state: the file stays as it was.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StateError {
    Unreadable(String),
    /// An entry marked by another version of the format: a newer app wrote it.
    NewerVersion(String),
    /// An entry of this version's format that is malformed.
    Invalid(String),
    Io(String),
    /// Another key was pinned for the endpoint, or the reviewed pin was already replaced: the server presented another key.
    Conflict,
    /// The known_hosts entries for the route are no longer the ones the user reviewed (added, removed or changed by hand or by
    /// another writer); the server presented nothing new.
    EvidenceChanged,
    /// A key that an `@revoked` entry names for the endpoint when the confirmation was committed: never saved, never offered again.
    Revoked,
    /// A key that cannot be replaced automatically; the file to edit by hand (empty until the caller that knows it names it).
    Manual(String),
}

impl StateError {
    /// What this says, by code, with its parameters.
    pub fn said(&self) -> mixdog_app_protocol::message::Said {
        use crate::said;
        match self {
            Self::Unreadable(detail) => said::HOST_KEYS_UNREADABLE.said([("error", detail)]),
            Self::NewerVersion(detail) => said::HOST_KEYS_NEWER_VERSION.said([("error", detail)]),
            Self::Invalid(detail) => said::HOST_KEYS_MALFORMED.said([("error", detail)]),
            Self::Io(detail) => said::SSH_SETTINGS_NOT_UPDATED.said([("error", detail)]),
            Self::Conflict => said::HOST_KEY_CHANGED_WHILE_CONFIRMING.plain(),
            Self::EvidenceChanged => said::HOST_KEYS_CHANGED_WHILE_CONFIRMING.plain(),
            Self::Revoked => said::HOST_KEY_REVOKED_WHILE_CONFIRMING.plain(),
            Self::Manual(path) => {
                let mut said = said::HOST_KEY_MANUAL_EDIT.said([("path", path)]);
                if path.is_empty() {
                    said.english = said.english.replace(" ()", "");
                    said.message.params.remove("path");
                }
                said
            }
        }
    }
}

impl std::fmt::Display for StateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.said().english)
    }
}

impl std::error::Error for StateError {}

pub(crate) fn digest_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The owner a server's claims carry (and the name of its generated config): by `SshTarget::key()`, so `ops@BOX` and `ops@box`
/// are one server.
pub fn owner_of(target: &SshTarget) -> String {
    digest_hex(target.key().as_bytes())
}

/// One endpoint's key, accepted for the server `owner`. The only way a pin enters Mixdog's known_hosts (the import of an older
/// file is the other, and its entries belong to nobody).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Claim {
    pub owner: String,
    pub spec: String,
    pub key_type: String,
    pub key: String,
}

impl Claim {
    pub fn new(owner: String, spec: String, key_type: String, key: String) -> Self {
        Self { owner, spec, key_type, key }
    }

    /// The known_hosts line of a pin held by this owner alone.
    pub fn line(&self) -> String {
        format!("{} {} {} {MARK}{}", self.spec, self.key_type, self.key, self.owner)
    }
}

#[derive(Clone, Debug)]
struct Managed {
    spec: String,
    key_type: String,
    key: String,
    /// The ownership mark as written.
    mark: String,
}

impl Managed {
    fn text(&self) -> String {
        format!("{} {} {} {}", self.spec, self.key_type, self.key, self.mark)
    }
}

#[derive(Clone, Debug)]
enum Kind {
    Blank,
    Comment,
    /// Anything else: kept exactly as it is.
    Opaque,
    Managed(Managed),
}

fn valid_owner(owner: &str) -> bool {
    owner.len() == 64 && owner.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn classify(content: &[u8]) -> Result<Kind, StateError> {
    let Ok(text) = std::str::from_utf8(content) else { return Ok(Kind::Opaque) };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(Kind::Blank);
    }
    if trimmed.starts_with('#') {
        return Ok(Kind::Comment);
    }
    let fields: Vec<&str> = trimmed.split_whitespace().collect();
    let at = usize::from(fields[0].starts_with('@'));
    let Some(comment) = fields.get(at + 3).filter(|comment| comment.starts_with(RESERVED_PREFIX)) else { return Ok(Kind::Opaque) };
    let invalid = || StateError::Invalid(trimmed.chars().take(80).collect());
    let spec = fields[0];
    if !comment.starts_with(MARK) {
        return Err(StateError::NewerVersion(trimmed.chars().take(80).collect()));
    }
    if at == 1 || fields.len() != 4 || spec.contains([',', '*', '?', '!']) || spec.starts_with('|') {
        return Err(invalid());
    }
    if comment[MARK.len()..].split(',').any(|owner| !valid_owner(owner)) {
        return Err(invalid());
    }
    Ok(Kind::Managed(Managed { spec: spec.to_owned(), key_type: fields[1].to_owned(), key: fields[2].to_owned(), mark: (*comment).to_owned() }))
}

/// One line with its own ending (`\n`, `\r\n` or none on a last line).
struct Line {
    content: Vec<u8>,
    ending: Vec<u8>,
    kind: Kind,
}

fn parse(bytes: &[u8]) -> Result<Vec<Line>, StateError> {
    bytes
        .split_inclusive(|byte| *byte == b'\n')
        .map(|chunk| {
            let cut = if chunk.ends_with(b"\r\n") { 2 } else { usize::from(chunk.ends_with(b"\n")) };
            let (content, ending) = chunk.split_at(chunk.len() - cut);
            Ok(Line { content: content.to_vec(), ending: ending.to_vec(), kind: classify(content)? })
        })
        .collect()
}

fn render(lines: &[Line]) -> Vec<u8> {
    lines.iter().flat_map(|line| line.content.iter().chain(&line.ending)).copied().collect()
}

/// What an unmanaged line says about an endpoint it covers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Covering {
    /// An ordinary key line (a literal, hashed, listed or wildcard name): trust of the user's, never of this app's.
    Plain,
    Revoked,
    /// A CA: it vouches for certificates, it is no key of the endpoint.
    Authority,
}

/// Does an unmanaged key line cover `spec` with this key type, by the host-pattern rules ssh applies to the whole field (a
/// comma list, a wildcard, a hashed name, a `!` that excludes the line), and what does it say there?
fn opaque_covers(content: &[u8], spec: &str, key_type: &str) -> Option<(Covering, String)> {
    let text = std::str::from_utf8(content).ok()?;
    let fields: Vec<&str> = text.split_whitespace().collect();
    let at = usize::from(fields.first()?.starts_with('@'));
    let (hosts, kind, key) = (*fields.get(at)?, *fields.get(at + 1)?, *fields.get(at + 2)?);
    if !host_field_matches(hosts, spec) || kind != key_type {
        return None;
    }
    let covering = match fields[0] {
        "@revoked" => Covering::Revoked,
        "@cert-authority" => Covering::Authority,
        _ => Covering::Plain,
    };
    Some((covering, key.to_owned()))
}

/// One entry of a known_hosts file that names an endpoint, with the file it is in and whether it is a pin this app owns (a marked
/// line of Mixdog's own file: the only trust that is the app's own).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KnownEntry {
    pub(crate) entry: KnownHostEntry,
    pub(crate) file: PathBuf,
    pub(crate) managed: bool,
}

/// The entries for one endpoint of a route in the known_hosts files its ssh consults: every entry that names it (a literal, hashed,
/// listed or wildcard name; a pin, a revocation or a certificate authority), with its file. The inspection judges the endpoint by
/// them, and a confirmation is committed only while the entries for the endpoint in the files its ssh consults then are the same;
/// an entry for another host may change meanwhile.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EndpointTrust {
    pub(crate) spec: String,
    /// The user files ssh reads for the endpoint, as the config written for the attempt names them: Mixdog's own file and the
    /// endpoint's own resolved ones.
    pub(crate) user: Vec<PathBuf>,
    /// The endpoint's own system-wide files (no config of Mixdog's sets them).
    pub(crate) global: Vec<PathBuf>,
    pub(crate) entries: Vec<KnownEntry>,
}

impl EndpointTrust {
    /// The entries for `spec` in the files its ssh consults; `text` gives a file's text (None: no entries), `own` is Mixdog's own
    /// known_hosts.
    pub(crate) fn of(spec: &str, user: Vec<PathBuf>, global: Vec<PathBuf>, own: Option<&Path>, text: impl Fn(&Path) -> Option<String>) -> Self {
        let mut trust = Self { spec: spec.to_owned(), user, global, entries: Vec::new() };
        for file in trust.files() {
            let Some(text) = text(&file) else { continue };
            let is_own = own == Some(file.as_path());
            for line in text.lines() {
                let managed = is_own && matches!(classify(line.as_bytes()), Ok(Kind::Managed(_)));
                trust.entries.extend(parse_known(line).into_iter().filter(|entry| host_field_matches(&entry.hosts, spec)).map(|entry| KnownEntry {
                    entry,
                    file: file.clone(),
                    managed,
                }));
            }
        }
        trust
    }

    /// The files ssh consults for the endpoint, each once.
    pub(crate) fn files(&self) -> Vec<PathBuf> {
        let mut files: Vec<PathBuf> = Vec::new();
        for file in self.user.iter().chain(&self.global) {
            if !files.contains(file) {
                files.push(file.clone());
            }
        }
        files
    }

    /// The entries for the endpoint in the files its ssh consults now (the caller holds the writer lock). A file that is not there
    /// is no entries; one that cannot be read is an error, never an empty file.
    fn reread(&self, own: &Path) -> Result<Self, StateError> {
        let mut texts = BTreeMap::new();
        for file in self.files() {
            let bytes = read_state(&file).map_err(|failure| StateError::Unreadable(failure.to_string()))?;
            texts.insert(file, String::from_utf8_lossy(&bytes).into_owned());
        }
        Ok(Self::of(&self.spec, self.user.clone(), self.global.clone(), Some(own), |file| texts.get(file).cloned()))
    }
}

/// The entries of `from` that `take` does not account for, each entry of `take` accounting for one equal entry: an entry written
/// twice is two entries.
fn minus<'a>(from: &'a [KnownEntry], take: &[KnownEntry]) -> Vec<&'a KnownEntry> {
    let mut unused: Vec<&KnownEntry> = take.iter().collect();
    from.iter()
        .filter(|held| match unused.iter().position(|other| other == held) {
            Some(at) => {
                unused.swap_remove(at);
                false
            }
            None => true,
        })
        .collect()
}

fn still_holds(shown: &[EndpointTrust], own: &Path, claims: &[Claim]) -> Result<Vec<EndpointTrust>, StateError> {
    let mut now = Vec::new();
    for endpoint in shown {
        let fresh = endpoint.reread(own)?;
        let spec = &endpoint.spec;
        let confirmed = |added: &KnownEntry| {
            added.managed
                && added.entry.hosts == *spec
                && claims.iter().any(|claim| claim.spec == *spec && claim.key_type == added.entry.key_type && claim.key == added.entry.key)
        };
        let added: Vec<&KnownEntry> = minus(&fresh.entries, &endpoint.entries).into_iter().filter(|held| !confirmed(held)).collect();
        if added.iter().any(|held| held.entry.marker == KnownHostMarker::Revoked) {
            return Err(StateError::Revoked);
        }
        if !added.is_empty() || !minus(&endpoint.entries, &fresh.entries).is_empty() {
            return Err(StateError::EvidenceChanged);
        }
        now.push(fresh);
    }
    Ok(now)
}

/// Adds `claims`: a new managed pin is appended unless an identical one is there (another desktop confirmed the same key first),
/// and an unmarked line holding the key is left as it is. `None` when nothing changes. A key that differs from one already held
/// for the endpoint and key type is a conflict, never appended beside it.
pub(crate) fn add_claims(bytes: &[u8], claims: &[Claim]) -> Result<Option<Vec<u8>>, StateError> {
    let mut lines = parse(bytes)?;
    let mut changed = false;
    for claim in claims {
        if lines.iter().any(|line| matches!(&line.kind, Kind::Managed(m) if m.spec == claim.spec && m.key_type == claim.key_type && m.key == claim.key)) {
            continue;
        }
        let covering = |line: &Line| match &line.kind {
            Kind::Opaque => opaque_covers(&line.content, &claim.spec, &claim.key_type),
            _ => None,
        };
        // ssh accepts a key any entry for the endpoint holds, so an entry of the user's that already holds this very key is
        // what makes the claim a copy of existing trust; only then is another key beside it (a wildcard's, say) no conflict.
        let held = lines.iter().any(|line| covering(line).is_some_and(|(covering, key)| matches!(covering, Covering::Plain) && key == claim.key));
        for line in &lines {
            let clash = match &line.kind {
                Kind::Managed(m) => m.spec == claim.spec && m.key_type == claim.key_type,
                // The same endpoint and key type under another key; or the very key, revoked. A CA is no key of the endpoint.
                Kind::Opaque => covering(line).is_some_and(|(covering, key)| match covering {
                    Covering::Revoked => key == claim.key,
                    Covering::Plain => !held && key != claim.key,
                    Covering::Authority => false,
                }),
                _ => false,
            };
            if clash {
                return Err(StateError::Conflict);
            }
        }
        let ending = match lines.last_mut() {
            // A last line without an ending: the new line takes the last place, without one either, so the file keeps ending the
            // way it did.
            Some(last) if last.ending.is_empty() => {
                last.ending = b"\n".to_vec();
                Vec::new()
            }
            Some(last) => last.ending.clone(),
            None => b"\n".to_vec(),
        };
        lines.push(Line { content: claim.line().into_bytes(), ending, kind: Kind::Blank });
        let last = lines.len() - 1;
        lines[last].kind = classify(&lines[last].content)?;
        changed = true;
    }
    Ok(changed.then(|| render(&lines)))
}

/// The index of the one managed pin for `spec` and `key_type` that may be rotated: no unmanaged line covers the endpoint with that
/// key type, and no second managed pin does.
fn rotation_target(lines: &[Line], spec: &str, key_type: &str) -> Option<usize> {
    let mut found = None;
    for (index, line) in lines.iter().enumerate() {
        match &line.kind {
            Kind::Managed(m) if m.spec == spec && m.key_type == key_type => {
                if found.replace(index).is_some() {
                    return None;
                }
            }
            Kind::Opaque if opaque_covers(&line.content, spec, key_type).is_some() => return None,
            _ => {}
        }
    }
    found
}

/// Can a changed key for `spec` be replaced in place: an unambiguous managed pin, nothing else naming the endpoint?
pub(crate) fn can_rotate(bytes: &[u8], spec: &str, key_type: &str) -> bool {
    parse(bytes).is_ok_and(|lines| rotation_target(&lines, spec, key_type).is_some())
}

/// Replaces the key of the managed pin for the claim's endpoint, its mark kept as written. Only the pin whose key is `old_key`, the
/// one the user was shown being replaced: a pin another writer already rotated (also to this very key) is a changed trust, and the
/// confirmation is spent.
pub(crate) fn rotate(bytes: &[u8], claim: &Claim, old_key: &str) -> Result<Vec<u8>, StateError> {
    let mut lines = parse(bytes)?;
    let manual = || StateError::Manual(String::new());
    let index = rotation_target(&lines, &claim.spec, &claim.key_type).ok_or_else(manual)?;
    let line = &mut lines[index];
    if let Kind::Managed(managed) = &mut line.kind {
        if managed.key != old_key {
            return Err(StateError::Conflict);
        }
        managed.key = claim.key.clone();
        line.content = managed.text().into_bytes();
    }
    Ok(render(&lines))
}

/// A legacy source's line without the ownership mark (an imported entry belongs to nobody).
pub(crate) fn strip_reserved(line: &str) -> String {
    let fields: Vec<&str> = line.split_whitespace().collect();
    let at = usize::from(fields.first().is_some_and(|first| first.starts_with('@')));
    if fields.get(at + 3).is_some_and(|comment| comment.starts_with(RESERVED_PREFIX)) { fields[..at + 3].join(" ") } else { line.to_owned() }
}

fn io_error(failure: &std::io::Error) -> StateError {
    StateError::Io(failure.to_string())
}

fn read_known_hosts(file: &Path) -> Result<Vec<u8>, StateError> {
    read_state(file).map_err(|failure| StateError::Unreadable(failure.to_string()))
}

/// The folder of Mixdog's ssh state a known_hosts file lives in (its lock is beside it).
fn state_dir(known_hosts: &Path) -> PathBuf {
    known_hosts.parent().map_or_else(|| PathBuf::from("."), Path::to_path_buf)
}

/// Writes `claims` into Mixdog's known_hosts as one transaction, also the one that adds nothing: refused unless the entries for
/// every endpoint of the route in the files its ssh consults are still the ones `shown` holds. The check and the write run under
/// the writer lock; an editor outside the app that does not take it can still change a file in between.
pub(crate) async fn commit_claims(known_hosts: &Path, shown: Vec<EndpointTrust>, claims: Vec<Claim>) -> Result<(), StateError> {
    let known_hosts = known_hosts.to_path_buf();
    locked(state_dir(&known_hosts), move || Ok(commit_in(&known_hosts, &shown, &claims))).await.map_err(|failure| io_error(&failure))?
}

fn commit_in(known_hosts: &Path, shown: &[EndpointTrust], claims: &[Claim]) -> Result<(), StateError> {
    still_holds(shown, known_hosts, claims)?;
    match add_claims(&read_known_hosts(known_hosts)?, claims)? {
        Some(next) => publish_file(known_hosts, &next).map_err(|failure| io_error(&failure)),
        None => Ok(()),
    }
}

/// Replaces the changed key in place, as one transaction: the pin whose key is `old_key` (the one the user reviewed) gets the key
/// of `claim`, and nothing else is written. Refused like [`commit_claims`].
pub(crate) async fn rotate_claim(known_hosts: &Path, shown: Vec<EndpointTrust>, claim: Claim, old_key: String) -> Result<(), StateError> {
    let known_hosts = known_hosts.to_path_buf();
    locked(state_dir(&known_hosts), move || Ok(rotate_in(&known_hosts, &shown, &claim, &old_key))).await.map_err(|failure| io_error(&failure))?
}

fn rotate_in(known_hosts: &Path, shown: &[EndpointTrust], claim: &Claim, old_key: &str) -> Result<(), StateError> {
    let now = still_holds(shown, known_hosts, std::slice::from_ref(claim))?;
    // The refusal names the file to edit; the sentence itself stays the one the interface translates.
    let manual = |file: &Path| StateError::Manual(file.display().to_string());
    // Trust of the user's own files for the endpoint, under another key of this type, is an ambiguity this app does not resolve.
    let user_trust = now.iter().filter(|endpoint| endpoint.spec == claim.spec).flat_map(|endpoint| &endpoint.entries).find(|held| {
        held.file != known_hosts && held.entry.marker == KnownHostMarker::None && held.entry.key_type == claim.key_type && held.entry.key != claim.key
    });
    if let Some(held) = user_trust {
        return Err(manual(&held.file));
    }
    let next = rotate(&read_known_hosts(known_hosts)?, claim, old_key).map_err(|error| match error {
        StateError::Manual(_) => manual(known_hosts),
        other => other,
    })?;
    publish_file(known_hosts, &next).map_err(|failure| io_error(&failure))
}

#[cfg(test)]
#[path = "pins_tests.rs"]
mod pins_tests;

#[cfg(test)]
#[path = "trust_commit_tests.rs"]
mod trust_commit_tests;
