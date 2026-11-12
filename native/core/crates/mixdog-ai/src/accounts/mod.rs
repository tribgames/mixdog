//! The provider account pool (`provider-accounts.mjs`): the roster of
//! accounts per OAuth provider in `<D>/provider-accounts.json` (+ `.bak`) and
//! each non-default account's credential in
//! `<D>/provider-accounts/<provider>/<uuid>.json`. Reads are lane jobs; writes
//! are atomic, under the file's lock, and keep the replaced version as `.bak`.
//!
//! [`AccountStore`] is the read/update API (`getProviderAccounts` /
//! `updateProviderAccounts` of the protocol, Command Code's `isFirstSignIn`);
//! [`policy`] holds the pure rotation decisions.

mod binding;
mod file;
mod model;
pub mod policy;
pub mod rotation;
pub mod validity;

use std::io;
use std::path::PathBuf;
use std::sync::Arc;

pub use binding::has_explicit_provider_auth_binding;
pub use binding::replace_provider_auth_bindings;
pub use binding::with_provider_account;
pub use model::Account;
pub use model::Block;
pub use model::Policy;
pub use model::Pool;
pub use model::Usage;
pub use model::Window;
use mixdog_js::js_trim;
use mixdog_js::slice_utf16;
use mixdog_js::utf16_len;
use serde_json::Value;

use crate::oauth::CredentialFile;
use crate::oauth::CredentialIo;
use crate::oauth::Probe;
use crate::oauth::pace::Pace;
use crate::oauth::pace::SystemPace;

pub const ACCOUNT_PROVIDERS: [&str; 10] = [
    "openai-oauth",
    "anthropic-oauth",
    "grok-oauth",
    "muse-code-oauth",
    "command-code-oauth",
    "mimo-oauth",
    "cursor-oauth",
    "devin-oauth",
    "antigravity-oauth",
    "opencode-go-oauth",
];
/// Node's tri-state credential probe (oauthCredentialProbeState): a deliberate logout is Absent,
/// a file that exists and cannot be read now is Unreadable and never a logout.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CredentialState {
    Present,
    Absent,
    Unreadable,
}

pub const MAX_ACCOUNTS: usize = 20;
/// A refusal block is an avoidance hint for the roster, not the retry
/// schedule: capped so a header asking for days cannot idle an account.
pub const MAX_BLOCK_MS: i64 = 6 * 60 * 60_000;
const MAX_LABEL: usize = 80;

#[derive(Debug, thiserror::Error)]
pub enum AccountError {
    /// A malformed argument (Node's `TypeError`).
    #[error("{0}")]
    Invalid(String),
    /// A well-formed request the roster refuses (Node's `Error`).
    #[error("{0}")]
    Rejected(String),
    /// The roster is a newer build's: it is left untouched.
    #[error("{0}")]
    Unsupported(String),
    #[error("{0}")]
    Io(#[from] io::Error),
}

impl AccountError {
    /// The roster call never ran (its lane refused or dropped the job): an unread roster is not
    /// an empty one.
    pub fn unrun(&self) -> bool {
        matches!(self, AccountError::Io(error) if crate::oauth::is_lane_unrun(error))
    }
}

fn invalid<T>(message: &str) -> Result<T, AccountError> {
    Err(AccountError::Invalid(message.into()))
}

/// A custom provider (`custom-<id>`) pools its API keys in the same roster.
pub fn is_custom_key_provider(provider: &str) -> bool {
    provider.strip_prefix("custom-").is_some_and(|rest| !rest.is_empty())
}

pub(crate) fn is_account_provider(provider: &str) -> bool {
    ACCOUNT_PROVIDERS.contains(&provider) || is_custom_key_provider(provider)
}

pub(crate) fn valid_account_id(id: &str) -> bool {
    id == "default"
        || (id.len() == 36 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-'))
}

fn require_provider(provider: &str) -> Result<(), AccountError> {
    if is_account_provider(provider) {
        Ok(())
    } else {
        invalid("Unknown OAuth provider.")
    }
}

fn require_id(id: &str) -> Result<(), AccountError> {
    if valid_account_id(id) {
        Ok(())
    } else {
        invalid("Invalid provider account id.")
    }
}

/// A new account id (a v4 UUID).
pub fn new_account_id() -> String {
    uuid_v4()
}

fn uuid_v4() -> String {
    let mut b: [u8; 16] = rand::random();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

/// Labels an earlier build assigned automatically map to the fixed
/// `Account 1`, not to the row's position, which would change on a reorder.
const LEGACY_AUTO_LABELS: [&str; 3] = ["default account", "existing account", "기존 계정"];

fn normalize(provider: &str, mut pool: Pool) -> Pool {
    for (index, row) in pool.accounts.iter_mut().enumerate() {
        let label = js_trim(row.label.as_deref().unwrap_or("")).to_owned();
        if LEGACY_AUTO_LABELS.contains(&label.to_lowercase().as_str()) {
            row.label = Some("Account 1".into());
        } else if label.is_empty() {
            row.label = Some(format!("Account {}", index + 1));
        }
        // A reading stored before per-model gating steers nothing until the
        // account is measured again.
        if row
            .usage
            .as_ref()
            .is_some_and(|u| policy::stale_quota_windows(provider, &u.windows))
        {
            row.usage = None;
        }
    }
    let policy = pool.policy();
    pool.set_policy(policy);
    pool
}

fn pool_of(roster: &Value, provider: &str) -> Pool {
    roster["providers"]
        .get(provider)
        .and_then(|raw| serde_json::from_value(raw.clone()).ok())
        .unwrap_or_default()
}

/// A change to a roster, as `updateProviderAccounts` sends it. Every field is
/// optional; they apply in this order.
#[derive(Clone, Debug, Default)]
pub struct AccountChange {
    /// `(account id, new label)`.
    pub rename: Option<(String, String)>,
    pub selected_id: Option<String>,
    /// Every connected account id exactly once.
    pub order: Option<Vec<String>>,
    pub auto: Option<bool>,
    pub policy: Option<Policy>,
    pub use_credits: Option<bool>,
}

/// A usage reading to record: one meter per window.
#[derive(Clone, Debug, Default)]
pub struct QuotaWindowInput {
    pub label: String,
    pub used_pct: Option<f64>,
    pub reset_at: Option<i64>,
    pub models: Option<Vec<String>>,
    pub except: Option<Vec<String>>,
    pub limit: Option<String>,
}

/// How a block was scheduled and what it is evidence of.
#[derive(Clone, Debug, Default)]
pub struct BlockOptions {
    /// `true` when the server scheduled the window (`retry-after`).
    pub server_scheduled: bool,
    /// Quota evidence (a typed refusal or an exhausted window).
    pub quota: bool,
    /// The server's id of the limit the refusal named.
    pub limit: String,
    /// `until` is the quota reset the server named: kept as given.
    pub reset: bool,
}

fn model_tokens(tokens: Option<Vec<String>>) -> Option<Vec<String>> {
    tokens.map(|t| {
        t.into_iter()
            .take(12)
            .map(|x| slice_utf16(&js_trim(&x).to_lowercase(), 80))
            .filter(|x| !x.is_empty())
            .collect()
    })
}

type SelectionHook = Arc<dyn Fn() + Send + Sync>;

/// Handle on one data directory's account roster.
#[derive(Clone)]
pub struct AccountStore {
    dir: PathBuf,
    io: CredentialIo,
    on_selection_change: Option<SelectionHook>,
    /// The service clock: stored cooldowns and rotation waits read this one.
    clock: Arc<dyn Pace>,
    /// A remote-mode server holds no model credentials: every credential file reads as absent.
    remote_client: bool,
    /// The environment whose `*_OAUTH_CREDENTIALS_PATH` names a provider's own file in place of the data dir's.
    env: Option<Arc<dyn crate::registry::keys::Environment>>,
}

/// `(provider, file in the data folder, variable that names another file)` of each OAuth provider's own credential
/// (`*_CREDENTIALS_PATH` of the provider modules' `loadTokens()`).
const OWN_FILES: [(&str, &str, &str); 10] = [
    ("openai-oauth", "openai-oauth.json", "OPENAI_OAUTH_CREDENTIALS_PATH"),
    ("anthropic-oauth", "anthropic-oauth-credentials.json", "ANTHROPIC_OAUTH_CREDENTIALS_PATH"),
    ("grok-oauth", "grok-oauth.json", "GROK_OAUTH_CREDENTIALS_PATH"),
    ("muse-code-oauth", "muse-code-oauth.json", "MUSE_CODE_OAUTH_CREDENTIALS_PATH"),
    ("command-code-oauth", "command-code-oauth.json", "COMMAND_CODE_OAUTH_CREDENTIALS_PATH"),
    ("opencode-go-oauth", "opencode-go-oauth.json", "OPENCODE_GO_OAUTH_CREDENTIALS_PATH"),
    ("mimo-oauth", "mimo-oauth.json", "MIMO_OAUTH_CREDENTIALS_PATH"),
    ("cursor-oauth", "cursor-oauth.json", "CURSOR_OAUTH_CREDENTIALS_PATH"),
    ("devin-oauth", "devin-oauth.json", "DEVIN_OAUTH_CREDENTIALS_PATH"),
    ("antigravity-oauth", "antigravity-oauth.json", "ANTIGRAVITY_OAUTH_CREDENTIALS_PATH"),
];

impl AccountStore {
    pub fn new(dir: PathBuf, io: CredentialIo) -> Self {
        Self {
            dir,
            io,
            on_selection_change: None,
            clock: Arc::new(SystemPace),
            remote_client: false,
            env: None,
        }
    }

    /// Reads each provider's own credential where its `*_OAUTH_CREDENTIALS_PATH` in `env` names it (resolved against
    /// the process's working directory), as Node's provider modules do.
    pub fn with_env(mut self, env: Arc<dyn crate::registry::keys::Environment>) -> Self {
        self.env = Some(env);
        self
    }

    /// The provider's own credential file: the one its variable names, else its file in the data dir.
    fn own_file(&self, provider: &str) -> PathBuf {
        let Some((_, file, variable)) = OWN_FILES.iter().find(|(id, _, _)| *id == provider) else {
            return self.dir.join(format!("{provider}.json"));
        };
        match self.env.as_ref().and_then(|env| env.var(variable)).filter(|path| !path.is_empty()) {
            Some(explicit) => std::path::absolute(&explicit).unwrap_or_else(|_| PathBuf::from(explicit)),
            None => self.dir.join(file),
        }
    }

    /// The files the loaded config's OAuth probes read (`[providerAccountsPath(), ...oauthCredentialFiles()]`): the
    /// roster and every provider's own credential file, whether or not it exists yet.
    pub fn credential_inputs(&self) -> Vec<PathBuf> {
        std::iter::once(self.roster_path()).chain(OWN_FILES.iter().map(|(provider, _, _)| self.own_file(provider))).collect()
    }

    /// Until when the default slot's credential of `provider` is a sign-in (epoch ms), when that is a finite moment
    /// still ahead: the deadline at which the loaded config's `enabled` turns (`observeOAuthCredentialExpiry`).
    pub async fn credential_expiry(&self, provider: &str) -> Option<f64> {
        let now = self.now_ms() as f64;
        match self.credential_file(provider, "default").ok()?.load_document().await {
            Probe::Present(document) => Some(validity::credential_until(provider, &document)).filter(|until| until.is_finite() && *until > now),
            Probe::Absent | Probe::Unreadable => None,
        }
    }

    /// The store of a server that holds no model credentials when `on`.
    pub fn remote_client(mut self, on: bool) -> Self {
        self.remote_client = on;
        self
    }

    /// Replaces the system clock (a rotation built over a [`Pace`] installs its own).
    pub fn with_clock(mut self, clock: Arc<dyn Pace>) -> Self {
        self.clock = clock;
        self
    }

    /// Unix ms on the service clock.
    pub(crate) fn now_ms(&self) -> i64 {
        i64::try_from(self.clock.now_ms()).unwrap_or(i64::MAX)
    }

    /// Called after a write moved a provider's selected account: the selection
    /// decides which credential file the config's OAuth probe reads.
    pub fn on_selection_change(mut self, hook: impl Fn() + Send + Sync + 'static) -> Self {
        self.on_selection_change = Some(Arc::new(hook));
        self
    }

    pub fn roster_path(&self) -> PathBuf {
        self.dir.join("provider-accounts.json")
    }

    /// Where `id`'s credential lives: `None` for `default`, whose file is the
    /// provider's own (see [`Self::credential_file`]).
    pub fn account_path(&self, provider: &str, id: &str) -> Result<Option<PathBuf>, AccountError> {
        require_provider(provider)?;
        require_id(id)?;
        Ok((id != "default").then(|| {
            self.dir
                .join("provider-accounts")
                .join(provider)
                .join(format!("{id}.json"))
        }))
    }

    /// The credential file of account `id`: the provider's own file for
    /// `default`, else the account's file.
    pub fn credential_file(&self, provider: &str, id: &str) -> Result<CredentialFile, AccountError> {
        let path = match self.account_path(provider, id)? {
            Some(path) => path,
            None => self.own_file(provider),
        };
        Ok(CredentialFile::new(path, self.io).remote_client(self.remote_client))
    }

    /// `provider`'s roster, normalized; empty when it has none.
    pub async fn pool(&self, provider: &str) -> Result<Pool, AccountError> {
        require_provider(provider)?;
        let path = self.roster_path();
        let roster = file::read_roster(&self.io, path).await?;
        Ok(normalize(provider, pool_of(&roster, provider)))
    }

    /// `provider`'s accounts in use order (`readProviderAccountPool(..).accounts`).
    pub async fn accounts(&self, provider: &str) -> Result<Vec<Account>, AccountError> {
        Ok(self.pool(provider).await?.accounts)
    }

    /// Whether account `slot` (`default` or an account id) holds a credential.
    /// An unreadable file counts as present: it is never a logout.
    pub async fn has_credential(&self, provider: &str, slot: &str) -> Result<bool, AccountError> {
        Ok(match self.credential_file(provider, slot)?.load_document().await {
            Probe::Present(document) => !document.is_empty(),
            Probe::Absent => false,
            Probe::Unreadable => true,
        })
    }

    /// The tri-state of an account slot's credential file (`oauthCredentialProbeState`): present when
    /// its document is a sign-in by the provider's own rule ([`validity::credential_valid`]), absent
    /// when it is missing or the rule rejects it, unreadable when it exists and cannot be parsed.
    pub async fn credential_state(&self, provider: &str, slot: &str) -> Result<CredentialState, AccountError> {
        let now = self.now_ms() as f64;
        Ok(match self.credential_file(provider, slot)?.load_document().await {
            Probe::Present(document) if validity::credential_valid(provider, &document, now) => CredentialState::Present,
            Probe::Present(_) | Probe::Absent => CredentialState::Absent,
            Probe::Unreadable => CredentialState::Unreadable,
        })
    }

    async fn update(
        &self,
        provider: &str,
        mutate: impl FnOnce(&mut Pool) -> Result<(), AccountError> + Send + 'static,
    ) -> Result<Pool, AccountError> {
        require_provider(provider)?;
        let path = self.roster_path();
        let name = provider.to_owned();
        let selection: Arc<std::sync::Mutex<(Option<String>, Option<String>)>> = Arc::default();
        let seen = selection.clone();
        let outcome = self
            .io
            .write_job(move |lane| {
                file::update_roster(lane, &path, |roster| {
                    let mut pool = pool_of(roster, &name);
                    let before = pool.selected_id.clone();
                    mutate(&mut pool)?;
                    *seen.lock().unwrap_or_else(std::sync::PoisonError::into_inner) =
                        (before, pool.selected_id.clone());
                    roster["providers"][&name] = serde_json::to_value(&pool).map_err(io::Error::other)?;
                    Ok(())
                })
            })
            .await??;
        let (before, after) = selection.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        if before != after
            && let Some(hook) = &self.on_selection_change
        {
            hook();
        }
        Ok(normalize(provider, pool_of(&outcome, provider)))
    }

    /// Adds account `id` (and, with `include_default`, the provider's own
    /// credential as `Account 1`), selecting the first account if none is.
    pub async fn register(
        &self,
        provider: &str,
        id: &str,
        label: &str,
        include_default: bool,
    ) -> Result<Pool, AccountError> {
        require_id(id)?;
        let (id, label) = (id.to_owned(), slice_utf16(js_trim(label), MAX_LABEL));
        self.update(provider, move |pool| {
            if include_default && pool.account("default").is_none() {
                let mut row = Account::new("default");
                row.label = Some("Account 1".into());
                pool.accounts.insert(0, row);
            }
            if pool.account(&id).is_none() {
                if pool.accounts.len() >= MAX_ACCOUNTS {
                    return Err(AccountError::Rejected("At most 20 accounts can be connected.".into()));
                }
                let mut row = Account::new(id);
                row.label = Some(if label.is_empty() {
                    format!("Account {}", pool.accounts.len() + 1)
                } else {
                    label
                });
                pool.accounts.push(row);
            }
            if pool.selected_id.is_none() {
                pool.selected_id = pool.accounts.first().map(|r| r.id.clone());
            }
            Ok(())
        })
        .await
    }

    /// `updateProviderAccounts`: rename, select, reorder, switching policy and
    /// credit use.
    pub async fn change(&self, provider: &str, change: AccountChange) -> Result<Pool, AccountError> {
        self.update(provider, move |pool| {
            if let Some((id, label)) = &change.rename {
                if js_trim(label).is_empty() || utf16_len(label) > MAX_LABEL {
                    return invalid("Invalid account name.");
                }
                let Some(row) = pool.accounts.iter_mut().find(|r| &r.id == id) else {
                    return Err(AccountError::Rejected("Account is no longer connected.".into()));
                };
                row.label = Some(js_trim(label).to_owned());
            }
            if let Some(id) = &change.selected_id {
                require_id(id)?;
                if pool.account(id).is_none() {
                    return Err(AccountError::Rejected("Account is no longer connected.".into()));
                }
                pool.selected_id = Some(id.clone());
            }
            if let Some(order) = &change.order {
                let ids: Vec<&String> = pool.accounts.iter().map(|r| &r.id).collect();
                let distinct: std::collections::HashSet<&String> = order.iter().collect();
                if order.len() != ids.len() || distinct.len() != ids.len() || order.iter().any(|id| !ids.contains(&id)) {
                    return invalid("Account order must contain every connected account exactly once.");
                }
                let mut rows = std::mem::take(&mut pool.accounts);
                pool.accounts = order
                    .iter()
                    .filter_map(|id| rows.iter().position(|r| &r.id == id).map(|at| rows.swap_remove(at)))
                    .collect();
            }
            if let Some(auto) = change.auto {
                // On keeps a non-manual policy; on from manual is switch-at-limit.
                let current = pool.policy();
                pool.set_policy(match (auto, current) {
                    (false, _) => Policy::Manual,
                    (true, Policy::Manual) => Policy::Limit,
                    (true, other) => other,
                });
                pool.auto = Some(auto);
            }
            if let Some(policy) = change.policy {
                pool.set_policy(policy);
            }
            if let Some(credits) = change.use_credits {
                pool.use_credits = Some(credits);
            }
            Ok(())
        })
        .await
    }

    /// Selects `id` only while the selection is still `expected_selected`,
    /// checked under the write's own lock, so a newer manual switch wins. A
    /// given `expected_policy` must also still hold. Returns the pool when the
    /// selection moved.
    pub async fn select_if(
        &self,
        provider: &str,
        expected_selected: Option<&str>,
        id: &str,
        expected_policy: Option<Policy>,
    ) -> Result<Option<Pool>, AccountError> {
        require_id(id)?;
        let (expected, id) = (expected_selected.map(str::to_owned), id.to_owned());
        let moved = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = moved.clone();
        let pool = self
            .update(provider, move |pool| {
                if pool.selected_id != expected || pool.account(&id).is_none() {
                    return Ok(());
                }
                if expected_policy.is_some_and(|p| pool.policy() != p) {
                    return Ok(());
                }
                pool.selected_id = Some(id);
                flag.store(true, std::sync::atomic::Ordering::Release);
                Ok(())
            })
            .await?;
        Ok(moved.load(std::sync::atomic::Ordering::Acquire).then_some(pool))
    }

    pub async fn remove(&self, provider: &str, id: &str) -> Result<Pool, AccountError> {
        require_id(id)?;
        let id = id.to_owned();
        self.update(provider, move |pool| {
            pool.accounts.retain(|r| r.id != id);
            if pool.selected_id.as_deref() == Some(&id) {
                pool.selected_id = pool.accounts.first().map(|r| r.id.clone());
            }
            Ok(())
        })
        .await
    }

    /// Records a usage reading. A fresh observation of available quota
    /// releases a prior refusal, but only on the meters the refusal drew on
    /// and only a MEASURED window.
    pub async fn record_usage(
        &self,
        provider: &str,
        id: &str,
        windows: Vec<QuotaWindowInput>,
    ) -> Result<(), AccountError> {
        if !self.pool(provider).await?.accounts.iter().any(|r| r.id == id) {
            return Ok(());
        }
        let id = id.to_owned();
        let windows: Vec<Window> = windows
            .into_iter()
            .take(12)
            .map(|w| {
                // `models` wins; `except` is kept only when non-empty and no
                // `models` were given.
                let models = model_tokens(w.models);
                let except = model_tokens(w.except)
                    .filter(|e| models.is_none() && !e.is_empty());
                Window {
                    label: slice_utf16(&w.label, 40),
                    used_pct: w.used_pct.filter(|p| p.is_finite()),
                    reset_at: w.reset_at,
                    models,
                    except,
                    limit: w
                        .limit
                        .map(|l| slice_utf16(js_trim(&l), 80))
                        .filter(|l| !l.is_empty()),
                    extra: Default::default(),
                }
            })
            .collect();
        let clock = self.clock.clone();
        self.update(provider, move |pool| {
            let Some(row) = pool.accounts.iter_mut().find(|r| r.id == id) else {
                return Ok(());
            };
            row.usage = Some(Usage {
                windows,
                checked_at: i64::try_from(clock.now_ms()).unwrap_or(i64::MAX),
            });
            let usage = row.usage.clone();
            let kept: Vec<Block> = row
                .blocks()
                .into_iter()
                .filter(|block| {
                    let measured: Vec<&Window> = policy::block_evidence_windows(&usage, block)
                        .into_iter()
                        .filter(|w| w.used_pct.is_some())
                        .collect();
                    // Lifted: some measured window and every one below 100%.
                    measured.is_empty() || !measured.iter().all(|w| w.used_pct.is_some_and(|p| p < 100.0))
                })
                .collect();
            row.set_blocks(kept);
            Ok(())
        })
        .await?;
        Ok(())
    }

    /// Blocks `id` until `until` (Unix ms). A new refusal of the same model
    /// replaces that model's block; every other running block keeps its own
    /// deadline, so refusing one bucket never frees another.
    pub async fn block(
        &self,
        provider: &str,
        id: &str,
        until: i64,
        model: &str,
        options: BlockOptions,
    ) -> Result<Pool, AccountError> {
        let (id, scope) = (id.to_owned(), js_trim(model).to_owned());
        let clock = self.clock.clone();
        self.update(provider, move |pool| {
            let Some(row) = pool.accounts.iter_mut().find(|r| r.id == id) else {
                return Ok(());
            };
            let now = i64::try_from(clock.now_ms()).unwrap_or(i64::MAX);
            let limit = js_trim(&options.limit).to_owned();
            let block = Block {
                blocked_until: if options.reset { until } else { until.min(now + MAX_BLOCK_MS) },
                blocked_model: (!scope.is_empty()).then(|| scope.clone()),
                blocked_limit: (!limit.is_empty()).then_some(limit),
                blocked_source: options.server_scheduled.then(|| "retry-after".to_owned()),
                blocked_quota: options.quota.then_some(true),
            };
            let mut blocks: Vec<Block> = row
                .blocks()
                .into_iter()
                .filter(|b| b.blocked_until > now && b.blocked_model.as_deref().unwrap_or("") != scope)
                .collect();
            blocks.push(block);
            row.set_blocks(blocks);
            Ok(())
        })
        .await
    }

    /// Connecting or hand-picking an account states that its quota is
    /// expected to be different now: its refusal window and meter are dropped.
    pub async fn clear_quota_state(&self, provider: &str, id: &str) -> Result<Pool, AccountError> {
        let id = id.to_owned();
        self.update(provider, move |pool| {
            if let Some(row) = pool.accounts.iter_mut().find(|r| r.id == id) {
                row.clear_blocks();
                row.usage = None;
            }
            Ok(())
        })
        .await
    }

    /// The additional API key ids of custom provider `provider`, in use order.
    pub async fn custom_key_ids(&self, provider: &str) -> Result<Vec<String>, AccountError> {
        if !is_custom_key_provider(provider) {
            return invalid("Unknown custom provider.");
        }
        Ok(self
            .pool(provider)
            .await?
            .accounts
            .into_iter()
            .map(|r| r.id)
            .filter(|id| id != "default")
            .collect())
    }

    /// Sets the additional API keys to `ids`, in use order after the primary
    /// key (`default`). A kept key keeps its cooldown and a still-listed
    /// selection stays. Without an additional key the roster is removed, so a
    /// single-key provider stores nothing here.
    pub async fn set_custom_key_ids(&self, provider: &str, ids: Vec<String>) -> Result<Vec<String>, AccountError> {
        if !is_custom_key_provider(provider) {
            return invalid("Unknown custom provider.");
        }
        let distinct: std::collections::HashSet<&String> = ids.iter().collect();
        if ids.len() >= MAX_ACCOUNTS || distinct.len() != ids.len() {
            return invalid("At most 20 API keys can be used.");
        }
        for id in &ids {
            require_id(id)?;
            if id == "default" {
                return invalid("Invalid provider account id.");
            }
        }
        let (path, name) = (self.roster_path(), provider.to_owned());
        let keep = ids.clone();
        self.io
            .write_job(move |lane| {
                file::update_roster(lane, &path, |roster| {
                    if keep.is_empty() {
                        if let Some(providers) = roster["providers"].as_object_mut() {
                            providers.shift_remove(&name);
                        }
                        return Ok(());
                    }
                    let old = pool_of(roster, &name);
                    let accounts: Vec<Account> = std::iter::once("default".to_owned())
                        .chain(keep)
                        .map(|id| old.account(&id).cloned().unwrap_or_else(|| Account::new(id)))
                        .collect();
                    let selected = old
                        .selected_id
                        .filter(|s| accounts.iter().any(|r| &r.id == s))
                        .unwrap_or_else(|| "default".into());
                    let pool = Pool {
                        accounts,
                        selected_id: Some(selected),
                        use_credits: Some(true),
                        ..Pool::default()
                    };
                    roster["providers"][&name] = serde_json::to_value(pool).map_err(io::Error::other)?;
                    Ok(())
                })
            })
            .await??;
        self.custom_key_ids(provider).await
    }
}

#[cfg(test)]
mod rotation_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod validity_tests;
