use std::sync::atomic::{AtomicU64, Ordering};

pub(crate) struct InventoryLease {
    until_ms: AtomicU64,
}

impl InventoryLease {
    pub(crate) fn new(now_ms: u64, lease_ms: u64) -> Self {
        Self {
            until_ms: AtomicU64::new(now_ms.saturating_add(lease_ms)),
        }
    }

    pub(crate) fn extend(&self, now_ms: u64, lease_ms: u64) {
        if lease_ms == 0 {
            return;
        }
        self.until_ms
            .fetch_max(now_ms.saturating_add(lease_ms), Ordering::AcqRel);
    }

    pub(crate) fn active(&self, now_ms: u64) -> bool {
        self.until_ms.load(Ordering::Acquire) > now_ms
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inventory_lease_expires_and_can_be_extended() {
        let lease = InventoryLease::new(100, 50);
        assert!(lease.active(149));
        assert!(!lease.active(150));
        lease.extend(150, 25);
        assert!(lease.active(174));
        assert!(!lease.active(175));
    }
}
