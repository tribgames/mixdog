//! Which account a provider's credentials resolve to right now
//! (`provider-auth-binding.mjs`): the one a surrounding
//! [`with_provider_account`] scope names, else an explicit host binding, else
//! the pool's selected account.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::sync::RwLock;
use std::sync::PoisonError;

use super::AccountError;
use super::AccountStore;
use super::is_account_provider;

const DEFAULT: &str = "default";

tokio::task_local! {
    static SCOPED: HashMap<String, String>;
}

/// `globalThis[Symbol.for('mixdog.providerAuthBindings')]`: provider -> credential path.
static BINDINGS: RwLock<Option<Arc<HashMap<String, String>>>> = RwLock::new(None);

/// `withProviderAccount(provider, id, run)`: `run` and everything it awaits resolve
/// `provider` to account `id`.
pub async fn with_provider_account<F: Future>(provider: &str, id: &str, run: F) -> F::Output {
    let mut scope = SCOPED.try_with(Clone::clone).unwrap_or_default();
    scope.insert(provider.to_owned(), id.to_owned());
    SCOPED.scope(scope, run).await
}

/// `replaceProviderAuthBindings(next)`: returns the restore step (once only).
pub fn replace_provider_auth_bindings(next: HashMap<String, String>) -> impl FnOnce() {
    let previous = BINDINGS.write().unwrap_or_else(PoisonError::into_inner).replace(Arc::new(next));
    move || *BINDINGS.write().unwrap_or_else(PoisonError::into_inner) = previous
}

/// `hasExplicitProviderAuthBinding(provider)`.
pub fn has_explicit_provider_auth_binding(provider: &str) -> bool {
    BINDINGS
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
        .is_some_and(|b| b.get(provider).is_some_and(|path| !path.is_empty()))
}

impl AccountStore {
    /// `currentProviderAccountId(provider)`. A provider without accounts, an
    /// absent roster, a damaged one with no good `.bak` (the roster read keeps
    /// it aside and restores the backup, `readJsonStateSync`), a newer build's
    /// roster, and a pool with no selection all give `default`. Only an I/O
    /// failure reading the file errs, where Node's read throws.
    pub async fn current_provider_account_id(&self, provider: &str) -> Result<String, AccountError> {
        if let Ok(Some(id)) = SCOPED.try_with(|scope| scope.get(provider).cloned()) {
            return Ok(id);
        }
        if has_explicit_provider_auth_binding(provider) || !is_account_provider(provider) {
            return Ok(DEFAULT.to_owned());
        }
        let pool = self.pool(provider).await?;
        Ok(pool.selected_id.filter(|id| !id.is_empty()).unwrap_or_else(|| DEFAULT.to_owned()))
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "fixtures are written directly")]
mod tests {
    use super::*;
    use crate::oauth::CredentialIo;

    const PROVIDER: &str = "command-code-oauth";
    const ID: &str = "11111111-1111-4111-8111-111111111111";

    fn store(dir: &tempfile::TempDir) -> AccountStore {
        let tokens = mixdog_rt::testing::tokens();
        AccountStore::new(
            dir.path().to_path_buf(),
            CredentialIo { read: tokens.interactive_io, write: tokens.durability_io },
        )
    }

    #[tokio::test]
    async fn resolution_follows_scope_then_binding_then_the_pool() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(&dir);
        // No roster, and a provider that has no accounts.
        let current = |p: &'static str| {
            let s = &s;
            async move { s.current_provider_account_id(p).await.unwrap() }
        };
        assert_eq!(current(PROVIDER).await, "default");
        assert_eq!(current("openai").await, "default");
        s.register(PROVIDER, ID, "A", true).await.unwrap();
        s.change(PROVIDER, super::super::AccountChange { selected_id: Some(ID.into()), ..Default::default() }).await.unwrap();
        assert_eq!(current(PROVIDER).await, ID);
        // A scope names its account, for that provider only.
        let scoped = with_provider_account(PROVIDER, "scoped-id", async { (current(PROVIDER).await, current("anthropic-oauth").await) }).await;
        assert_eq!(scoped, ("scoped-id".to_owned(), "default".to_owned()));
        // An explicit host binding beats the pool, and restores.
        let restore = replace_provider_auth_bindings(HashMap::from([(PROVIDER.to_owned(), "/tmp/c.json".to_owned())]));
        assert!(has_explicit_provider_auth_binding(PROVIDER));
        assert_eq!(current(PROVIDER).await, "default");
        restore();
        assert!(!has_explicit_provider_auth_binding(PROVIDER));
        assert_eq!(current(PROVIDER).await, ID);
    }

    /// `atomic-file.mjs:622-628`: while another writer holds the lock for the
    /// whole wait, a damaged roster is left in place and the answer is `default`.
    #[tokio::test]
    async fn a_held_lock_answers_default_and_leaves_the_damaged_roster_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(&dir);
        s.register(PROVIDER, ID, "A", true).await.unwrap();
        s.change(PROVIDER, super::super::AccountChange { selected_id: Some(ID.into()), ..Default::default() }).await.unwrap();
        s.change(PROVIDER, super::super::AccountChange { policy: Some(super::super::Policy::Headroom), ..Default::default() }).await.unwrap();
        std::fs::write(s.roster_path(), b"{ truncated").unwrap();
        let mut lock_name = s.roster_path().into_os_string();
        lock_name.push(".lock");
        let holder = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(lock_name).unwrap();
        holder.lock().unwrap();
        let started = std::time::Instant::now();
        let answer = tokio::time::timeout(std::time::Duration::from_secs(8), s.current_provider_account_id(PROVIDER))
            .await
            .expect("a held lock must not stall account resolution");
        assert_eq!(answer.unwrap(), "default");
        assert!(started.elapsed() < std::time::Duration::from_secs(10), "bounded by the lock timeout");
        assert_eq!(std::fs::read(s.roster_path()).unwrap(), b"{ truncated");
        let aside = std::fs::read_dir(dir.path()).unwrap().filter_map(Result::ok).any(|e| e.file_name().to_string_lossy().contains(".corrupt-"));
        assert!(!aside, "nothing was moved aside");
        holder.unlock().unwrap();
        // Released: the next read restores the backup.
        assert_eq!(s.current_provider_account_id(PROVIDER).await.unwrap(), ID);
    }

    /// `readJsonStateSync`: a damaged roster never throws. The last good copy
    /// (`.bak`) is restored when there is one, else the answer is `default`.
    #[tokio::test]
    async fn a_damaged_roster_restores_the_backup_or_answers_default() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(&dir);
        s.register(PROVIDER, ID, "A", true).await.unwrap();
        s.change(PROVIDER, super::super::AccountChange { selected_id: Some(ID.into()), ..Default::default() }).await.unwrap();
        // The next write keeps the one that selected ID as `.bak`; damage the live file.
        s.change(PROVIDER, super::super::AccountChange { policy: Some(super::super::Policy::Headroom), ..Default::default() }).await.unwrap();
        std::fs::write(s.roster_path(), b"{ truncated").unwrap();
        assert_eq!(s.current_provider_account_id(PROVIDER).await.unwrap(), ID);
        let aside = std::fs::read_dir(dir.path()).unwrap().filter_map(Result::ok).any(|e| e.file_name().to_string_lossy().contains(".corrupt-"));
        assert!(aside, "the damaged copy is kept aside");
        // Damage with no good copy at all.
        let bare = tempfile::tempdir().unwrap();
        let t = store(&bare);
        std::fs::write(t.roster_path(), b"{ truncated").unwrap();
        assert_eq!(t.current_provider_account_id(PROVIDER).await.unwrap(), "default");
    }
}
