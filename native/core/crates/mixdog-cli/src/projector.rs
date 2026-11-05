//! The production `IndexProjector` of `mixdogd migrate`: the store's `project_index`, which builds
//! each catalog row with the store's one row builder (the same one as its live upsert).

use std::path::Path;

use mixdog_migrate::index::IndexProjector;
use mixdog_store::sqlite::project_index;

pub struct StoreProjector;

impl IndexProjector for StoreProjector {
    fn project(&self, data: &Path, db: &Path, sessions: &[String]) -> Result<(), String> {
        project_index(data, db, sessions)
    }
}
