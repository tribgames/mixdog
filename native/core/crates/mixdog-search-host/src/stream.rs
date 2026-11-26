//! A stream as the core's consumer holds it: the items its helper sends, in order. Taking one tells the helper, which gives
//! its room in the engine's queue back; `close` waits for the helper to say nothing of the producer runs; dropping the
//! stream lets go of it.

use std::marker::PhantomData;

use async_trait::async_trait;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::fs::DirEntry;
use mixdog_core_api::domain::fs::FsError;
use mixdog_core_api::domain::fs::FsErrorKind;
use mixdog_core_api::domain::fs::SearchMatch;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::sync::mpsc::UnboundedSender;

use crate::supervisor::Command;
use crate::wire::Found;
use crate::wire::StreamId;

/// What the supervisor tells a stream.
#[derive(Debug)]
pub(crate) enum Event {
    Item(Result<Found, FsError>),
    End,
    /// Nothing of the stream's producer runs: its close is done, or its helper is gone.
    Closed,
}

/// The failure a stream answers when its helper is gone or never started: the one a failed read answers.
pub(crate) fn lost(os_code: Option<i32>) -> FsError {
    FsError::new(FsErrorKind::Io { os_code }, None)
}

/// Settles a stream whose helper cannot answer it: after the failure (unless it had ended), it ends and is closed.
pub(crate) fn settle_lost(sink: &UnboundedSender<Event>, ended: bool, os_code: Option<i32>) {
    if !ended {
        let _ = sink.send(Event::Item(Err(lost(os_code))));
        let _ = sink.send(Event::End);
    }
    let _ = sink.send(Event::Closed);
}

/// The item type of a stream.
pub(crate) trait Yield: Sized + Send + 'static {
    fn of(found: Found) -> Option<Self>;
}

impl Yield for DirEntry {
    fn of(found: Found) -> Option<Self> {
        match found {
            Found::Entry(entry) => Some(entry),
            Found::Match(_) => None,
        }
    }
}

impl Yield for SearchMatch {
    fn of(found: Found) -> Option<Self> {
        match found {
            Found::Match(found) => Some(found),
            Found::Entry(_) => None,
        }
    }
}

pub(crate) struct HostStream<T> {
    id: StreamId,
    commands: UnboundedSender<Command>,
    events: UnboundedReceiver<Event>,
    ended: bool,
    /// [`Event::Closed`] came: the supervisor holds nothing of the stream.
    closed: bool,
    item: PhantomData<fn() -> T>,
}

impl<T> HostStream<T> {
    pub(crate) fn new(id: StreamId, commands: UnboundedSender<Command>, events: UnboundedReceiver<Event>) -> Self {
        Self { id, commands, events, ended: false, closed: false, item: PhantomData }
    }
}

#[async_trait]
impl<T: Yield> EventSource<Result<T, FsError>> for HostStream<T> {
    async fn next(&mut self) -> Option<Result<T, FsError>> {
        if self.ended {
            return None;
        }
        match self.events.recv().await {
            Some(Event::Item(item)) => {
                let _ = self.commands.send(Command::Taken { id: self.id });
                // The supervisor checks an item's kind against its stream's before it passes it on.
                Some(item.and_then(|found| T::of(found).ok_or_else(|| lost(None))))
            }
            Some(Event::End) => {
                self.ended = true;
                None
            }
            Some(Event::Closed) | None => {
                self.ended = true;
                self.closed = true;
                None
            }
        }
    }

    async fn close(&mut self) {
        self.ended = true;
        if self.closed {
            return;
        }
        let _ = self.commands.send(Command::Close { id: self.id });
        while let Some(event) = self.events.recv().await {
            if matches!(event, Event::Closed) {
                break;
            }
        }
        self.closed = true;
    }
}

impl<T> Drop for HostStream<T> {
    fn drop(&mut self) {
        if !self.closed {
            let _ = self.commands.send(Command::Release { id: self.id });
        }
    }
}
