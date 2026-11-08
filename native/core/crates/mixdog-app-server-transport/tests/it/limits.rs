use crate::common;

use mixdog_app_protocol::limits::Limits;
use mixdog_app_server_transport::ConnectionHub;

#[test]
fn test_limits_satisfy_the_invariants() {
    assert!(ConnectionHub::new(common::small_limits()).is_ok());
}

#[test]
fn violated_invariant_refuses_to_start() {
    let limits = Limits {
        max_snapshot_bytes: Limits::default().event_budget_bytes,
        ..Limits::default()
    };
    assert!(ConnectionHub::new(limits).is_err());
}
