//! The order of the file-system calls a write makes, recorded in tests so the Node golden's
//! sequence can be compared, and the point where a lock request joins the line of its process
//! (a test cannot otherwise tell that a waiter is queued). Compiled out of every other build.

#[cfg(test)]
thread_local! {
    static TRACE: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
    static QUEUED: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}

/// Runs `hook` once, when this thread's next lock request has taken its ticket in the line.
#[cfg(test)]
pub(crate) fn on_queued(hook: impl FnOnce() + 'static) {
    QUEUED.with(|queued| *queued.borrow_mut() = Some(Box::new(hook)));
}

/// A lock request took its ticket. Runs with the line locked, so its turn cannot pass before
/// the request has looked at its place.
#[cfg(test)]
pub(crate) fn queued() {
    if let Some(hook) = QUEUED.with(|queued| queued.borrow_mut().take()) {
        hook();
    }
}

#[cfg(not(test))]
pub(crate) fn queued() {}

/// One call: `op` and the file names it touched (names only, never directories).
#[cfg(test)]
pub(crate) fn record(op: &str, paths: &[&std::path::Path]) {
    let mut entry = op.to_owned();
    for path in paths {
        entry.push(' ');
        entry.push_str(&path.file_name().unwrap_or_default().to_string_lossy());
    }
    TRACE.with(|trace| trace.borrow_mut().push(entry));
}

#[cfg(not(test))]
pub(crate) fn record(_op: &str, _paths: &[&std::path::Path]) {}

#[cfg(test)]
pub(crate) fn take() -> Vec<String> {
    TRACE.with(|trace| std::mem::take(&mut *trace.borrow_mut()))
}
