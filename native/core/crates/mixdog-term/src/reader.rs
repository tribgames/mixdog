//! The input reader: a thread that turns terminal reads and resizes into events. Filled in by the console task.

use std::sync::mpsc::Sender;

/// What the reader reports.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TermEvent {
    Bytes(Vec<u8>),
    Resize(u16, u16),
}

/// Handle of a running reader.
#[derive(Debug)]
pub struct ReaderHandle;

pub fn spawn_reader(_tx: Sender<TermEvent>) -> ReaderHandle {
    ReaderHandle
}
