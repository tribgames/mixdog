//! The methods a worker serves.

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;

use crate::ctx::CallCtx;
use crate::error::CodedError;

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// What a handler answers: the call's value, and whether this worker now holds state for the call's thread (the pool then keeps
/// sending that thread's calls here).
#[derive(Debug, PartialEq)]
pub struct Outcome {
    pub value: Value,
    pub pin: bool,
}

impl Outcome {
    pub fn value(value: Value) -> Self {
        Self { value, pin: false }
    }

    pub fn pinned(value: Value) -> Self {
        Self { value, pin: true }
    }
}

pub type HandlerResult = Result<Outcome, CodedError>;
pub(crate) type Handler = Arc<dyn Fn(CallCtx) -> BoxFuture<HandlerResult> + Send + Sync>;
pub(crate) type ExitHook = Box<dyn Fn() -> BoxFuture<()> + Send + Sync>;

#[derive(Default)]
pub struct Registry {
    handlers: BTreeMap<String, Handler>,
    on_exit: Option<ExitHook>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Serves `name` with an async handler. The handler runs as its own task: a panic in it is answered as code `failed`.
    pub fn register<F, Fut>(&mut self, name: &str, handler: F)
    where
        F: Fn(CallCtx) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = HandlerResult> + Send + 'static,
    {
        self.handlers.insert(
            name.to_owned(),
            Arc::new(move |ctx| -> BoxFuture<HandlerResult> { Box::pin(handler(ctx)) }),
        );
    }

    /// Serves `name` with CPU-bound code. It runs on its own thread, so the frame loop keeps reading (a cancel, a bye) while it
    /// works, and it polls `ctx.cancel` to stop early; one that never looks keeps its thread until the process ends. A panic in
    /// it is answered as code `failed`.
    pub fn register_blocking<F>(&mut self, name: &str, handler: F)
    where
        F: Fn(CallCtx) -> HandlerResult + Send + Sync + 'static,
    {
        let handler = Arc::new(handler);
        self.register(name, move |ctx| {
            let handler = handler.clone();
            async move {
                let (done, answer) = tokio::sync::oneshot::channel();
                let spawned = std::thread::Builder::new()
                    .name("ext-worker-blocking".to_owned())
                    .spawn(move || {
                        let outcome =
                            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                (*handler)(ctx)
                            }));
                        let _ = done.send(outcome.unwrap_or_else(|payload| {
                            Err(CodedError::failed(panic_text(&*payload)))
                        }));
                    });
                if let Err(error) = spawned {
                    return Err(CodedError::failed(format!(
                        "cannot start a thread: {error}"
                    )));
                }
                answer.await.unwrap_or_else(|_| {
                    Err(CodedError::failed(
                        "the handler's thread ended without an answer",
                    ))
                })
            }
        });
    }

    /// Runs when the worker leaves (a bye, the end of the pipe, a protocol error), and is awaited before the process exits: the
    /// place for a handler's state to give back what it owns (the office applications of its sessions).
    pub fn on_exit<F, Fut>(&mut self, hook: F)
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        self.on_exit = Some(Box::new(move || -> BoxFuture<()> { Box::pin(hook()) }));
    }

    /// The names served, sorted.
    pub fn methods(&self) -> Vec<&str> {
        self.handlers.keys().map(String::as_str).collect()
    }

    pub(crate) fn handler(&self, name: &str) -> Option<Handler> {
        self.handlers.get(name).cloned()
    }

    pub(crate) async fn run_exit_hook(&self) {
        if let Some(hook) = &self.on_exit {
            hook().await;
        }
    }
}

/// The text of a panic payload.
pub(crate) fn panic_text(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(text) = payload.downcast_ref::<&str>() {
        (*text).to_owned()
    } else if let Some(text) = payload.downcast_ref::<String>() {
        text.clone()
    } else {
        "the handler panicked".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_what_was_registered_sorted() {
        let mut registry = Registry::new();
        registry.register("b", |_| async { Ok(Outcome::value(Value::Null)) });
        registry.register_blocking("a", |_| Ok(Outcome::pinned(Value::Null)));
        assert_eq!(registry.methods(), vec!["a", "b"]);
        assert!(registry.handler("a").is_some());
        assert!(registry.handler("c").is_none());
    }

    #[test]
    fn a_panic_payload_is_read_as_text() {
        assert_eq!(panic_text(&*Box::new("str")), "str");
        assert_eq!(panic_text(&*Box::new(String::from("owned"))), "owned");
        assert_eq!(panic_text(&*Box::new(5u8)), "the handler panicked");
    }
}
