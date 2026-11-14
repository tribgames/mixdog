//! Page leases (`local-page-server.ts`): an unguessable token names one page and the authority it was granted under. A lease has a hard
//! lifetime that traffic never renews, and the table holds at most [`MAX_LOCAL_PAGE_LEASES`]; room is made by dropping the lease whose last
//! successful request is oldest.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// Hard limit, not renewed by page traffic: a chat link is opened again for a fresh URL.
pub const LOCAL_PAGE_TTL: Duration = Duration::from_secs(60 * 60);
pub const MAX_LOCAL_PAGE_LEASES: usize = 128;

/// What a lease serves: exactly one file (under the grant that named it), or the project's web assets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PageScope {
    File { grant_token: Option<String> },
    Project,
}

#[derive(Clone, Debug)]
pub struct Lease {
    pub root: PathBuf,
    pub page: PathBuf,
    pub scope: PageScope,
    /// The window that opened the page; closing it revokes the lease.
    pub owner_id: Option<String>,
    pub expires_at: Instant,
}

struct Slot {
    lease: Lease,
    /// Order of the last successful request (or of the insert).
    used: u64,
}

#[derive(Default)]
struct Table {
    slots: HashMap<String, Slot>,
    clock: u64,
}

#[derive(Default)]
pub struct Leases {
    table: Mutex<Table>,
}

impl Leases {
    pub fn new() -> Self {
        Self::default()
    }

    fn table(&self) -> std::sync::MutexGuard<'_, Table> {
        self.table.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Stores `lease` under a new token (24 random bytes, base64url). Expired leases go first; then, while the table is full, the least
    /// recently used one.
    pub fn insert(&self, lease: Lease) -> String {
        let mut bytes = [0u8; 24];
        bytes[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        bytes[16..].copy_from_slice(&uuid::Uuid::new_v4().as_bytes()[..8]);
        let token = URL_SAFE_NO_PAD.encode(bytes);
        let now = Instant::now();
        let mut table = self.table();
        table.slots.retain(|_, slot| now < slot.lease.expires_at);
        while table.slots.len() >= MAX_LOCAL_PAGE_LEASES {
            let Some(oldest) = table.slots.iter().min_by_key(|(_, slot)| slot.used).map(|(key, _)| key.clone()) else { break };
            table.slots.remove(&oldest);
        }
        table.clock += 1;
        let used = table.clock;
        table.slots.insert(token.clone(), Slot { lease, used });
        token
    }

    /// The lease of `token` while it has not expired; an expired one is dropped.
    pub fn active(&self, token: &str, now: Instant) -> Option<Lease> {
        let mut table = self.table();
        match table.slots.get(token) {
            Some(slot) if now < slot.lease.expires_at => Some(slot.lease.clone()),
            Some(_) => {
                table.slots.remove(token);
                None
            }
            None => None,
        }
    }

    /// A successful request: the lease is now the most recently used. Its lifetime is not extended; a bad path or a failed
    /// authorization never calls this.
    pub fn touch(&self, token: &str) {
        let mut table = self.table();
        table.clock += 1;
        let used = table.clock;
        if let Some(slot) = table.slots.get_mut(token) {
            slot.used = used;
        }
    }

    pub fn revoke(&self, token: &str) {
        self.table().slots.remove(token);
    }

    /// A closed window leaves no usable preview URL behind.
    pub fn revoke_owner(&self, owner_id: &str) {
        self.table().slots.retain(|_, slot| slot.lease.owner_id.as_deref() != Some(owner_id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lease(owner: Option<&str>, lives: Duration) -> Lease {
        Lease {
            root: PathBuf::from("/p"),
            page: PathBuf::from("/p/index.html"),
            scope: PageScope::Project,
            owner_id: owner.map(str::to_string),
            expires_at: Instant::now() + lives,
        }
    }

    #[test]
    fn tokens_are_24_random_bytes_in_base64url() {
        let leases = Leases::new();
        let a = leases.insert(lease(None, LOCAL_PAGE_TTL));
        let b = leases.insert(lease(None, LOCAL_PAGE_TTL));
        assert_ne!(a, b);
        assert_eq!(a.len(), 32);
        assert!(a.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'));
    }

    #[test]
    fn touch_does_not_renew_the_lifetime() {
        let leases = Leases::new();
        let token = leases.insert(lease(None, Duration::from_secs(10)));
        let now = Instant::now();
        assert!(leases.active(&token, now).is_some());
        leases.touch(&token);
        assert!(leases.active(&token, now + Duration::from_secs(11)).is_none());
        // The expired lease was dropped, so it is gone even for an earlier clock.
        assert!(leases.active(&token, now).is_none());
    }

    #[test]
    fn full_table_drops_the_least_recently_successful_lease() {
        let leases = Leases::new();
        let tokens: Vec<String> = (0..MAX_LOCAL_PAGE_LEASES).map(|_| leases.insert(lease(None, LOCAL_PAGE_TTL))).collect();
        // The oldest insert is kept warm by a successful request; the second oldest is now the least recently used.
        leases.touch(&tokens[0]);
        let newest = leases.insert(lease(None, LOCAL_PAGE_TTL));
        let now = Instant::now();
        assert!(leases.active(&tokens[0], now).is_some());
        assert!(leases.active(&tokens[1], now).is_none());
        assert!(leases.active(&newest, now).is_some());
        assert!(tokens[2..].iter().all(|token| leases.active(token, now).is_some()));
    }

    #[test]
    fn a_lookup_is_not_a_touch() {
        let leases = Leases::new();
        let tokens: Vec<String> = (0..MAX_LOCAL_PAGE_LEASES).map(|_| leases.insert(lease(None, LOCAL_PAGE_TTL))).collect();
        // A lookup (a request that failed) is not a touch.
        assert!(leases.active(&tokens[0], Instant::now()).is_some());
        leases.insert(lease(None, LOCAL_PAGE_TTL));
        assert!(leases.active(&tokens[0], Instant::now()).is_none());
    }

    #[test]
    fn revoke_and_revoke_owner() {
        let leases = Leases::new();
        let a = leases.insert(lease(Some("w1"), LOCAL_PAGE_TTL));
        let b = leases.insert(lease(Some("w2"), LOCAL_PAGE_TTL));
        let c = leases.insert(lease(Some("w1"), LOCAL_PAGE_TTL));
        leases.revoke_owner("w1");
        let now = Instant::now();
        assert!(leases.active(&a, now).is_none());
        assert!(leases.active(&c, now).is_none());
        assert!(leases.active(&b, now).is_some());
        leases.revoke(&b);
        assert!(leases.active(&b, now).is_none());
    }
}
