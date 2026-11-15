//! The session store as the application calls it: [`AppStore`], and [`SessionStoreIo`], the one implementation over
//! `mixdog_session_view::store::SessionStore`. The application's calls are blocking (the pickers and the slash dispatch are
//! written over [`crate::app::AppCtx::store_call`]); the store itself is asynchronous, so the adapter runs each call on the
//! tokio runtime that owns the store's connection, from the thread that runs the event loop.

use std::sync::Arc;

use mixdog_session_view::store::SessionStore;
use serde_json::Value;
use tokio::runtime::Handle;

/// What the application needs of the session store (the members of `tui-store-calls.json` it reaches).
pub trait AppStore {
    /// `store.<action>(...args)`: the answer, or the rejection text. `args` are the positional arguments.
    fn call(&mut self, action: &str, args: &[Value]) -> Result<Value, String>;
    /// Whether the store serves the action `name` (`typeof store[name] === 'function'`).
    fn has_method(&self, name: &str) -> bool;
    /// The last published state.
    fn state(&self) -> Arc<Value>;
    /// One terminal frame: publishes the state when anything changed since the last one; whether one was published.
    fn tick(&mut self) -> bool;
    /// `store.pushNotice(text, level)`.
    fn push_notice(&mut self, text: &str, level: &str);
    /// `store.submit(prompt, options)` / `submitAsync`: whether the prompt was taken (`false`: it had no words).
    fn submit(&mut self, prompt: &Value, options: &Value) -> Result<bool, String>;
    /// `store.abort(options)`.
    fn abort(&mut self, options: &Value) -> Result<Value, String>;
    /// `store.restoreQueued(currentText)`.
    fn restore_queued(&mut self, current_text: &str) -> Result<Value, String>;
    /// `store.resolveToolApproval(id, decision)`: whether the approval was found.
    fn resolve_tool_approval(&mut self, id: &str, decision: &Value) -> Result<bool, String>;
    /// `resolveOnboardingVerdict(store)`: whether first-run setup is done; an unreadable status counts as done.
    fn onboarding_completed(&mut self) -> bool;
    /// Unsubscribes and closes, waiting at most the exit wait; whether it finished in time.
    fn dispose(&mut self, reason: &str) -> bool;
}

/// The store over a connected [`SessionStore`] and the runtime that serves its connection.
pub struct SessionStoreIo {
    store: Arc<SessionStore>,
    runtime: Handle,
}

impl SessionStoreIo {
    pub fn new(store: Arc<SessionStore>, runtime: Handle) -> Self {
        Self { store, runtime }
    }

    /// The session store itself (the run loop subscribes to its events).
    pub fn store(&self) -> &Arc<SessionStore> {
        &self.store
    }
}

impl AppStore for SessionStoreIo {
    fn call(&mut self, action: &str, args: &[Value]) -> Result<Value, String> {
        self.runtime.block_on(self.store.call(action, args)).map_err(|error| error.to_string())
    }

    fn has_method(&self, name: &str) -> bool {
        // A name the router has no row for may still be a published section or a method of its own shape (`target_of`);
        // the call itself answers an action that is truly unknown.
        let _ = name;
        true
    }

    fn state(&self) -> Arc<Value> {
        self.store.state()
    }

    fn tick(&mut self) -> bool {
        self.store.tick()
    }

    fn push_notice(&mut self, text: &str, level: &str) {
        self.store.push_notice(text, level);
    }

    fn submit(&mut self, prompt: &Value, options: &Value) -> Result<bool, String> {
        self.runtime
            .block_on(self.store.submit(prompt, options))
            .map(|submitted| submitted.is_some())
            .map_err(|error| error.to_string())
    }

    fn abort(&mut self, options: &Value) -> Result<Value, String> {
        self.runtime.block_on(self.store.abort(options)).map_err(|error| error.to_string())
    }

    fn restore_queued(&mut self, current_text: &str) -> Result<Value, String> {
        self.runtime.block_on(self.store.restore_queued(current_text, None)).map_err(|error| error.to_string())
    }

    fn resolve_tool_approval(&mut self, id: &str, decision: &Value) -> Result<bool, String> {
        self.runtime.block_on(self.store.resolve_tool_approval(id, decision)).map_err(|error| error.to_string())
    }

    fn onboarding_completed(&mut self) -> bool {
        self.runtime.block_on(self.store.onboarding_completed())
    }

    fn dispose(&mut self, reason: &str) -> bool {
        self.runtime.block_on(self.store.dispose(reason))
    }
}
