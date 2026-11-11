//! The random bytes the providers mint ids from (recovered tool-call ids, Antigravity request and session ids).
//!
//! A development-only seam, inert unless a test scripts it: [`script`] queues the draws a recording made, in order,
//! so a replay mints the ids Node drew. Without a script every draw is `rand::random`.

/// `N` random bytes: the next scripted draw when a test queued one, else fresh.
pub(crate) fn bytes<const N: usize>() -> [u8; N] {
    #[cfg(any(test, feature = "test-support"))]
    if let Some(draw) = scripted::next() {
        return draw.try_into().unwrap_or_else(|draw: Vec<u8>| panic!("a scripted draw of {} bytes where {N} were drawn", draw.len()));
    }
    rand::random()
}

#[cfg(any(test, feature = "test-support"))]
mod scripted {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    pub(super) static NEXT: Mutex<VecDeque<Vec<u8>>> = Mutex::new(VecDeque::new());

    pub(super) fn next() -> Option<Vec<u8>> {
        NEXT.lock().unwrap_or_else(std::sync::PoisonError::into_inner).pop_front()
    }
}

/// Replaces the queued draws with `draws`, in drawing order; an empty list puts back fresh randomness.
#[cfg(any(test, feature = "test-support"))]
pub fn script(draws: impl IntoIterator<Item = Vec<u8>>) {
    *scripted::NEXT.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = draws.into_iter().collect();
}
