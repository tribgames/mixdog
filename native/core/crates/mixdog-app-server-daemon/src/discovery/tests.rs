#![allow(clippy::disallowed_methods, reason = "test setup on temp dirs")]

use super::*;

fn discovery(instance_id: &str, state: CoreState) -> Discovery {
    Discovery {
        pid: std::process::id(),
        endpoints: Endpoints {
            session: SessionEndpoint {
                port: 4100,
                token: "tok".into(),
            },
            model_proxy: None,
        },
        core: CoreSection {
            version: "1.4.6".into(),
            build: "abc".into(),
            instance_id: instance_id.into(),
            process_start_time: "123".into(),
            state,
            blocked: None,
            drain: None,
            rpc: (state == CoreState::Serving).then_some(Port { port: 4200 }),
            control: Port { port: 4100 },
        },
    }
}

#[test]
fn published_shape_is_a_superset_1_4_5_readers_parse() {
    let root = tempfile::tempdir().unwrap();
    publish(root.path(), &discovery("inst-1", CoreState::Serving)).unwrap();
    let value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path(root.path())).unwrap()).unwrap();
    assert_eq!(value["pid"], std::process::id());
    assert_eq!(value["endpoints"]["session"]["port"], 4100);
    assert_eq!(value["endpoints"]["session"]["token"], "tok");
    assert_eq!(value["core"]["state"], "serving");
    assert_eq!(value["core"]["instanceId"], "inst-1");
    assert_eq!(value["core"]["rpc"]["port"], 4200);
    assert_eq!(value["core"]["control"]["port"], 4100);
    assert!(value["core"].get("blocked").is_none());

    publish(root.path(), &discovery("inst-1", CoreState::Draining)).unwrap();
    let value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path(root.path())).unwrap()).unwrap();
    assert!(value["core"].get("rpc").is_none(), "draining removes rpc");
    assert_eq!(
        std::fs::read_dir(root.path()).unwrap().count(),
        1,
        "no staging file left"
    );
}

#[test]
fn withdraw_removes_only_this_instance() {
    let root = tempfile::tempdir().unwrap();
    publish(root.path(), &discovery("inst-1", CoreState::Booting)).unwrap();
    assert!(!withdraw(root.path(), "inst-2").unwrap());
    assert!(path(root.path()).is_file());
    assert!(withdraw(root.path(), "inst-1").unwrap());
    assert!(!path(root.path()).exists());
    assert!(!withdraw(root.path(), "inst-1").unwrap());
}

#[cfg(unix)]
#[test]
fn discovery_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("runtime");
    ensure_private_root(&runtime).unwrap();
    publish(&runtime, &discovery("inst-1", CoreState::Booting)).unwrap();
    assert_eq!(
        std::fs::metadata(path(&runtime))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::metadata(&runtime).unwrap().permissions().mode() & 0o777,
        0o700
    );
}

#[test]
fn runtime_root_is_named_as_1_4_5_names_it() {
    let root = runtime_root().unwrap();
    if std::env::var_os("MIXDOG_RUNTIME_ROOT").is_none() {
        assert!(root.starts_with(node_tmpdir()));
        #[cfg(windows)]
        assert_eq!(root.file_name().unwrap(), "mixdog");
        #[cfg(unix)]
        assert!(
            root.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("mixdog-")
        );
    }
}
