//! The shared render browser as the Office engine's HTML routes lease it (`installSharedBrowser` and `sharedBrowserProvider` of
//! `src/ext-host/methods.mjs` and `render-browser.mjs`).
//!
//! The worker owns no browser: the pool does, and hands its DevTools endpoint to the call that asks (`NEED_BROWSER`). The engine is
//! one per process while a browser request belongs to one call, so the call that is running puts its context here for as long as
//! it runs, and a lease asks the pool through that context. The pool answers once per call; the authoring CDP client connects to
//! the endpoint, works in a browser context of its own and closes it, so the browser outlives every call.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use mixdog_core_api::domain::ext::BrowserEndpoint;
use mixdog_core_api::domain::ext::BrowserHold;

use crate::ctx::CallCtx;

/// The browser endpoint of the call that is running (the worker runs one call at a time).
#[derive(Default)]
pub(super) struct CallBrowser {
    call: Mutex<Option<Arc<CallCtx>>>,
}

/// Keeps a call as the one a lease asks the pool through; the call leaves when this is dropped.
pub(super) struct Serving<'a>(&'a CallBrowser);

impl CallBrowser {
    pub(super) fn serve(&self, ctx: Arc<CallCtx>) -> Serving<'_> {
        *self.call.lock().unwrap_or_else(PoisonError::into_inner) = Some(ctx);
        Serving(self)
    }
}

impl Drop for Serving<'_> {
    fn drop(&mut self) {
        *self.0.call.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }
}

#[async_trait::async_trait]
impl BrowserEndpoint for CallBrowser {
    /// The pool's endpoint for the running call. A refusal comes back as the pool's own reason (code `browser_unavailable`), as
    /// the Node provider's rejection did. The pool holds the browser open for the length of the call, so the hold is nothing.
    async fn lease(&self) -> Result<(String, BrowserHold), String> {
        let call = self.call.lock().unwrap_or_else(PoisonError::into_inner).clone();
        let Some(call) = call else {
            return Err("no Office call is running to ask the browser for".to_owned());
        };
        let endpoint = call.request_browser().await.map_err(|error| error.message)?;
        Ok((endpoint, Box::new(())))
    }
}
