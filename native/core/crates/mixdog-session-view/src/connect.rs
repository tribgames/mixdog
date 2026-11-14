//! The connection of a session store to a core the caller has ensured (`mixdog_launch::ensure_core` is the caller's: this crate
//! does not depend on it).

use crate::store::{SessionStore, StoreError, StoreOptions};

/// Connects to the running core and opens the session `options` describe.
pub async fn connect_core(_options: StoreOptions) -> Result<SessionStore, StoreError> {
    Err(StoreError::NotConnected)
}
