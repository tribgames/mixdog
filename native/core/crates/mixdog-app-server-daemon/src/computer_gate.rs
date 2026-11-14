//! Whether the `computer` feature exists for this core, without `computer-bridge.json`: the user switch
//! (`desktop.computerControl`, what the desktop's `setBridgeEnabled` wrote the file for) and a host that
//! can serve it (a connection that claimed the host with `capabilities.host.computer`, or, for a core
//! hosted by the TUI where no desktop claims anything, a resolvable helper binary).

use mixdog_core_config::config::DesktopSettings;

/// What the machine offers the gate; the composition implements it over the host claim registry and the
/// helper resolution.
pub trait HostPresence: Send + Sync {
    /// A connection holds the host claim with `capabilities.host.computer`.
    fn computer_claimed(&self) -> bool;
    /// The core is TUI-hosted and the helper binary resolves (`MIXDOG_COMPUTER_BIN`, bundled, local build).
    fn tui_helper_resolvable(&self) -> bool;
}

/// `desktop.computerControl` and a host serving the computer.
pub fn computer_feature_present(config: &DesktopSettings, host: &dyn HostPresence) -> bool {
    config.computer_control && (host.computer_claimed() || host.tui_helper_resolvable())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Host(bool, bool);

    impl HostPresence for Host {
        fn computer_claimed(&self) -> bool {
            self.0
        }
        fn tui_helper_resolvable(&self) -> bool {
            self.1
        }
    }

    fn settings(computer_control: bool) -> DesktopSettings {
        let doc = serde_json::json!({ "desktop": { "computerControl": computer_control } });
        mixdog_core_config::config::desktop_settings(doc.as_object().unwrap())
    }

    #[test]
    fn the_truth_table() {
        for (control, claimed, helper) in [
            (false, false, false),
            (false, true, false),
            (false, false, true),
            (false, true, true),
            (true, false, false),
            (true, true, false),
            (true, false, true),
            (true, true, true),
        ] {
            let expected = control && (claimed || helper);
            assert_eq!(computer_feature_present(&settings(control), &Host(claimed, helper)), expected, "{control} {claimed} {helper}");
        }
    }
}
