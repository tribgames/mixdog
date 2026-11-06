//! A media run on a chosen provider account (`provider-auth-binding.mjs` `withProviderAccount`,
//! `lanes.mjs` `mediaLaneAccountProvider`): the pinned account of a lane is the one its
//! credentials come from, for the whole listing or generation, while every other provider keeps
//! its own selected account. Node scopes this with an async-local store; here the account is an
//! explicit [`AccountScope`] the lane sources are built with ([`ScopedLaneSources`]), so nothing
//! is ambient.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
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
pub trait SelectedAccounts: Send + Sync {
    fn selected(&self, provider: &str) -> Option<String>;
}

/// The accounts a run is bound to: `withProviderAccount` calls, innermost last (a nested call of
/// the same provider replaces the outer one).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AccountScope {
    bindings: Vec<(String, String)>,
}

impl AccountScope {
    /// `withProviderAccount(provider, id, …)` inside this scope. A provider that pools no accounts,
    /// or an id that is not one, is refused as Node refuses it.
    pub fn with(&self, data_dir: &Path, provider: &str, id: &str) -> Result<Self, String> {
        provider_account_path(data_dir, provider, id)?;
        let mut bindings: Vec<(String, String)> = self.bindings.iter().filter(|(bound, _)| bound != provider).cloned().collect();
        bindings.push((provider.to_owned(), id.to_owned()));
        Ok(Self { bindings })
    }

    fn bound(&self, provider: &str) -> Option<&str> {
        self.bindings.iter().find(|(bound, _)| bound == provider).map(|(_, id)| id.as_str())
    }

    /// `currentProviderAccountId(provider)`: the bound account, else the provider's selected
    /// one, else `default`. (Node's host bindings of isolated runtimes are not modeled.)
    pub fn account_id(&self, provider: &str, selected: &dyn SelectedAccounts) -> String {
        if let Some(id) = self.bound(provider) {
            return id.to_owned();
        }
        if !ACCOUNT_PROVIDERS.contains(&provider) {
            return "default".to_owned();
        }
        selected.selected(provider).filter(|id| !id.is_empty()).unwrap_or_else(|| "default".to_owned())
    }

    /// `boundProviderAuthPath(provider)`: where the credentials of the provider's account in this
    /// scope are; `None` for the default account and for a provider with no accounts.
    pub fn auth_path(&self, data_dir: &Path, provider: &str, selected: &dyn SelectedAccounts) -> Option<PathBuf> {
        if !ACCOUNT_PROVIDERS.contains(&provider) {
            return None;
        }
        provider_account_path(data_dir, provider, &self.account_id(provider, selected)).ok().flatten()
    }
}

/// What the lanes read of the credentials and the catalog of one account; the file-level
/// probes of each lane's credentials and the catalog fetch are the implementer's.
#[async_trait]
pub trait AccountProbe: Send + Sync {
    /// Whether the lane has usable credentials. `account` is the credential file of the account the
    /// lane is bound to; `None` is the provider's default location.
    fn authenticated(&self, lane_id: &str, account: Option<&Path>) -> bool;
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
    fn account_of(&self, lane_id: &str) -> Option<PathBuf> {
        match media_lane_account_provider(lane_id) {
            "" => None,
            provider => self.scope.auth_path(&self.data_dir, provider, self.selected.as_ref()),
        }
    }
}

#[async_trait]
impl LaneSources for ScopedLaneSources {
    fn authenticated(&self, lane: &str) -> bool {
        self.probe.authenticated(lane, self.account_of(lane).as_deref())
    }

    async fn models(&self, lane: &str) -> Result<CatalogRows, CatalogFailure> {
        self.probe.models(lane, self.account_of(lane).as_deref()).await
    }
}

/// [`PinnedAccounts`] over the scoped lane sources: the pinned lane's provider, and the catalog as
/// the pinned account sees it.
pub struct StudioAccounts {
    pub data_dir: PathBuf,
    pub selected: Arc<dyn SelectedAccounts>,
    pub probe: Arc<dyn AccountProbe>,
}

#[async_trait]
impl PinnedAccounts for StudioAccounts {
    fn provider_of(&self, lane: &str) -> String {
        media_lane_account_provider(lane).to_owned()
    }

    async fn lanes_as(&self, provider: &str, account: &str) -> Result<Vec<Value>, String> {
        let scope = AccountScope::default().with(&self.data_dir, provider, account)?;
        let sources = ScopedLaneSources { data_dir: self.data_dir.clone(), scope, selected: self.selected.clone(), probe: self.probe.clone() };
        Ok(MediaLanes::new(Arc::new(sources)).list(None).await)
    }
}
