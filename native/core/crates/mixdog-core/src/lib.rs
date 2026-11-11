pub mod run_host;

/// What the replays in `crates/mixdog-core-replays` reach that no `pub` path offers: items declared `pub` in modules
/// that stay private to the crate, re-exported here only. Absent from every build without `test-support`, which
/// build.rs refuses in a release build.
#[cfg(feature = "test-support")]
pub mod replay_access {
    /// The turn reminder pieces (`run_host::turn_reminders`) the reminder replay checks one by one.
    pub mod turn_reminders {
        pub mod clock {
            pub use crate::run_host::turn_reminders::clock::{block, prompt_content_text};
        }
        pub mod deferred {
            pub use crate::run_host::turn_reminders::deferred::notice;
        }
        pub mod listing {
            pub use crate::run_host::turn_reminders::listing::notice;
        }
    }
}

