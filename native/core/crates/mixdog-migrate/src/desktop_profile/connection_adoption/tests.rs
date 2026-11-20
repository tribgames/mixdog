use super::*;
use std::cell::RefCell;

fn put(data: &Path, root: &str, file: &str, bytes: &[u8]) {
    std::fs::create_dir_all(data.join(root)).unwrap();
    std::fs::write(data.join(root).join(file), bytes).unwrap();
}
fn seed(data: &Path) {
    for file in FILES {
        put(data, "desktop", file, br#"{"version":1,"hosts":[],"enabled":false,"open":[]}"#);
        put(data, "desktop", &format!("{file}.bak"), br#"{"version":1,"hosts":[]}"#);
    }
}
fn bytes(data: &Path, root: &str, name: &str) -> Vec<u8> {
    std::fs::read(data.join(root).join(name)).unwrap()
}

#[test]
fn absent_current_stores_adopt_raw_families_and_keep_originals_and_private_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path();
    seed(data);
    run(data).unwrap();
    for file in FILES {
        for name in [file.to_owned(), format!("{file}.bak")] {
            assert_eq!(bytes(data, "userdata", &name), bytes(data, "desktop", &name));
            assert_eq!(bytes(data, &format!("{RECOVERY}/desktop"), &name), bytes(data, "desktop", &name));
        }
    }
    assert!(fsx::is_owner_only(&data.join("userdata/remote-hosts.json")).unwrap());
    assert!(fsx::is_owner_only(&data.join(RECOVERY).join("desktop/remote-hosts.json.bak")).unwrap());
    let marker = std::fs::read(data.join(MARKER)).unwrap();
    // The recovery archive must not share the inode of the live store.
    std::fs::write(data.join("userdata/ssh-hosts.json"), b"newer write").unwrap();
    std::fs::remove_file(data.join("userdata/remote-hosts.json")).unwrap();
    run(data).unwrap();
    run(data).unwrap();
    assert_eq!(std::fs::read(data.join(MARKER)).unwrap(), marker);
    assert_eq!(bytes(data, "userdata", "ssh-hosts.json"), b"newer write");
    assert!(!data.join("userdata/remote-hosts.json").exists(), "no resurrection");
    assert_eq!(bytes(data, &format!("{RECOVERY}/desktop"), "ssh-hosts.json"), bytes(data, "desktop", "ssh-hosts.json"));
}

#[test]
fn any_current_family_evidence_wins_without_union_or_stale_backup_import() {
    for trace in ["main", "empty", "backup", "corrupt", "aside"] {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        seed(data);
        for file in FILES {
            let (name, body) = match trace {
                "main" => (file.to_owned(), br#"{"version":1,"hosts":[{"id":"new"}],"enabled":false,"open":[]}"#.as_slice()),
                "empty" => (file.to_owned(), br#"{"version":1,"hosts":[],"enabled":false,"open":[]}"#.as_slice()),
                "backup" => (format!("{file}.bak"), br#"{"version":1,"hosts":[]}"#.as_slice()),
                "corrupt" => (file.to_owned(), b"{damaged".as_slice()),
                _ => (format!("{file}.corrupt-123"), b"prior damage".as_slice()),
            };
            put(data, "userdata", &name, body);
        }
        let before: Vec<_> = durable::walk_files(&data.join("userdata"))
            .unwrap()
            .into_iter()
            .map(|name| {
                let body = bytes(data, "userdata", &name);
                (name, body)
            })
            .collect();
        run(data).unwrap();
        let after: Vec<_> = durable::walk_files(&data.join("userdata"))
            .unwrap()
            .into_iter()
            .map(|name| {
                let body = bytes(data, "userdata", &name);
                (name, body)
            })
            .collect();
        assert_eq!(after, before, "{trace}: preserve current family exactly, including missing main/backup");
        for (name, body) in before {
            assert_eq!(bytes(data, &format!("{RECOVERY}/userdata"), &name), body);
        }
    }
}

#[test]
fn every_adoption_fault_resumes_without_losing_either_family() {
    let baseline = tempfile::tempdir().unwrap();
    seed(baseline.path());
    put(baseline.path(), "userdata", "ssh-hosts.json", b"current opaque bytes");
    let points = RefCell::new(Vec::new());
    run_with(baseline.path(), &|point| {
        points.borrow_mut().push(point.to_owned());
        Ok(())
    })
    .unwrap();
    let expected = std::fs::read(baseline.path().join(MARKER)).unwrap();
    for point in points.into_inner() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        seed(data);
        put(data, "userdata", "ssh-hosts.json", b"current opaque bytes");
        let stopped = run_with(data, &|at| if at == point { Err(Blocked::Interrupted { point: at.into() }) } else { Ok(()) });
        assert!(stopped.is_err(), "{point}");
        run(data).unwrap();
        assert_eq!(std::fs::read(data.join(MARKER)).unwrap(), expected, "{point}");
        assert_eq!(bytes(data, "userdata", "ssh-hosts.json"), b"current opaque bytes");
        for file in FILES {
            assert_eq!(bytes(data, &format!("{RECOVERY}/desktop"), file), bytes(data, "desktop", file), "{point}");
        }
    }
}

#[test]
fn a_late_profile_extends_only_unseen_families_and_never_resurrects_a_settled_one() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path();
    run(data).unwrap();
    assert!(!data.join(MARKER).exists());
    put(data, "userdata", "ssh-hosts.json", br#"{"version":1,"hosts":[]}"#);
    run(data).unwrap();
    std::fs::remove_file(data.join("userdata/ssh-hosts.json")).unwrap();
    seed(data);
    run(data).unwrap();
    assert!(!data.join("userdata/ssh-hosts.json").exists());
    assert!(data.join("userdata/remote-hosts.json").exists());
    assert_eq!(bytes(data, &format!("{RECOVERY}/desktop"), "ssh-hosts.json"), bytes(data, "desktop", "ssh-hosts.json"));
}

#[test]
fn a_new_current_write_after_planning_is_not_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path();
    seed(data);
    let stop = "connections-adoption:archive:desktop:ssh-hosts.json:before";
    assert!(run_with(data, &|at| if at == stop { Err(Blocked::Interrupted { point: at.into() }) } else { Ok(()) }).is_err());
    put(data, "userdata", "ssh-hosts.json", b"new authoritative write");
    assert!(matches!(run(data), Err(Blocked::TargetConflict { .. })));
    assert_eq!(bytes(data, "userdata", "ssh-hosts.json"), b"new authoritative write");
    assert!(data.join("desktop/ssh-hosts.json").exists());
}
