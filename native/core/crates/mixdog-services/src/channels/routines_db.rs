//! Every routine (schedule and webhook) one bot owns, deleted as its bot is deleted
//! (routines-db.mjs `deleteRoutinesOwnedBy`). One state transaction over both stores, keyed by
//! the rows' current owner: it removes all of them with their run state and the webhooks'
//! delivery logs, or — failing — none; a row moved to another bot is never matched.

use mixdog_store::sqlite::DbError;
use mixdog_store::state::CoreState;

use crate::scheduler::durable::KEY_PREFIX as SCHEDULE_PREFIX;
use crate::scheduler::model::Schedule;
use crate::webhooks::records::{DELIVERY_PREFIX, ENDPOINT_PREFIX, EndpointRecord};

/// The names removed, each list sorted.
#[derive(Debug, PartialEq, Eq)]
pub struct Removed {
    pub schedules: Vec<String>,
    pub webhooks: Vec<String>,
}

pub struct OwnedRoutines {
    state: CoreState,
}

fn unreadable(what: &str, key: &str, error: serde_json::Error) -> DbError {
    DbError::Write(format!("{what} \"{key}\" is unreadable: {error}"))
}

impl OwnedRoutines {
    pub fn new(state: CoreState) -> Self {
        Self { state }
    }

    pub async fn delete_owned_by(&self, owner: &str) -> Result<Removed, String> {
        let owner = owner.to_owned();
        self.state
            .write(move |tx| {
                let mut schedules = Vec::new();
                for (key, text) in tx.meta_prefix(SCHEDULE_PREFIX)? {
                    let row: Schedule = serde_json::from_str(&text).map_err(|e| unreadable("schedule", &key[SCHEDULE_PREFIX.len()..], e))?;
                    if row.owner_agent_id == owner {
                        tx.delete_meta(&key)?;
                        schedules.push(row.name);
                    }
                }
                let mut webhooks = Vec::new();
                for (key, text) in tx.meta_prefix(ENDPOINT_PREFIX)? {
                    let row: EndpointRecord = serde_json::from_str(&text).map_err(|e| unreadable("webhook", &key[ENDPOINT_PREFIX.len()..], e))?;
                    if row.owner_agent_id == owner {
                        tx.delete_meta_prefix(&format!("{DELIVERY_PREFIX}{}:", row.name))?;
                        tx.delete_meta(&key)?;
                        webhooks.push(row.name);
                    }
                }
                schedules.sort();
                webhooks.sort();
                Ok(Removed { schedules, webhooks })
            })
            .await
            .map_err(|error| format!("routine store: {error}"))
    }
}
