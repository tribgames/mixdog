use super::AgentKind;
use super::stall_first_byte_abort_s;
use super::stall_warn_ms;

#[test]
fn the_first_byte_abort_variable_moves_the_window_within_its_bounds() {
    let lead = AgentKind { name: Some("lead"), ..AgentKind::default() };
    let with = |raw: &'static str| move |name: &str| (name == "MIXDOG_STALL_FIRST_BYTE_ABORT_S").then(|| raw.to_owned());
    assert_eq!(stall_first_byte_abort_s(lead, &with("120")), 120);
    // Held to 5..=600 s; a value that is not a positive integer is the 300 s default.
    assert_eq!(stall_first_byte_abort_s(lead, &with("1")), 5);
    assert_eq!(stall_first_byte_abort_s(lead, &with("9000")), 600);
    assert_eq!(stall_first_byte_abort_s(lead, &with("0")), 300);
    assert_eq!(stall_first_byte_abort_s(lead, &with("soon")), 300);
    // Never beyond the agent's own abort: a worker's 300 s deadline caps a 600 s window.
    let worker = AgentKind { name: Some("worker"), ..AgentKind::default() };
    assert_eq!(stall_first_byte_abort_s(worker, &with("600")), 300);
    assert_eq!(stall_first_byte_abort_s(worker, &with("90")), 90);
}

#[test]
fn the_stall_deadline_is_the_variable_when_positive_else_the_hidden_agents_cap_else_600() {
    let none = |_: &str| None;
    let with = |raw: &'static str| move |name: &str| (name == "STALL_TIMEOUT_S").then(|| raw.to_owned());
    let plain = AgentKind { name: Some("nobody-special"), ..AgentKind::default() };
    assert_eq!(stall_warn_ms(plain, &none), 600_000);
    assert_eq!(stall_warn_ms(plain, &with("45")), 45_000);
    for bad in ["0", "-3", "soon", ""] {
        assert_eq!(stall_warn_ms(plain, &with(bad)), 600_000, "STALL_TIMEOUT_S={bad:?}");
    }
    let capped = AgentKind { name: Some("nobody-special"), hidden: true, stall_cap_idle_seconds: Some(90) };
    assert_eq!(stall_warn_ms(capped, &none), 90_000);
    assert_eq!(stall_warn_ms(capped, &with("45")), 45_000, "the variable outranks the cap");
    let zero_cap = AgentKind { stall_cap_idle_seconds: Some(0), ..capped };
    assert_eq!(stall_warn_ms(zero_cap, &none), 600_000, "a zero cap is no cap");
}

#[test]
fn the_first_byte_abort_never_outlasts_the_agents_own_abort_deadline() {
    let env = |name: &str| (name == "STALL_TIMEOUT_S").then(|| "60".to_owned());
    let agent = AgentKind { name: Some("nobody-special"), ..AgentKind::default() };
    assert_eq!(stall_first_byte_abort_s(agent, &env), 60);
}
