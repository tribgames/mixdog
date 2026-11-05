//! Mid-conversation reasoning-effort updates on the Responses wire. The
//! session owns the per-message effort snapshots; the wire needs only the
//! conversation's initial effort and, by message index, where the effort
//! changed.

use std::collections::BTreeMap;

/// Effort in wire values: `initial_effort` goes in the request's `reasoning`,
/// each entry of `updates` becomes a `configuration_update` item.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct EffortProjection {
    pub initial_effort: String,
    /// Message index to the effort that takes effect there. An update on a
    /// tool result applies after its whole tool batch.
    pub updates: BTreeMap<usize, String>,
}

impl EffortProjection {
    /// Maps a session projection (`initial`, then `changes` in transcript
    /// order, in the session's own effort names) onto the route's wire
    /// values. Consecutive changes that share a wire value collapse into none.
    /// `None` when any effort has no wire value on this route: the request
    /// then carries its per-request effort alone.
    pub fn from_session(
        initial: &str,
        changes: impl IntoIterator<Item = (usize, String)>,
        wire: &dyn Fn(&str) -> Option<String>,
    ) -> Option<Self> {
        let initial_effort = wire(initial)?;
        let mut current = initial_effort.clone();
        let mut updates = BTreeMap::new();
        for (index, effort) in changes {
            let value = wire(&effort)?;
            if value != current {
                current.clone_from(&value);
                updates.insert(index, value);
            }
        }
        Some(Self { initial_effort, updates })
    }
}
