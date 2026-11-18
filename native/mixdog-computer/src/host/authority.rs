//! The helper's control path of its automation scope (the scope itself is `crate::port::Scope`): the core's revocation line on stdin
//! and the acknowledgements on stdout. The first is written as soon as admission is closed (its own word, and every fenced
//! elevated worker's word): it never waits for a provider, a foreign window, a worker or a compensation, and says the cleanup is
//! pending. Each later one (`Report::json`, same marker) follows a change: the receipts let go of, a pending hold compensated, a
//! handed-over call finished, a worker ended. The closure snapshot in all of them is the first one.

use crate::port::Scope;
use crate::protocol::write_line;

/// The core's revocation line on stdin, and the helper's acknowledgement on stdout.
pub(crate) const REVOKE_LINE: &str = "@@MIXDOG_REVOKE@@";
pub(crate) const REVOKED_MARKER: &str = "@@MIXDOG_REVOKED@@";

/// Revokes `scope` and acknowledges the closure, then lets go of what the scope's ports still hold (owned releases only) and
/// acknowledges the cleanup, and every later change of it.
pub(crate) fn revoke_and_acknowledge(scope: &Scope) {
    scope.revoke();
    write_line(REVOKED_MARKER, &scope.report().json());
    scope.on_report(|report| write_line(REVOKED_MARKER, &report.json()));
    scope.release_held();
    write_line(REVOKED_MARKER, &scope.report().json());
}
