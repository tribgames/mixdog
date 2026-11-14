//! The thread reducer: `thread/snapshot` and the thread feed notifications folded into the session state (the fold of
//! `packages/protocol-client/src/session-state.ts`). The fold itself is the reducer task's; until it lands the reducer keeps the
//! snapshot as the state, which is what the client library does without a reducer.

use mixdog_app_protocol::JsonRpcNotification;
use mixdog_app_server_client::{Json, ThreadReducer};

#[derive(Debug, Default, Clone, Copy)]
pub struct SessionReducer;

impl ThreadReducer for SessionReducer {
    fn initial(&self, snapshot: &Json) -> Json {
        snapshot.clone()
    }

    fn apply(&self, state: &Json, _notification: &JsonRpcNotification) -> Json {
        state.clone()
    }
}
