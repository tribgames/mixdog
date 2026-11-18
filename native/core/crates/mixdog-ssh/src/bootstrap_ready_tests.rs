//! The one SSH attach check: serving, healthy, the intended identity and mode, and an SSH listener published. The otherwise-current
//! fast path and the ensure result go through the same `ready`.

use super::*;
use crate::connect_failure::ConnectError;

fn report(ssh_rpc_port: Option<u16>, healthy: bool, core_current: bool) -> RemoteReport {
    RemoteReport {
        home: "/home/me".to_owned(),
        uid: 1000,
        runtime_root: "/home/me/.mixdog".to_owned(),
        version_dir: "/home/me/.mixdog/v".to_owned(),
        installed: true,
        discovery: Some(RemoteDiscovery {
            rpc_port: Some(46_001),
            ssh_rpc_port,
            control_port: 41_002,
            token: "token".to_owned(),
            pid: 4242,
            instance_id: "run-a".to_owned(),
            process_start_time: "t".to_owned(),
            state: "serving".to_owned(),
            version: "1.5.0".to_owned(),
            build: "0123456789abcdef".to_owned(),
        }),
        healthy,
        core_current,
        started: false,
        replaced: None,
        gc_removed: Vec::new(),
    }
}

fn refused(result: Result<RemoteReport, ConnectError>) -> RemoteBootstrapError {
    match result {
        Err(ConnectError::Bootstrap(error)) => error,
        other => panic!("expected a bootstrap refusal, got {other:?}"),
    }
}

#[test]
fn a_serving_current_core_with_the_ssh_listener_is_attached() {
    assert!(ready(report(Some(41_001), true, true)).is_ok());
}

#[test]
fn a_serving_current_core_without_the_ssh_listener_is_a_final_upgrade_required_not_a_starting_server() {
    let error = refused(ready(report(None, true, true)));
    assert_eq!(error.code, "server-upgrade-required");
    assert_eq!(error.notice.as_ref().map(|notice| notice.code.as_str()), Some("server-upgrade-required"));
    assert!(error.message.contains("1.5.0 (0123456789abcdef)"), "{}", error.message);
    assert!(error.is_terminal(), "connecting again finds the same core: the connection stops until the server is upgraded");
}

#[test]
fn a_core_that_is_not_serving_or_not_the_intended_one_stays_the_distinct_unhealthy_failure() {
    for (healthy, current) in [(false, true), (true, false), (false, false)] {
        let error = refused(ready(report(None, healthy, current)));
        assert_eq!(error.code, "daemon-unhealthy", "healthy={healthy} current={current}");
        assert!(!error.is_terminal());
    }
}
