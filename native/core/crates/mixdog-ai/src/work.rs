//! What this crate has read of credentials and built of providers, counted so a test can show that a reader of non-credential
//! settings does neither (`decisions.md` "Node daemon hot paths found by profiling" 6). Counted at the points every route
//! passes, not at one caller: the read of a credential (an OAuth credential file, the account roster, the gcloud login, the
//! keychain, a key variable), the construction of a provider adapter (in each adapter's constructor, so `build`,
//! `build_custom_parts` and every other construction count alike), and the load of the effective provider map. Compiled only with the
//! test-only feature `count-work`, which a dev-dependency turns on; a test takes the difference around the read it watches.

use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

static CREDENTIAL_READS: AtomicU64 = AtomicU64::new(0);
static PROVIDERS_BUILT: AtomicU64 = AtomicU64::new(0);
static PROVIDER_LOADS: AtomicU64 = AtomicU64::new(0);

/// One read of a credential, key or token from disk or the OS store. `pub` for the callers of this crate that read one
/// themselves (`KeychainVault::get`, the OAuth describe loader), so their reads move the same counter.
pub fn credential_read() {
    CREDENTIAL_READS.fetch_add(1, Ordering::Relaxed);
}

pub(crate) fn provider_built() {
    PROVIDERS_BUILT.fetch_add(1, Ordering::Relaxed);
}

pub(crate) fn providers_loaded() {
    PROVIDER_LOADS.fetch_add(1, Ordering::Relaxed);
}

/// Credential reads since the process started: a credential file (`oauth::store`), the account roster
/// (`accounts::file::read_roster`, which holds the custom key ids), the gcloud login file, a keychain read, a key
/// variable read.
pub fn credential_reads() -> u64 {
    CREDENTIAL_READS.load(Ordering::Relaxed)
}

/// Provider adapters constructed (the constructors of `AnthropicAdapter`, `OpenAiAdapter`, `CompatAdapter`, `HttpAdapter`,
/// `GoogleAdapter`, `CursorAdapter`, `DevinAdapter` and `MultiWireAdapter`).
pub fn providers_built() -> u64 {
    PROVIDERS_BUILT.load(Ordering::Relaxed)
}

/// `EffectiveProviders::load` runs: the provider map rebuilt from the stored settings and, with secrets, the credentials.
pub fn provider_loads() -> u64 {
    PROVIDER_LOADS.load(Ordering::Relaxed)
}