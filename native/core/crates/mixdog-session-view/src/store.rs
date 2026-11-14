//! The session store a terminal UI drives: the state it reads, the events it hears, the calls it makes. The connection to the
//! core, the fold and the intake rules are the store task's; until it lands a store cannot be connected, and a call is routed (the
//! action becomes its protocol request) and then reports that there is no connection.

use std::sync::Arc;

use serde_json::Value;
use tokio::sync::broadcast;

use crate::action_route::{Resolved, RouteContext, RouteError, resolve_action};
use crate::connect::connect_core;

/// How the session is opened: the options the Node UI gave its `createSession`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StoreOptions {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub tool_mode: Option<String>,
    pub remote: bool,
    pub worktree: Option<Value>,
    pub cwd: Option<String>,
}

/// What a store tells its subscribers.
#[derive(Debug, Clone, PartialEq)]
pub enum StoreEvent {
    State(Arc<Value>),
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum StoreError {
    #[error("the session store is not connected to a core")]
    NotConnected,
    #[error(transparent)]
    Route(#[from] RouteError),
}

pub struct SessionStore {
    state: Arc<Value>,
    thread_id: Option<String>,
    events: broadcast::Sender<StoreEvent>,
}

impl SessionStore {
    /// Connects to the core and opens the session.
    pub async fn connect(options: StoreOptions) -> Result<Self, StoreError> {
        connect_core(options).await
    }

    /// The projected state the UI reads.
    pub fn state(&self) -> Arc<Value> {
        Arc::clone(&self.state)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<StoreEvent> {
        self.events.subscribe()
    }

    /// The protocol request a session action is for the session this store is bound to.
    pub fn route(&self, action: &str, args: &[Value]) -> Result<Resolved, RouteError> {
        resolve_action(
            action,
            args,
            &RouteContext {
                thread_id: self.thread_id.as_deref(),
            },
        )
    }

    /// Calls a session action.
    pub async fn call(&self, action: &str, args: &[Value]) -> Result<Value, StoreError> {
        self.route(action, args)?;
        Err(StoreError::NotConnected)
    }

    /// Answers the pending tool approval `request_id`.
    pub async fn respond_approval(
        &self,
        _request_id: &str,
        _allow: bool,
    ) -> Result<(), StoreError> {
        Err(StoreError::NotConnected)
    }

    /// Unsubscribes and closes.
    pub async fn dispose(&self, _reason: &str) {}
}
