//! The computer helper a secret is typed through. The secret store itself (each request id's
//! one-shot value slot, the window and field a request was bound to, the values filled for a
//! session and their redaction) and the fill of a bound field are one thing, in
//! `mixdog-core-session` `session/secret_input` (`SecretSlots`, `SecretFill`); this crate only
//! names the helper they type through.

use async_trait::async_trait;
use serde_json::Map;
use serde_json::Value;

/// The computer helper a secret is typed through (the bridge's `executeSerialized`).
#[async_trait]
pub trait ComputerSecretHost: Send + Sync {
    /// One helper command, run to its reply; `Err` is the helper's error text.
    async fn execute(&self, command: Map<String, Value>) -> Result<Map<String, Value>, String>;
    /// A secret field may now hold focus: captures are withheld until focus moves.
    fn arm_focus(&self);
}