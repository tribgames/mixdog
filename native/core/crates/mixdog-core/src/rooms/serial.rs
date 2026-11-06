//! Per-key async serialization: work for one key runs one at a time in arrival order; different
//! keys never wait on each other.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

#[allow(clippy::disallowed_types, reason = "one key's turn is held across its caller's awaits on purpose: per-key serialization is this type's contract")]
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

#[derive(Default)]
#[allow(clippy::disallowed_types, reason = "one key's turn is held across its caller's awaits on purpose: per-key serialization is this type's contract")]
pub struct KeyedSerial {
    // Weak entries: a key nobody holds or waits on is forgotten.
    locks: Mutex<HashMap<String, Weak<AsyncMutex<()>>>>,
}

impl KeyedSerial {
    pub fn new() -> Self {
        Self::default()
    }

    /// Wait for `key`'s turn; the returned guard ends it.
    #[allow(clippy::disallowed_types, reason = "one key's turn is held across its caller's awaits on purpose: per-key serialization is this type's contract")]
    pub async fn lock(&self, key: &str) -> OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self.locks.lock().unwrap_or_else(|e| e.into_inner());
            match locks.get(key).and_then(Weak::upgrade) {
                Some(lock) => lock,
                None => {
                    locks.retain(|_, weak| weak.strong_count() > 0);
                    let lock = Arc::new(AsyncMutex::new(()));
                    locks.insert(key.to_owned(), Arc::downgrade(&lock));
                    lock
                }
            }
        };
        lock.lock_owned().await
    }

    #[cfg(test)]
    fn tracked(&self) -> usize {
        self.locks.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[tokio::test]
    async fn one_key_is_serial_another_key_does_not_wait() {
        let serial = Arc::new(KeyedSerial::new());
        let held = serial.lock("a").await;
        // A different key is free while "a" is held.
        let _b = tokio::time::timeout(Duration::from_secs(5), serial.lock("b")).await.expect("b must not wait");
        let waiting = {
            let serial = serial.clone();
            tokio::spawn(async move {
                let _guard = serial.lock("a").await;
            })
        };
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        drop(held);
        waiting.await.unwrap();
    }

    #[tokio::test]
    async fn idle_keys_are_forgotten() {
        let serial = KeyedSerial::new();
        drop(serial.lock("a").await);
        assert_eq!(serial.tracked(), 1);
        drop(serial.lock("b").await);
        assert_eq!(serial.tracked(), 1, "a was forgotten when b arrived");
    }
}
