//! One server's sign-in: the stored credentials (cached, written through the secret store and
//! the marker files), the renewal of a refused token, and the explicit browser login.
//!
//! One daemon owns the store, but different connections can hold the same credential. They
//! serialize its changes and invalidate cached copies by generation without polling the disk.

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::sync::Weak;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use super::account::identity_from_token_response;
use async_trait::async_trait;
use mixdog_core_api::domain::login::LoginError;
use mixdog_core_api::domain::login::LoginFailure;
use mixdog_core_api::domain::login::LoginFlow;
use mixdog_core_api::domain::login::LoginInput;
use mixdog_core_api::domain::login::LoginSession;
use mixdog_core_api::domain::login::LoginState;
use mixdog_core_api::domain::login::LoginTarget;
use mixdog_rt::DurabilityIo;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::account::AccountMode;
use super::account::Identity;
use super::callback::Callback;
use super::callback::Pasted;
use super::callback::parse_pasted;
use super::protocol::Challenge;
use super::protocol::ClientCredentials;
use super::protocol::Discovery;
use super::protocol::Protocol;
use super::protocol::TokenError;
use super::protocol::parse_challenge;
use super::shared::OAuthError;
use super::store::MarkerFiles;
use super::store::SecretStore;
use super::store::StoredIdentity;
use crate::config::OAuthBinding;
use crate::transport::Authorizer;
use crate::transport::TransportError;

mod login;

/// A sign-in nobody finishes ends here (Node's `MCP_OAUTH_TIMEOUT_MS`).
const LOGIN_DEADLINE: Duration = Duration::from_secs(5 * 60);

/// Where sign-ins are stored.
#[derive(Clone)]
pub struct OAuthEnv {
    pub store: Arc<dyn SecretStore>,
    /// `<plugin data>`; the marker files go under `mcp-oauth/`.
    pub plugin_data: PathBuf,
    pub io: DurabilityIo,
    /// The identity of the installation these sign-ins belong to ([`super::store::installation_identity`]): two
    /// installations over one secret store keep a sign-in each. `None`: the name every installation shares.
    pub installation: Option<String>,
}

/// The stored value, field-compatible with the entries the Node product wrote.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    #[serde(default)]
    url: String,
    #[serde(default)]
    revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tokens: Option<Value>,
    /// Which grant the tokens are of: kept by a renewal, new with the tokens of another authorization. An entry stored
    /// before grants were named has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    grant: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client_information: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    redirect_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    discovery: Option<Discovery>,
    /// `Some(None)`: stored as `null`, which a browser sign-in whose answer named nobody leaves.
    #[serde(default, deserialize_with = "some_null", skip_serializing_if = "Option::is_none")]
    identity: Option<Option<Identity>>,
}

fn some_null<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Option<Identity>>, D::Error> {
    Ok(Some(Option::<Identity>::deserialize(deserializer)?))
}

fn access_token(entry: &Entry) -> Option<String> {
    entry.tokens.as_ref()?.get("access_token")?.as_str().map(str::to_owned)
}

fn refresh_token(entry: &Entry) -> Option<String> {
    entry.tokens.as_ref()?.get("refresh_token")?.as_str().map(str::to_owned)
}

#[derive(Default)]
struct Cache {
    generation: Option<u64>,
    entry: Option<Entry>,
    /// The stored entry when it is bound to another address than this server's: never used, kept for a rollback.
    elsewhere: Option<Entry>,
}

impl Cache {
    fn stored(&self) -> Option<&Entry> {
        self.entry.as_ref().or(self.elsewhere.as_ref())
    }
}

/// Which sign-in `stored` is ([`Authorizer::sign_in`]): a value of the stored entry itself, so it is another one
/// exactly when another grant's tokens, or none, are stored, and the same one through every renewal. No tokens: `0`.
fn sign_in_of(stored: Option<&Entry>) -> u64 {
    let Some(entry) = stored.filter(|entry| entry.tokens.is_some()) else { return 0 };
    let digest =
        Sha256::new().chain_update(entry.url.as_bytes()).chain_update([0u8]).chain_update(entry.grant.as_deref().unwrap_or_default().as_bytes()).finalize();
    u64::from_be_bytes(digest[..8].try_into().expect("eight bytes")).max(1)
}

fn revision_of(text: &str) -> Option<String> {
    serde_json::from_str::<Entry>(text).ok().map(|entry| entry.revision)
}

struct Credential {
    store: Arc<dyn SecretStore>,
    gate: tokio::sync::Semaphore,
    generation: AtomicU64,
    status: Mutex<Option<CredentialStatus>>,
    /// An explicit login or sign-out supersedes a pending switch or its rollback; a token refresh doesn't.
    login_version: AtomicU64,
    /// Which sign-in is stored ([`sign_in_of`]), as the last write or read of the entry left it. Nothing else sets it.
    sign_in: AtomicU64,
    sign_in_required: AtomicBool,
    /// How many [`LoginInProgress`] are held, whichever scope's sign-in object began them.
    logins_in_progress: AtomicU64,
}

struct CredentialStatus {
    has_tokens: bool,
    identity: Option<StoredIdentity>,
}

impl CredentialStatus {
    fn of(entry: Option<&Entry>) -> Self {
        let has_tokens = entry.is_some_and(|entry| entry.tokens.is_some());
        let identity = has_tokens.then(|| {
            let who = entry.and_then(|entry| entry.identity.clone().flatten()).unwrap_or_default();
            let endpoint = entry.and_then(|entry| entry.discovery.as_ref()).and_then(Discovery::authorization_endpoint_text);
            StoredIdentity { account: who.account, workspace: who.workspace, forced_choice: super::account::can_force_account_choice(endpoint.as_deref()) }
        });
        Self { has_tokens, identity }
    }
}

type Credentials = HashMap<(usize, String), Weak<Credential>>;
static CREDENTIALS: LazyLock<Mutex<Credentials>> = LazyLock::new(|| Mutex::new(HashMap::new()));

impl Credential {
    fn shared(store: &Arc<dyn SecretStore>, account: String) -> Arc<Self> {
        let mut all = CREDENTIALS.lock().unwrap_or_else(|e| e.into_inner());
        // Marker paths are projections, not credential namespaces. Keep the store alive with the key.
        let key = (Arc::as_ptr(store).cast::<()>() as usize, account);
        if let Some(credential) = all.get(&key).and_then(Weak::upgrade) {
            return credential;
        }
        all.retain(|_, credential| credential.strong_count() != 0);
        let credential = Arc::new(Self {
            store: Arc::clone(store),
            gate: tokio::sync::Semaphore::new(1),
            generation: AtomicU64::new(0),
            status: Mutex::new(None),
            login_version: AtomicU64::new(0),
            sign_in: AtomicU64::new(0),
            sign_in_required: AtomicBool::new(false),
            logins_in_progress: AtomicU64::new(0),
        });
        all.insert(key, Arc::downgrade(&credential));
        credential
    }
}

/// A holder can read or mutate its cache only on the credential's shared lane.
struct CacheGuard<'a> {
    owner: &'a Mutex<Cache>,
    data: Cache,
    _permit: tokio::sync::SemaphorePermit<'a>,
}

impl std::ops::Deref for CacheGuard<'_> {
    type Target = Cache;
    fn deref(&self) -> &Cache {
        &self.data
    }
}

impl std::ops::DerefMut for CacheGuard<'_> {
    fn deref_mut(&mut self) -> &mut Cache {
        &mut self.data
    }
}

impl Drop for CacheGuard<'_> {
    fn drop(&mut self) {
        *self.owner.lock().unwrap_or_else(|e| e.into_inner()) = std::mem::take(&mut self.data);
    }
}

pub struct McpOAuth {
    binding: OAuthBinding,
    protocol: Protocol,
    files: MarkerFiles,
    /// What the marker files are named after, and the secret-store account of a sign-in no installation owns.
    account: String,
    /// The secret-store account: this installation's own.
    secret_account: String,
    credential: Arc<Credential>,
    cache: Mutex<Cache>,
    /// Every token this connection held: an error echoing one stays scrubbed after a refresh.
    held: Mutex<HashSet<String>>,
    active_login: Mutex<Option<CancellationToken>>,
    /// The explicit version committed by a switch and the entry it replaced.
    switched_from: Mutex<Option<(u64, Option<Entry>)>>,
    /// The `WWW-Authenticate` value (empty when it had none) of the response that last refused a request to this
    /// connection's endpoint; cleared by the next answered request.
    refusal: Mutex<Option<String>>,
}

/// A login of a credential in progress, from before the connect that asks the server for its challenge until the login
/// ended, however it ended. While one is held the server is dialled by every connect of the credential, signed in or not
/// ([`Authorizer::sign_in_absent`]).
pub struct LoginInProgress(Arc<Credential>);

impl LoginInProgress {
    fn of(credential: &Arc<Credential>) -> Self {
        credential.logins_in_progress.fetch_add(1, Ordering::SeqCst);
        Self(Arc::clone(credential))
    }
}

impl Clone for LoginInProgress {
    fn clone(&self) -> Self {
        Self::of(&self.0)
    }
}

impl Drop for LoginInProgress {
    fn drop(&mut self) {
        self.0.logins_in_progress.fetch_sub(1, Ordering::SeqCst);
    }
}

/// The secret-store account of a sign-in: a digest of its key, nothing else.
pub fn account_of(credential_key: &str) -> String {
    let digest = Sha256::digest(credential_key.as_bytes());
    format!("mcp-oauth.{}", digest.iter().map(|b| format!("{b:02x}")).collect::<String>())
}

/// The secret-store account of a sign-in of the installation `installation`.
pub fn secret_account_of(installation: &str, credential_key: &str) -> String {
    let digest = Sha256::new().chain_update(installation.as_bytes()).chain_update([0u8]).chain_update(credential_key.as_bytes()).finalize();
    format!("mcp-oauth.{}", digest.iter().map(|b| format!("{b:02x}")).collect::<String>())
}

/// Why a login ended without tokens.
enum Stop {
    Cancelled,
    Expired,
    Failed(OAuthError),
}

impl From<OAuthError> for Stop {
    fn from(error: OAuthError) -> Self {
        Self::Failed(error)
    }
}

fn store_error(error: super::store::StoreError) -> OAuthError {
    if error.unrun { OAuthError::Unavailable } else { OAuthError::Store(error.message) }
}

impl McpOAuth {
    pub fn new(binding: OAuthBinding, env: &OAuthEnv) -> Result<Arc<Self>, String> {
        let account = account_of(&binding.credential_key);
        let secret_account = env.installation.as_deref().map_or_else(|| account.clone(), |id| secret_account_of(id, &binding.credential_key));
        Ok(Arc::new(Self {
            credential: Credential::shared(&env.store, secret_account.clone()),
            account,
            secret_account,
            binding,
            protocol: Protocol::new()?,
            files: MarkerFiles::new(env.plugin_data.clone(), env.io),
            cache: Mutex::new(Cache::default()),
            held: Mutex::new(HashSet::new()),
            active_login: Mutex::new(None),
            switched_from: Mutex::new(None),
            refusal: Mutex::new(None),
        }))
    }

    /// Whether the last refused token could not be renewed, so the server needs a sign-in.
    pub fn sign_in_required(&self) -> bool {
        self.credential.sign_in_required.load(Ordering::SeqCst)
    }

    pub fn binding(&self) -> &OAuthBinding {
        &self.binding
    }

    /// The challenge of the response that last refused a request of this connection's own transport (a 401, or a 403
    /// asking for more scope), unless a request was answered since: what an explicit sign-in starts from (`authorizedFetch`).
    pub fn refusal_challenge(&self) -> Option<String> {
        self.refusal.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Marks a login of this credential in progress until the answer, and every clone of it, is dropped.
    pub fn login_in_progress(&self) -> LoginInProgress {
        LoginInProgress::of(&self.credential)
    }

    /// Every token this connection held, for scrubbing errors and results.
    pub fn secrets(&self) -> Vec<String> {
        self.held.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect()
    }

    /// Whether tokens are stored, without a keychain read.
    pub async fn has_stored_tokens(&self) -> Result<bool, super::store::StoreError> {
        let _gate = self.credential.gate.acquire().await.expect("the gate is never closed");
        let status = self.credential.status.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|status| status.has_tokens);
        if let Some(has_tokens) = status {
            return Ok(has_tokens);
        }
        self.files.has_tokens(&self.account).await
    }

    /// Who the stored sign-in belongs to, without a keychain read.
    pub async fn stored_identity(&self) -> Result<Option<StoredIdentity>, super::store::StoreError> {
        let _gate = self.credential.gate.acquire().await.expect("the gate is never closed");
        let status = self.credential.status.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|status| status.identity.clone());
        if let Some(identity) = status {
            return Ok(identity);
        }
        self.files.identity(&self.account).await
    }

    fn hold(&self, entry: Option<&Entry>) {
        let Some(tokens) = entry.and_then(|e| e.tokens.as_ref()) else { return };
        let mut held = self.held.lock().unwrap_or_else(|e| e.into_inner());
        for key in ["access_token", "refresh_token"] {
            if let Some(token) = tokens.get(key).and_then(Value::as_str) {
                held.insert(token.to_owned());
            }
        }
    }

    /// Checks the cache out for exclusive use across awaits; it is put back when the guard drops.
    async fn lock_cache(&self) -> CacheGuard<'_> {
        let permit = self.credential.gate.acquire().await.expect("the gate is never closed");
        let data = std::mem::take(&mut *self.cache.lock().unwrap_or_else(|e| e.into_inner()));
        CacheGuard { owner: &self.cache, data, _permit: permit }
    }

    async fn load(&self) -> Result<CacheGuard<'_>, OAuthError> {
        let mut cache = self.lock_cache().await;
        self.load_locked(&mut cache).await?;
        Ok(cache)
    }

    /// The stored entry's text: the installation's own, else the one it wrote under the name every installation shared
    /// (the entry its own marker names, and no other), read where it is. Nothing is written or removed by a read: what
    /// the installation stores from then on goes under its own name, and the shared entry stays as it is.
    async fn stored(&self) -> Result<Option<String>, OAuthError> {
        let store = &self.credential.store;
        let own = store.get(&self.secret_account).await.map_err(store_error)?;
        if own.is_some() || self.secret_account == self.account {
            return Ok(own);
        }
        // The markers are the installation's own: the revision they list is of the entry it wrote.
        let Some(revision) = self.files.revision(&self.account).await.map_err(store_error)? else { return Ok(None) };
        let shared = store.get(&self.account).await.map_err(store_error)?;
        Ok(shared.filter(|text| revision_of(text).as_deref() == Some(revision.as_str())))
    }

    /// `stored` as this server's entry, or as one bound to another address: that one is no entry of this server, never
    /// used and replaced by its next sign-in.
    fn sorted(&self, stored: Option<Entry>) -> (Option<Entry>, Option<Entry>) {
        match stored {
            Some(entry) if entry.url == self.binding.url.as_str() => (Some(entry), None),
            other => (None, other),
        }
    }

    async fn load_locked(&self, cache: &mut Cache) -> Result<(), OAuthError> {
        let generation = self.credential.generation.load(Ordering::Relaxed);
        if cache.generation != Some(generation) {
            let stored = match self.stored().await? {
                Some(text) => Some(serde_json::from_str::<Entry>(&text).map_err(|_| OAuthError::ReauthenticationRequired)?),
                None => None,
            };
            self.credential.sign_in.store(sign_in_of(stored.as_ref()), Ordering::SeqCst);
            let (entry, elsewhere) = self.sorted(stored);
            self.hold(entry.as_ref());
            cache.entry = entry;
            cache.elsewhere = elsewhere;
            cache.generation = Some(generation);
        }
        Ok(())
    }

    async fn write_markers(&self, entry: Option<&Entry>) -> Result<(), OAuthError> {
        let has_tokens = entry.is_some_and(|entry| entry.tokens.is_some());
        self.files.write_revision(&self.account, entry.map(|entry| entry.revision.as_str()), has_tokens).await.map_err(store_error)?;
        let endpoint = entry.and_then(|entry| entry.discovery.as_ref()).and_then(Discovery::authorization_endpoint_text);
        let identity = entry.and_then(|entry| entry.identity.clone().flatten()).unwrap_or_default();
        let who = has_tokens.then_some((&identity, endpoint.as_deref()));
        self.files.write_identity(&self.account, who).await.map_err(store_error)
    }

    /// Stores `entry`. `store_first`: the entry is a renewal of the stored grant or a whole entry put back, and keeps
    /// the grant it names. Any other write whose tokens are not the stored ones stores another grant, named here
    /// unless the entry brings a name of its own (an earlier entry put back).
    /// Which sign-in is stored ([`Authorizer::sign_in`]) follows from the entry the store took, in this write.
    async fn replace(&self, cache: &mut Cache, mut entry: Entry, store_first: bool) -> Result<(), OAuthError> {
        let random = || rand::random::<[u8; 16]>().iter().map(|b| format!("{b:02x}")).collect::<String>();
        let (stored_tokens, stored_grant) = cache.stored().map(|stored| (stored.tokens.clone(), stored.grant.clone())).unwrap_or_default();
        let other_tokens = entry.tokens.is_some() && entry.tokens != stored_tokens;
        if !store_first && other_tokens && (entry.grant.is_none() || entry.grant == stored_grant) {
            entry.grant = Some(random());
        }
        entry.revision = random();
        let text = serde_json::to_string(&entry).map_err(|e| OAuthError::Store(e.to_string()))?;
        // A new sign-in can still fail without replacing the old grant. Stage the markers first.
        // A provider-confirmed rotation cannot be undone; persist it even if a marker cannot be written.
        let write = async {
            if !store_first {
                self.write_markers(Some(&entry)).await?;
            }
            self.credential.store.set(&self.secret_account, &text).await.map_err(store_error)
        };
        let previous = self.credential.generation.fetch_add(1, Ordering::Relaxed);
        if let Err(error) = write.await {
            if !store_first && let Err(restore) = self.write_markers(cache.stored()).await {
                tracing::warn!(%restore, "MCP OAuth status markers could not be restored");
            }
            return Err(error);
        }
        self.credential.sign_in.store(sign_in_of(Some(&entry)), Ordering::SeqCst);
        if store_first && let Err(error) = self.write_markers(Some(&entry)).await {
            tracing::warn!(%error, "MCP OAuth credential was stored but its status markers could not be updated");
        }
        *self.credential.status.lock().unwrap_or_else(|e| e.into_inner()) = Some(CredentialStatus::of(Some(&entry)));
        self.hold(Some(&entry));
        (cache.entry, cache.elsewhere) = self.sorted(Some(entry));
        cache.generation = Some(previous.wrapping_add(1));
        self.credential.sign_in_required.store(false, Ordering::SeqCst);
        Ok(())
    }

    async fn persist(&self, cache: &mut Cache, rotated: bool, change: impl FnOnce(&mut Entry)) -> Result<(), OAuthError> {
        let mut entry = cache.entry.clone().unwrap_or_else(|| Entry { url: self.binding.url.to_string(), ..Entry::default() });
        change(&mut entry);
        self.replace(cache, entry, rotated).await
    }

    async fn erase(&self, cache: &mut Cache) -> Result<(), OAuthError> {
        let previous = self.credential.generation.fetch_add(1, Ordering::Relaxed);
        self.credential.store.delete(&self.secret_account).await.map_err(store_error)?;
        self.credential.sign_in.store(0, Ordering::SeqCst);
        if let Err(error) = self.write_markers(None).await {
            tracing::warn!(%error, "MCP OAuth credential was erased but its status markers could not be updated");
        }
        *self.credential.status.lock().unwrap_or_else(|e| e.into_inner()) = Some(CredentialStatus::of(None));
        cache.entry = None;
        cache.elsewhere = None;
        cache.generation = Some(previous.wrapping_add(1));
        Ok(())
    }

    /// The client requests are made as: the pre-registered one (its secret lives in the secret
    /// store), else the one registered dynamically.
    ///
    /// `Err` when the secret read never ran: a client that lost its secret is refused by the
    /// provider (`invalid_client`), which erases the stored sign-in. A read that ran and failed
    /// is "no secret", as before.
    async fn client_credentials(&self, entry: &Entry) -> Result<Option<ClientCredentials>, OAuthError> {
        if let Some(client) = &self.binding.client {
            let secret = match &client.inline_secret {
                Some(inline) => Some(inline.0.clone()),
                None => match self.credential.store.get(&client.secret_account).await {
                    Ok(secret) => secret.filter(|s| !s.is_empty()),
                    Err(error) if error.unrun => return Err(store_error(error)),
                    Err(_) => None,
                },
            };
            return Ok(Some(ClientCredentials { client_id: client.client_id.clone(), client_secret: secret }));
        }
        Ok(entry.client_information.as_ref().and_then(ClientCredentials::from_info))
    }

    /// Renews a refused token from the refresh token. A failure that needs the user is
    /// `ReauthenticationRequired`.
    async fn refresh(&self, cache: &mut Cache, rejected: Option<String>, challenge: Option<&str>) -> Result<(), OAuthError> {
        let entry = cache.entry.clone().ok_or(OAuthError::ReauthenticationRequired)?;
        // Another request already renewed it.
        if access_token(&entry).is_some() && access_token(&entry) != rejected {
            return Ok(());
        }
        let refresh_token = refresh_token(&entry).ok_or(OAuthError::ReauthenticationRequired)?;
        let client = self.client_credentials(&entry).await?.ok_or(OAuthError::ReauthenticationRequired)?;
        let discovery = match entry.discovery.clone() {
            Some(d) if d.token_endpoint().is_some() => d,
            _ => self
                .protocol
                .discover(&self.binding.url, parse_challenge(challenge).resource_metadata_url.as_deref())
                .await
                .map_err(|_| OAuthError::ReauthenticationRequired)?,
        };
        // A pre-registered client's provider issues tokens for its own APIs: no resource indicator.
        let resource = self.binding.client.is_none().then(|| discovery.resource(&self.binding.url)).flatten();
        let form = vec![("grant_type", "refresh_token".to_owned()), ("refresh_token", refresh_token.clone())];
        match self.protocol.token(&discovery, &client, form, resource).await {
            Ok(mut tokens) => {
                if tokens.get("refresh_token").is_none_or(|t| t.is_null()) {
                    tokens["refresh_token"] = Value::String(refresh_token);
                }
                let identity = identity_from_token_response(&tokens);
                self.persist(cache, true, |e| {
                    e.tokens = Some(tokens);
                    e.discovery = Some(discovery);
                    if identity.is_some() {
                        e.identity = Some(identity);
                    }
                })
                .await?;
                Ok(())
            }
            Err(TokenError::Oauth(code)) if matches!(code.as_str(), "invalid_client" | "unauthorized_client") => {
                self.erase(cache).await?;
                Err(OAuthError::ReauthenticationRequired)
            }
            Err(TokenError::Oauth(code)) if code == "invalid_grant" => {
                // The grant is gone. The registration goes too: an authorization server that
                // forgot its clients would fail every later sign-in at the authorization endpoint.
                self.persist(cache, false, |e| {
                    e.tokens = None;
                    e.client_information = None;
                })
                .await?;
                Err(OAuthError::ReauthenticationRequired)
            }
            // Any other answer invalidates nothing (the SDK's `auth()` recovers only from the two above).
            Err(TokenError::Oauth(_) | TokenError::Failed) => Err(OAuthError::ReauthenticationRequired),
        }
    }

    /// Signs out: forgets the stored sign-in, first revoking the grant at the authorization
    /// server where it documents a revocation endpoint. True when the server confirmed it.
    pub async fn sign_out(&self, revoke: bool) -> Result<bool, OAuthError> {
        let mut cache = self.lock_cache().await;
        let saved = self.stored().await?;
        let entry: Option<Entry> = saved.as_deref().and_then(|text| serde_json::from_str(text).ok());
        // The marker is what keeps an entry under the shared name from being read again, so the sign-out is recorded
        // there first: one that cannot record itself has not signed out, and changes nothing.
        let unrecorded = |error: OAuthError| async {
            if let Err(restore) = self.write_markers(entry.as_ref()).await {
                tracing::warn!(%restore, "MCP OAuth status markers could not be restored");
            }
            error
        };
        if let Err(error) = self.write_markers(None).await {
            return Err(unrecorded(error).await);
        }
        let mut revoked = false;
        if revoke && let Some(entry) = &entry {
            let endpoint = entry.discovery.as_ref().and_then(Discovery::revocation_endpoint);
            let token = refresh_token(entry).or_else(|| access_token(entry));
            if let (Some(endpoint), Some(token), Some(client)) = (endpoint, token, entry.client_information.as_ref().and_then(ClientCredentials::from_info)) {
                revoked = self.protocol.revoke(&endpoint, &token, refresh_token(entry).is_some(), &client).await;
            }
        }
        self.credential.login_version.fetch_add(1, Ordering::Relaxed);
        if let Err(error) = self.erase(&mut cache).await {
            return Err(unrecorded(error).await);
        }
        Ok(revoked)
    }

    /// Restores the sign-in an account switch replaced (the new one failed to connect).
    pub async fn rollback_switch(&self) -> Result<(), OAuthError> {
        let mut cache = self.lock_cache().await;
        let Some((version, previous)) = self.switched_from.lock().unwrap_or_else(|e| e.into_inner()).take() else { return Ok(()) };
        if version != self.credential.login_version.load(Ordering::Relaxed) {
            return Ok(());
        }
        self.credential.login_version.fetch_add(1, Ordering::Relaxed);
        match previous {
            Some(entry) => self.replace(&mut cache, entry, true).await?,
            None => self.erase(&mut cache).await?,
        }
        Ok(())
    }

    /// The sign-in flow of this server, as the login mechanism runs it.
    pub fn login_flow(self: &Arc<Self>, server: &str, mode: AccountMode) -> McpLoginFlow {
        McpLoginFlow {
            oauth: Arc::clone(self),
            target: LoginTarget::McpServer(server.to_owned()),
            mode,
            transactional: false,
            challenge: Challenge::default(),
            in_progress: self.login_in_progress(),
        }
    }

    /// A sign-in beside the stored one, in any mode (an account of a multi-account connector):
    /// like a switch it keeps what it replaced, so [`rollback_switch`](Self::rollback_switch)
    /// can put it back.
    pub fn login_flow_beside(self: &Arc<Self>, server: &str, mode: AccountMode) -> McpLoginFlow {
        McpLoginFlow { transactional: true, ..self.login_flow(server, mode) }
    }
}

#[async_trait]
impl Authorizer for McpOAuth {
    fn sign_in_required(&self) -> bool {
        McpOAuth::sign_in_required(self)
    }

    fn sign_in(&self) -> u64 {
        self.credential.sign_in.load(Ordering::SeqCst)
    }

    /// Known before any dial only: a catalog connector at the catalog's sign-in address with no usable tokens stored.
    /// A refusal met while talking to a server proves nothing about its next connect. Never while a login of the
    /// credential is in progress ([`LoginInProgress`]): that login starts from what the server answers a connect with.
    async fn sign_in_absent(&self) -> bool {
        if !self.binding.requires_sign_in || self.credential.logins_in_progress.load(Ordering::SeqCst) > 0 {
            return false;
        }
        let mut cache = self.lock_cache().await;
        let absent = match self.load_locked(&mut cache).await {
            Ok(()) => cache.entry.as_ref().is_none_or(|entry| entry.tokens.is_none()),
            // An entry that cannot be read is no sign-in.
            Err(OAuthError::ReauthenticationRequired) => true,
            // A store that did not answer says nothing about the sign-in.
            Err(_) => false,
        };
        if absent {
            self.credential.sign_in_required.store(true, Ordering::SeqCst);
        }
        absent
    }

    async fn token(&self) -> Result<Option<String>, TransportError> {
        // An unreadable keychain must not block a server that needs no authentication.
        let Ok(cache) = self.load().await else { return Ok(None) };
        Ok(cache.entry.as_ref().and_then(access_token))
    }

    /// The token and the sign-in it is of, from one read of the entry.
    async fn token_as(&self) -> Result<Option<(u64, Option<String>)>, TransportError> {
        let Ok(cache) = self.load().await else { return Ok(None) };
        Ok(Some((sign_in_of(cache.stored()), cache.entry.as_ref().and_then(access_token))))
    }

    async fn renew(&self, rejected: Option<String>, challenge: Option<String>) -> Result<(), TransportError> {
        // A refusal without a challenge is still one: it is kept as an empty value.
        *self.refusal.lock().unwrap_or_else(|e| e.into_inner()) = Some(challenge.clone().unwrap_or_default());
        let mut cache = self.lock_cache().await;
        // A store that never answered is not a sign-in that needs renewing by the user.
        let renewed = match self.load_locked(&mut cache).await {
            Ok(()) => self.refresh(&mut cache, rejected, challenge.as_deref()).await,
            Err(OAuthError::Unavailable) => Err(OAuthError::Unavailable),
            Err(_) => Err(OAuthError::ReauthenticationRequired),
        };
        self.credential.sign_in_required.store(matches!(renewed, Err(OAuthError::ReauthenticationRequired)), Ordering::SeqCst);
        renewed.map_err(Into::into)
    }

    /// The renewed token was refused too: that last refusal's challenge is the one the sign-in must answer.
    fn refused_after_renewal(&self, _attempted: Option<&str>, challenge: Option<&str>) {
        *self.refusal.lock().unwrap_or_else(|e| e.into_inner()) = Some(challenge.unwrap_or_default().to_owned());
    }

    /// The endpoint answered: whatever it refused before no longer stands.
    fn answered(&self, _sent: Option<&str>) {
        self.refusal.lock().unwrap_or_else(|e| e.into_inner()).take();
    }
}

// the explicit login

struct Pending {
    redirect_url: String,
    state: String,
    callbacks: mpsc::UnboundedSender<Callback>,
    /// Closes the listener, as a pasted callback does before the exchange runs.
    stopper: super::callback::Stopper,
}

struct Control {
    current: Mutex<LoginState>,
    /// States not yet delivered through `next`.
    queue: Mutex<std::collections::VecDeque<LoginState>>,
    queued: tokio::sync::Notify,
    cancel: CancellationToken,
    pending: Mutex<Option<Pending>>,
}

impl Control {
    fn emit(&self, state: LoginState) {
        *self.current.lock().unwrap_or_else(|e| e.into_inner()) = state.clone();
        self.queue.lock().unwrap_or_else(|e| e.into_inner()).push_back(state);
        self.queued.notify_one();
    }
}

pub struct McpLoginFlow {
    oauth: Arc<McpOAuth>,
    target: LoginTarget,
    mode: AccountMode,
    transactional: bool,
    /// The `WWW-Authenticate` challenge that asked for the sign-in.
    challenge: Challenge,
    /// Held by the flow, and by each login it starts until that login ended.
    in_progress: LoginInProgress,
}

impl McpLoginFlow {
    /// The challenge of the request the server refused, all of it (`auth(provider, { serverUrl, ...challenge })`): discovery
    /// asks the resource metadata URL it names, and the authorization asks for the scope it names.
    #[must_use]
    pub fn with_challenge(mut self, challenge: Option<&str>) -> Self {
        self.challenge = parse_challenge(challenge);
        self
    }
}

struct Session {
    control: Arc<Control>,
    delivered_terminal: std::sync::atomic::AtomicBool,
}

fn failure_of(error: OAuthError) -> LoginFailure {
    let message = error.to_string();
    let code = match error {
        OAuthError::ReauthenticationRequired => "reauthenticationRequired",
        OAuthError::LoginFailed => "loginFailed",
        OAuthError::ScopeNotGranted(_) => "scopeNotGranted",
        OAuthError::Store(_) | OAuthError::Unavailable => "store",
    };
    LoginFailure::Failed { code: code.to_owned(), message }
}

#[async_trait]
impl LoginFlow for McpLoginFlow {
    fn target(&self) -> &LoginTarget {
        &self.target
    }

    async fn start(&self) -> Result<Box<dyn LoginSession>, LoginError> {
        let cancel = CancellationToken::new();
        // One sign-in per server: a new one replaces the pending one.
        if let Some(previous) = self.oauth.active_login.lock().unwrap_or_else(|e| e.into_inner()).replace(cancel.clone()) {
            previous.cancel();
        }
        let control = Arc::new(Control {
            current: Mutex::new(LoginState::Starting),
            queue: Mutex::new(std::collections::VecDeque::new()),
            queued: tokio::sync::Notify::new(),
            cancel,
            pending: Mutex::new(None),
        });
        let (oauth, mode, transactional, challenge, task_control) =
            (Arc::clone(&self.oauth), self.mode, self.transactional, self.challenge.clone(), Arc::clone(&control));
        let in_progress = self.in_progress.clone();
        mixdog_rt::spawn("mcp.oauth.login", mixdog_rt::TaskClass::Work, async move {
            let last = match oauth.run_login(mode, transactional, challenge, &task_control).await {
                Ok(account) => LoginState::Done { account },
                Err(Stop::Cancelled) => LoginState::Cancelled,
                Err(Stop::Expired) => LoginState::Failed(LoginFailure::Expired),
                Err(Stop::Failed(error)) => LoginState::Failed(failure_of(error)),
            };
            // Over before its last state is read: whoever acts on that state meets the rule as it stands again.
            drop(in_progress);
            task_control.emit(last);
        });
        Ok(Box::new(Session { control, delivered_terminal: false.into() }))
    }
}

#[async_trait]
impl LoginSession for Session {
    fn state(&self) -> LoginState {
        self.control.current.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    async fn next(&self) -> Option<LoginState> {
        use std::sync::atomic::Ordering;
        if self.delivered_terminal.load(Ordering::SeqCst) {
            return None;
        }
        let state = loop {
            // `notify_one` stores a permit, so a state pushed between the pop and the wait is not lost.
            if let Some(state) = self.control.queue.lock().unwrap_or_else(|e| e.into_inner()).pop_front() {
                break state;
            }
            self.control.queued.notified().await;
        };
        if state.is_terminal() {
            self.delivered_terminal.store(true, Ordering::SeqCst);
        }
        Some(state)
    }

    async fn provide(&self, input: LoginInput) -> Result<(), LoginError> {
        let LoginInput::AuthorizationCode(pasted) = input;
        if self.state().is_terminal() {
            return Err(LoginError::Finished);
        }
        let (waiting, parsed) = {
            let mut pending = self.control.pending.lock().unwrap_or_else(|e| e.into_inner());
            let Some(waiting) = pending.as_ref() else { return Err(LoginError::InputNotExpected) };
            let parsed = parse_pasted(&pasted, &waiting.redirect_url, &waiting.state)
                .map_err(|message| LoginError::Failed(LoginFailure::Failed { code: "invalidCallback".to_owned(), message: message.to_owned() }))?;
            // The same answer the loopback would give; an invalid paste above leaves the login pending.
            (pending.take().ok_or(LoginError::InputNotExpected)?, parsed)
        };
        // Node stops listening before it answers the callback: while the exchange runs, the browser is refused.
        waiting.stopper.shutdown(None).await;
        let code = match parsed {
            Pasted::Code(code) => Some(code),
            Pasted::Denied => None,
        };
        let _ = waiting.callbacks.send(Callback::unheld(code));
        Ok(())
    }

    fn cancel(&self) {
        self.control.cancel.cancel();
    }
}
