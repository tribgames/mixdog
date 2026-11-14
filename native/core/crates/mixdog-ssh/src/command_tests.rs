use std::time::Duration;

use super::*;

fn target(destination: &str, port: Option<u16>, display: &str) -> SshTarget {
    SshTarget { destination: destination.into(), port, display: display.into() }
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

#[test]
fn accepts_host_aliases_user_at_host_user_at_host_port_and_bracketed_ipv6() {
    assert_eq!(parse_ssh_target("devbox"), Ok(target("devbox", None, "devbox")));
    assert_eq!(
        parse_ssh_target(" alice@build.example.com "),
        Ok(target("alice@build.example.com", None, "alice@build.example.com"))
    );
    assert_eq!(parse_ssh_target("alice@10.0.0.5:2222"), Ok(target("alice@10.0.0.5", Some(2222), "alice@10.0.0.5:2222")));
    assert_eq!(parse_ssh_target("host:22"), Ok(target("host", Some(22), "host:22")));
    assert_eq!(
        parse_ssh_target("bob@[fe80::1%eth0]:2200"),
        Ok(target("bob@fe80::1%eth0", Some(2200), "bob@[fe80::1%eth0]:2200"))
    );
    assert_eq!(parse_ssh_target("fe80::1"), Ok(target("fe80::1", None, "fe80::1")));
}

#[test]
fn refuses_option_injection_control_characters_and_shell_metacharacters() {
    for bad in [
        "-oProxyCommand=calc",
        "--",
        "-p",
        "alice@-oProxyCommand=x",
        "host\n-oProxyCommand=x",
        "host\u{0}",
        "host\t",
        "ho st",
        "host;rm -rf ~",
        "$(id)@host",
        "a`b`",
        "o'neil@host",
        "@host",
        "alice@",
        "host:0",
        "host:65536",
        "host:abc",
        "alice@[::1",
        "",
        "   ",
    ] {
        assert!(parse_ssh_target(bad).is_err(), "{bad:?}");
    }
}

#[test]
fn refusals_name_the_target_variable_and_the_value() {
    assert_eq!(parse_ssh_target("").unwrap_err().to_string(), "MIXDOG_SSH_TARGET is empty.");
    assert_eq!(
        parse_ssh_target("-p").unwrap_err().to_string(),
        "MIXDOG_SSH_TARGET must not start with \"-\": \"-p\""
    );
    assert_eq!(
        parse_ssh_target("host:abc").unwrap_err().to_string(),
        "MIXDOG_SSH_TARGET has an invalid port: \"host:abc\""
    );
    assert_eq!(
        parse_ssh_target("alice@[::1").unwrap_err().to_string(),
        "MIXDOG_SSH_TARGET has an unbalanced IPv6 literal: \"alice@[::1\""
    );
}

#[test]
fn label_and_key_of_a_target() {
    let parsed = parse_ssh_target("Deploy@VPS.example.com:2202").unwrap();
    assert_eq!(parsed.label(), "VPS.example.com");
    assert_eq!(parsed.key(), "Deploy@vps.example.com:2202");
    assert_eq!(parse_ssh_target("box").unwrap().key(), "@box:");
}

#[test]
fn exec_arguments_carry_every_mandatory_option_and_put_the_target_after_the_separator() {
    let parsed = parse_ssh_target("alice@host:2222").unwrap();
    let args = exec_args(&parsed, "sh -c true");
    for option in ["BatchMode=yes", "ConnectTimeout=15", "ServerAliveInterval=10", "ServerAliveCountMax=3", "StrictHostKeyChecking=yes"] {
        let index = args.iter().position(|arg| arg == option).unwrap();
        assert!(index > 0 && args[index - 1] == "-o", "{option}");
    }
    assert_eq!(args[..SSH_COMMON_OPTIONS.len()], SSH_COMMON_OPTIONS);
    let separator = args.iter().position(|arg| arg == "--").unwrap();
    assert_eq!(args[separator..], strings(&["--", "alice@host", "sh -c true"])[..]);
    let port = args.iter().position(|arg| arg == "-p").unwrap();
    assert!(port < separator && args[port + 1] == "2222");
    assert!(args.iter().any(|arg| arg == "ClearAllForwardings=yes"));
}

#[test]
fn tunnel_arguments_forward_a_loopback_port_and_fail_on_forward_errors() {
    let args = tunnel_args(&parse_ssh_target("devbox").unwrap(), 50123, 41001, None);
    let separator = args.iter().position(|arg| arg == "--").unwrap();
    assert_eq!(args[separator..], strings(&["--", "devbox"])[..]);
    assert!(args.iter().any(|arg| arg == "-N"));
    assert!(args.iter().any(|arg| arg == "ExitOnForwardFailure=yes"));
    let forward = args.iter().position(|arg| arg == "-L").unwrap();
    assert_eq!(args[forward + 1], "127.0.0.1:50123:127.0.0.1:41001");
    assert!(!args.iter().any(|arg| arg == "-p"));
    assert!(args.iter().any(|arg| arg == "BatchMode=yes") && args.iter().any(|arg| arg == "ServerAliveCountMax=3"));
}

#[test]
fn a_companion_forward_adds_a_second_l_and_the_stdio_forward_uses_w() {
    let parsed = parse_ssh_target("me@devbox:2200").unwrap();
    let args = tunnel_args(&parsed, 1, 2, Some((3, 4)));
    let forwards: Vec<&String> = args.iter().enumerate().filter(|(_, arg)| *arg == "-L").map(|(index, _)| &args[index + 1]).collect();
    assert_eq!(forwards, ["127.0.0.1:1:127.0.0.1:2", "127.0.0.1:3:127.0.0.1:4"]);
    let stdio = stdio_forward_args(&parsed, 41001);
    assert_eq!(stdio[stdio.len() - 4..], strings(&["-W", "127.0.0.1:41001", "--", "me@devbox"])[..]);
    assert!(stdio.windows(2).any(|pair| pair[0] == "-p" && pair[1] == "2200"));
}

#[test]
fn host_key_changes_and_refused_logins_are_terminal_network_trouble_is_not() {
    let changed = [
        "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
        "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @",
        "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
        "Host key for devbox has changed and you have requested strict checking.",
        "Host key verification failed.",
    ]
    .join("\n");
    assert_eq!(classify_failure(&changed), FailureClass::Terminal);
    assert_eq!(classify_failure("alice@devbox: Permission denied (publickey,password)."), FailureClass::Terminal);
    assert_eq!(classify_failure("Received disconnect from 1.2.3.4: Too many authentication failures"), FailureClass::Terminal);
    assert_eq!(classify_failure("ssh: connect to host devbox port 22: Connection refused"), FailureClass::Transient);
    assert_eq!(classify_failure("ssh: connect to host devbox port 22: Connection timed out"), FailureClass::Transient);
    assert_eq!(classify_failure("client_loop: send disconnect: Connection reset"), FailureClass::Transient);
    assert_eq!(classify_failure("Timeout, server devbox not responding."), FailureClass::Transient);
    assert_eq!(classify_failure(""), FailureClass::Transient);
}

#[test]
fn local_bind_failures_are_recognized_so_the_next_start_picks_another_port() {
    assert!(is_local_forward_bind_failure(
        "bind [127.0.0.1]:50123: Address already in use\nchannel_setup_fwd_listener_tcpip: cannot listen to port: 50123\nCould not request local forwarding."
    ));
    assert!(!is_local_forward_bind_failure("ssh: connect to host devbox port 22: Connection refused"));
}

#[test]
fn stderr_tail_keeps_the_last_lines_verbatim() {
    let text = (0..20).map(|index| format!("line {index}")).collect::<Vec<_>>().join("\r\n");
    assert_eq!(stderr_tail(&text, 3, 2_000), "line 17\nline 18\nline 19");
    assert_eq!(stderr_tail("a\n\n  \nb", 12, 2_000), "a\nb");
    assert_eq!(stderr_tail("abcdef", 12, 3), "def");
}

#[test]
fn ssh_errors_carry_the_kind_the_tail_and_the_exit_code() {
    let error = SshError::new("ssh devbox failed", FailureClass::Terminal).with_stderr("Permission denied", Some(255));
    assert!(error.is_terminal());
    assert_eq!(error.to_string(), "ssh devbox failed");
    assert_eq!((error.stderr_tail.as_str(), error.exit_code), ("Permission denied", Some(255)));
    assert!(!SshError::new("timed out", FailureClass::Transient).is_terminal());
}

#[test]
fn backoff_walks_1_2_5_5_10_10_10_30_30_s_repeats_the_last_step_and_resets_after_60_s_healthy() {
    let mut backoff = TunnelBackoff::new();
    let delays: Vec<u64> = (0..11).map(|_| backoff.next(Duration::ZERO).as_secs()).collect();
    assert_eq!(delays, [1, 2, 5, 5, 10, 10, 10, 30, 30, 30, 30]);
    assert_eq!(backoff.next(Duration::from_millis(59_999)), Duration::from_millis(30_000));
    assert_eq!(backoff.next(Duration::from_millis(60_000)), Duration::from_millis(1_000));
    assert_eq!(backoff.next(Duration::from_millis(5_000)), Duration::from_millis(2_000));
    backoff.reset();
    assert_eq!(backoff.next(Duration::ZERO), Duration::from_secs(1));
}
