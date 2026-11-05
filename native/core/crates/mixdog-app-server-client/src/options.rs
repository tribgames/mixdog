//! Production defaults for `ConnectOptions`: the wall clock for the reconnect ladder and a ready-made constructor.

use std::{sync::Arc, time::Duration};

use async_trait::async_trait;

use crate::api::{
    ClientInfo, Clock, ConnectOptions, Connector, DEFAULT_LADDER, InitializeCapabilities, Target,
};

/// Real time and real randomness for the ladder (SPEC H17: 250 ms → 5 s, full jitter).
pub struct SystemClock;

#[async_trait]
impl Clock for SystemClock {
    async fn sleep(&self, ms: u64) {
        tokio::time::sleep(Duration::from_millis(ms)).await;
    }
    fn jitter(&self) -> f64 {
        rand::random::<f64>()
    }
}

impl ConnectOptions {
    /// The default client: no thread reducer, default capabilities, wall clock, UUIDv7 op ids, the SPEC ladder.
    pub fn new(target: Target, connector: Arc<dyn Connector>, client_info: ClientInfo) -> Self {
        Self {
            target,
            connector,
            client_info,
            capabilities: InitializeCapabilities::default(),
            thread_reducer: None,
            clock: Arc::new(SystemClock),
            new_op_id: None,
            ladder: DEFAULT_LADDER,
        }
    }
}
