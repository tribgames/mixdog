//! A one-shot reply from a dedicated thread to an async caller, on `std` alone (the ledger
//! takes no async runtime of its own): the thread sends once, the caller awaits it. A thread
//! that drops its sender without replying (it stopped) resolves the caller `Stopped`.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::task::Context;
use std::task::Poll;
use std::task::Waker;

use crate::error::LedgerError;
use crate::error::Result;

struct Slot<T> {
    value: Option<T>,
    waker: Option<Waker>,
    sender_gone: bool,
}

pub(crate) struct ReplyTx<T>(Arc<Mutex<Slot<T>>>);

pub(crate) struct ReplyRx<T>(Arc<Mutex<Slot<T>>>);

pub(crate) fn reply<T>() -> (ReplyTx<T>, ReplyRx<T>) {
    let slot = Arc::new(Mutex::new(Slot {
        value: None,
        waker: None,
        sender_gone: false,
    }));
    (ReplyTx(slot.clone()), ReplyRx(slot))
}

fn lock<T>(slot: &Mutex<Slot<T>>) -> std::sync::MutexGuard<'_, Slot<T>> {
    slot.lock().unwrap_or_else(|p| p.into_inner())
}

impl<T> ReplyTx<T> {
    pub(crate) fn send(self, value: T) {
        let waker = {
            let mut slot = lock(&self.0);
            slot.value = Some(value);
            slot.waker.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
    }
}

impl<T> Drop for ReplyTx<T> {
    fn drop(&mut self) {
        let waker = {
            let mut slot = lock(&self.0);
            slot.sender_gone = true;
            slot.waker.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
    }
}

impl<T> Future for ReplyRx<T> {
    type Output = Result<T>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let mut slot = lock(&self.0);
        if let Some(value) = slot.value.take() {
            Poll::Ready(Ok(value))
        } else if slot.sender_gone {
            Poll::Ready(Err(LedgerError::Stopped))
        } else {
            slot.waker = Some(cx.waker().clone());
            Poll::Pending
        }
    }
}
