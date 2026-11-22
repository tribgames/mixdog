//! The `catalogIndex` app section: while a rebuild of the session index runs behind the serving core, how far it has come
//! (`{building, done, total}` sessions), so a client says that its session list and search hold only what is indexed so far.
//! Published only by a start that rebuilds; it ends with `building: false`, which a client that connects later reads as done.

use std::sync::Arc;
use std::time::Duration;

use mixdog_core_api::state::StatePublisher;
use mixdog_core_base::state::change_of;
use mixdog_protocol::SectionName;
use mixdog_rt::CancellationToken;
use mixdog_rt::TaskClass;
use mixdog_store::sqlite::SqliteStore;
use serde_json::Value;
use serde_json::json;

/// At most one push per this interval while the rebuild moves: a rebuild of thousands of sessions moves thousands of times.
const PUSH_EVERY: Duration = Duration::from_millis(250);

/// The section's value for the repairs as they stand.
pub fn value_of(index: &SqliteStore) -> Value {
    let report = index.repairs();
    let done = report.repaired + report.failed.len();
    json!({ "building": report.pending > 0 || !report.left.is_empty(), "done": done, "total": report.owed })
}

/// Keeps the section pushed while `index` is being rebuilt; nothing for a start that rebuilds nothing.
pub fn spawn(index: SqliteStore, publisher: Arc<dyn StatePublisher>, cancel: CancellationToken) {
    if !index.rebuilding() {
        return;
    }
    drop(mixdog_rt::spawn("catalog-index-section", TaskClass::Work, async move {
        let mut changes = index.repairs_changed();
        let mut last = Value::Null;
        loop {
            let value = value_of(&index);
            if value != last {
                publisher.publish(SectionName::CatalogIndex, None, change_of(&value));
                last = value;
            }
            if last["building"] == false {
                return;
            }
            tokio::select! {
                () = cancel.cancelled() => return,
                changed = changes.changed() => if changed.is_err() { return },
            }
            tokio::select! {
                () = cancel.cancelled() => return,
                () = mixdog_rt::time::sleep(PUSH_EVERY) => {}
            }
        }
    }));
}
