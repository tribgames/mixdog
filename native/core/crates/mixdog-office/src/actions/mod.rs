pub mod finalize;
pub mod lifecycle;
pub mod qa;

use std::future::Future;
use std::path::Path;

use mixdog_fsio::WriteProof;
use mixdog_office_base::write_note::WriteNote;
use mixdog_office_com::{CloseOptions, OfficeCom};
use mixdog_office_design::library::{Context, Environment, iso_string};
use mixdog_office_quality::design_review::AuthorReads;
use mixdog_rt::CancellationToken;
use serde_json::Value;

use crate::author::SystemAuthor;
use crate::batch::{BatchContext, BatchHost};
use crate::inspect::InspectContext;
use crate::render::RenderEngine;
use crate::session::SessionHandle;
use crate::session::create::CreateTools;
use crate::session::mode::OfficeHost;
use crate::session::open::SessionCloser;
use crate::session::registry::Registry;
use crate::snapshot::ComHost;

/// What closing a live Microsoft Office session asks of the Office host (`closeMicrosoftOfficeSession(id, { save, signal })`): the
/// host's answer as JSON, its failures in the same shape (`ok`, `reaped`, `cleanup`, `error`).
pub trait ComSessions {
    fn close_session(&self, id: &str, save: bool, cancel: Option<&CancellationToken>) -> impl Future<Output = Value>;
}

impl ComSessions for OfficeCom {
    async fn close_session(&self, id: &str, save: bool, cancel: Option<&CancellationToken>) -> Value {
        let options = CloseOptions { save, cancel: cancel.cloned().unwrap_or_default(), ..CloseOptions::default() };
        OfficeCom::close_session(self, id, options).await
    }
}

/// The Microsoft Office host as the actions see it: detection and opening, the calls of a session, and its close.
pub trait Host: OfficeHost + ComHost + ComSessions {}

impl<T: OfficeHost + ComHost + ComSessions> Host for T {}

/// What one call of the Office tool runs with.
pub struct Machine<'a, P: WriteProof, H: Host, C: SessionCloser, R: RenderEngine, B: BatchHost> {
    /// The sessions, the render, the inspection and the Office host of the call, and the author action's own machine.
    pub author: &'a SystemAuthor<'a, P, H, C, R>,
    /// The batch (and, through it, the transactions) of the call.
    pub batch: &'a BatchContext<'a, P, H, B>,
    /// What a create writes a PDF with.
    pub tools: &'a CreateTools<'a, C>,
    /// What a deck's design review reads of the authoring side.
    pub reads: &'a dyn AuthorReads,
}

impl<'a, P: WriteProof, H: Host, C: SessionCloser, R: RenderEngine, B: BatchHost> Machine<'a, P, H, C, R, B> {
    pub(crate) fn inspect(&self) -> &'a InspectContext<'a, P, H> {
        self.author.inspect
    }

    pub(crate) fn engine(&self) -> &'a R {
        self.author.render
    }

    pub(crate) fn registry(&self) -> &'a Registry {
        self.author.env.registry
    }

    pub(crate) fn design(&self) -> &'a Context<'a, P> {
        self.author.env.design
    }

    pub(crate) fn environment(&self) -> &'a Environment {
        self.author.env.design.env
    }

    pub(crate) fn note(&self) -> &'a dyn WriteNote {
        self.author.env.note
    }

    pub(crate) fn host(&self) -> &'a H {
        self.author.env.host
    }

    pub(crate) fn data_dir(&self) -> &'a Path {
        self.author.env.data_dir
    }

    /// `new Date().toISOString()` of the call's clock.
    pub(crate) fn now_iso(&self) -> String {
        iso_string((self.environment().now_ms)())
    }

    /// Takes a closed session out of what the engine remembers of it: its read for review and what it was last sent.
    pub(crate) fn forget(&self, handle: &SessionHandle) {
        let id = crate::session::registry::lock(handle).id.clone();
        self.inspect().reviews.forget(&id);
        self.author.deliveries.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&id);
    }
}
