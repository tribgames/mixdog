//! Legacy compaction settings are normalised: the retired compaction keys are dropped.

use serde_json::Value;

/// compact-smoke.mjs's migration check: `normalizeCompactionConfig` drops the retired compaction types and their knobs.
#[test]
fn the_retired_compaction_keys_are_dropped() {
    let legacy = serde_json::json!({ "type": "semantic", "compactType": "recall-fasttrack", "semantic": "auto", "prune": true, "tailTurns": 5, "auto": true });
    let migrated = mixdog_agent::compact::settings::normalize_compaction(Some(&legacy));
    for key in ["type", "compactType", "semantic", "prune", "tailTurns"] {
        assert!(!migrated.contains_key(key), "{key} kept: {migrated:?}");
    }
    assert_eq!(migrated.get("auto"), Some(&Value::Bool(true)));
}
