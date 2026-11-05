//! The order of the file-system calls a write makes, recorded in tests so the Node golden's
//! sequence can be compared. Compiled out of every other build.

#[cfg(test)]
thread_local! {
    static TRACE: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

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
