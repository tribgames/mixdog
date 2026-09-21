use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn server_dispatches_mixed_headers_and_preserves_validation_errors() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_mixdog-patch"))
        .arg("--server")
        .env("MIXDOG_PATCH_SERVER_IDLE_MS", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start patch server");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(
            concat!(
                "PING\r\n",
                "CONTRACT\n",
                "EDIT\n",
                "EDIT x 0 0 0 0\n",
                "EDIT 0 x 0 0 0\n",
                "EDIT 0 0 x 0 0\n",
                "EDIT 0 0 0 2 0\n",
                "EDIT\t0 0 0 0 1\r\n",
                "APPLY\n",
                "APPLY x 0 0 0 0 0\n",
                "APPLY 0 x 0 0 0 0\n",
                "APPLY 0 0 0 0 x 0\n",
                "APPLY 0 0 0 0 0 2\n",
                "APPLY\t0 0 0 1 0 1\r\n",
                "QUIT\n",
            )
            .as_bytes(),
        )
        .expect("send mixed requests");
    let output = child.wait_with_output().expect("server exits after QUIT");
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        concat!(
            "OK\tPONG\n",
            "OK\tmixdog-patch-engine-contract:3\n",
            "ERR\tbad edit header\n",
            "ERR\tbad path length\n",
            "ERR\tbad old length\n",
            "ERR\tbad new length\n",
            "ERR\tbad replace_all value\n",
            "ERR\told_string is empty\n",
            "ERR\tbad header\n",
            "ERR\tbad base length\n",
            "ERR\tbad patch length\n",
            "ERR\tbad fuzz value\n",
            "ERR\tbad reject_partial value\n",
            "ERR\tpatch contained no file sections\n",
        )
    );
}
