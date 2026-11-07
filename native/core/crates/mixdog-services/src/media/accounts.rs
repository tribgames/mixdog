//! A media run on a chosen provider account (`provider-auth-binding.mjs` `withProviderAccount`,
//! `lanes.mjs` `mediaLaneAccountProvider`): the pinned account of a lane is the one its
//! credentials come from, for the whole listing or generation, while every other provider keeps
//! its own selected account. Node scopes this with an async-local store; here the account is an
//! explicit [`AccountScope`] the lane sources are built with ([`ScopedLaneSources`]), so nothing
//! is ambient.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_js::js_trim;
use serde_json::Value;

use super::catalog::CatalogFailure;
use super::lanes::{CatalogRows, LaneSources, MediaLanes, lane_auth_provider};
use super::tool::PinnedAccounts;

/// `ACCOUNT_PROVIDERS` (`provider-accounts.mjs`): the providers that pool several accounts.
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

/// `mediaLaneAccountProvider(laneId)`: the provider whose connected accounts a lane generates
/// through, or `""` for a lane that authenticates with a single API key.
pub fn media_lane_account_provider(lane_id: &str) -> &'static str {
    lane_auth_provider(lane_id).filter(|provider| ACCOUNT_PROVIDERS.contains(provider)).unwrap_or("")
}

/// `isCustomKeyProvider`: `custom-<something>`.
fn is_custom_key_provider(provider: &str) -> bool {
    provider.strip_prefix("custom-").is_some_and(|rest| !rest.is_empty())
}

/// `/^[a-f0-9-]{36}$/`.
fn valid_account_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
}

/// `providerAccountPath(provider, id)`: `None` for the `default` account (its credentials live
/// where the provider keeps them), else `<data>/provider-accounts/<provider>/<id>.json`.
pub fn provider_account_path(data_dir: &Path, provider: &str, id: &str) -> Result<Option<PathBuf>, String> {
    if !ACCOUNT_PROVIDERS.contains(&provider) && !is_custom_key_provider(provider) {
        return Err("Unknown OAuth provider.".to_owned());
    }
    if id != "default" && !valid_account_id(id) {
        return Err("Invalid provider account id.".to_owned());
    }
    Ok((id != "default").then(|| data_dir.join("provider-accounts").join(provider).join(format!("{id}.json"))))
}

/// The account each provider has selected (`readProviderAccountPool(provider).selectedId`).
/// Async: Node reads the roster fresh on every call, which is a read on the credential lane.
#[async_trait]
pub trait SelectedAccounts: Send + Sync {
    async fn selected(&self, provider: &str) -> Option<String>;
}

/// The accounts a run is bound to: `withProviderAccount` calls, innermost last (a nested call of
/// the same provider replaces the outer one).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AccountScope {
    bindings: Vec<(String, String)>,
    /// `replaceProviderAuthBindings`: a credential file the host bound for a provider (the
    /// pristine `mixdog exec` run binds the selected provider's file in process; its tools,
    /// media among them, run with the full set). It outranks the account pool and, inside a
    /// scope, is what the default account falls back to.
    host: Vec<(String, PathBuf)>,
}

impl AccountScope {
    /// A scope under the host's bindings; `with` adds the account scopes.
    pub fn under_host(host: Vec<(String, PathBuf)>) -> Self {
        Self { bindings: Vec::new(), host }
    }

    fn host_path(&self, provider: &str) -> Option<&Path> {
        self.host.iter().find(|(bound, path)| bound == js_trim(provider) && !path.as_os_str().is_empty()).map(|(_, path)| path.as_path())
    }

    /// `withProviderAccount(provider, id, …)` inside this scope. A provider that pools no accounts,
    /// or an id that is not one, is refused as Node refuses it.
    pub fn with(&self, data_dir: &Path, provider: &str, id: &str) -> Result<Self, String> {
        provider_account_path(data_dir, provider, id)?;
        let mut bindings: Vec<(String, String)> = self.bindings.iter().filter(|(bound, _)| bound != provider).cloned().collect();
        bindings.push((provider.to_owned(), id.to_owned()));
        Ok(Self { bindings, host: self.host.clone() })
    }

    fn bound(&self, provider: &str) -> Option<&str> {
        self.bindings.iter().find(|(bound, _)| bound == provider).map(|(_, id)| id.as_str())
    }

    /// `currentProviderAccountId(provider)`: the bound account, else the provider's selected
    /// one, else `default`. (Node's host bindings of isolated runtimes are not modeled.)
    pub async fn account_id(&self, provider: &str, selected: &dyn SelectedAccounts) -> String {
        if let Some(id) = self.bound(provider) {
            return id.to_owned();
        }
        // An explicit host binding names one credential file: its account is the default one.
        if self.host_path(provider).is_some() || !ACCOUNT_PROVIDERS.contains(&provider) {
            return "default".to_owned();
        }
        selected.selected(provider).await.filter(|id| !id.is_empty()).unwrap_or_else(|| "default".to_owned())
    }

    /// `boundProviderAuthPath(provider)`: where the credentials of the provider's account in this
    /// scope are; `None` for the default account and for a provider with no accounts.
    pub async fn auth_path(&self, data_dir: &Path, provider: &str, selected: &dyn SelectedAccounts) -> Option<PathBuf> {
        if let Some(id) = self.bound(provider) {
            return provider_account_path(data_dir, provider, id).ok().flatten().or_else(|| self.host_path(provider).map(Path::to_owned));
        }
        if let Some(path) = self.host_path(provider) {
            return Some(path.to_owned());
        }
        if !ACCOUNT_PROVIDERS.contains(&provider) {
            return None;
        }
        provider_account_path(data_dir, provider, &self.account_id(provider, selected).await).ok().flatten()
    }
}

/// What the lanes read of the credentials and the catalog of one account; the file-level
/// probes of each lane's credentials and the catalog fetch are the implementer's.
#[async_trait]
pub trait AccountProbe: Send + Sync {
    /// Whether the lane has usable credentials. `account` is the credential file of the account the
    /// lane is bound to; `None` is the provider's default location.
    async fn authenticated(&self, lane_id: &str, account: Option<&Path>) -> bool;
    async fn models(&self, lane_id: &str, account: Option<&Path>) -> Result<CatalogRows, CatalogFailure>;
}

/// [`LaneSources`] for one scope: every lane's credentials come from the account the scope binds
/// its provider to.
pub struct ScopedLaneSources {
    pub data_dir: PathBuf,
    pub scope: AccountScope,
    pub selected: Arc<dyn SelectedAccounts>,
    pub probe: Arc<dyn AccountProbe>,
}

impl ScopedLaneSources {
    async fn account_of(&self, lane_id: &str) -> Option<PathBuf> {
        match media_lane_account_provider(lane_id) {
            "" => None,
            provider => self.scope.auth_path(&self.data_dir, provider, self.selected.as_ref()).await,
        }
    }
}

#[async_trait]
impl LaneSources for ScopedLaneSources {
    async fn authenticated(&self, lane: &str) -> bool {
        let account = self.account_of(lane).await;
        self.probe.authenticated(lane, account.as_deref()).await
    }

    async fn models(&self, lane: &str) -> Result<CatalogRows, CatalogFailure> {
        let account = self.account_of(lane).await;
        self.probe.models(lane, account.as_deref()).await
    }
}

/// [`PinnedAccounts`] over the scoped lane sources: the pinned lane's provider, and the catalog as
/// the pinned account sees it.
pub struct StudioAccounts {
    pub data_dir: PathBuf,
    /// The host's credential bindings (AccountScope::under_host); empty outside a pristine run.
    pub host: Vec<(String, PathBuf)>,
    pub selected: Arc<dyn SelectedAccounts>,
    pub probe: Arc<dyn AccountProbe>,
}

#[async_trait]
impl PinnedAccounts for StudioAccounts {
    fn provider_of(&self, lane: &str) -> String {
        media_lane_account_provider(lane).to_owned()
    }

    async fn lanes_as(&self, provider: &str, account: &str) -> Result<Vec<Value>, String> {
        let scope = AccountScope::under_host(self.host.clone()).with(&self.data_dir, provider, account)?;
        let sources = ScopedLaneSources { data_dir: self.data_dir.clone(), scope, selected: self.selected.clone(), probe: self.probe.clone() };
        Ok(MediaLanes::new(Arc::new(sources)).list(None).await)
    }
}
