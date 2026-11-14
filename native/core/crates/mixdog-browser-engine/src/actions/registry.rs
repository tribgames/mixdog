//! Owner: s4-engine-runner
//! The registry of the Browser Use actions: the 33 names of the command contract (the table of `mixdog-tools` `desktop/browser.rs`,
//! `contracts()`), each one a variant the runner dispatches on. The session bookkeeping actions (`list_tabs`, `downloads`,
//! `close_tab`, `hide`) are answered without a page; every other one addresses a page and is handled by the module that owns it
//! (`pointer`, `forms`, `upload`, `observe`, `navigation`, `flow`, `diagnostics`, `page`, `emulation`, `sequence`).

use crate::limits::TABLESS_ACTIONS;

macro_rules! actions {
    ($($variant:ident => $name:literal,)*) => {
        /// One action of the command contract.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum Action {
            $($variant,)*
        }

        impl Action {
            /// Every action, in the order of the contract.
            pub const ALL: &'static [Action] = &[$(Action::$variant,)*];

            /// The name the command carries.
            pub const fn name(self) -> &'static str {
                match self {
                    $(Action::$variant => $name,)*
                }
            }

            /// The action named `name` (trimmed and lower-cased, as `normalizeBrowserAction` reads it); `None` when the contract has none.
            pub fn parse(name: &str) -> Option<Self> {
                let name = mixdog_js::js_to_lowercase(mixdog_js::js_trim(name));
                match name.as_str() {
                    $($name => Some(Action::$variant),)*
                    _ => None,
                }
            }
        }
    };
}

actions! {
    Navigate => "navigate",
    Snapshot => "snapshot",
    Locate => "locate",
    Evaluate => "evaluate",
    Emulate => "emulate",
    Cookies => "cookies",
    Storage => "storage",
    Performance => "performance",
    Click => "click",
    Fill => "fill",
    Type => "type",
    Select => "select",
    Hover => "hover",
    Drag => "drag",
    Upload => "upload",
    HandleDialog => "handle_dialog",
    Press => "press",
    Scroll => "scroll",
    Back => "back",
    Sequence => "sequence",
    Read => "read",
    Extract => "extract",
    Wait => "wait",
    Status => "status",
    Console => "console",
    Network => "network",
    Intercept => "intercept",
    InitScript => "init_script",
    ListTabs => "list_tabs",
    CloseTab => "close_tab",
    Downloads => "downloads",
    Open => "open",
    Hide => "hide",
}

impl Action {
    /// The action addresses the session, never a page: it neither opens nor creates one.
    pub fn is_tabless(self) -> bool {
        TABLESS_ACTIONS.contains(&self.name())
    }
}

/// Whether `name` is an action of the contract: what the approval policy checks the names of its lists against.
pub fn is_action(name: &str) -> bool {
    Action::ALL.iter().any(|action| action.name() == name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::limits::DIALOG_TOLERANT_ACTIONS;
    use crate::limits::OBSERVATION_ACTIONS;
    use crate::limits::POSTCONDITION_ACTIONS;
    use crate::limits::SEQUENCE_STEP_ACTIONS;

    /// The action names of `contracts()` in `mixdog-tools` `desktop/browser.rs`, in its order.
    const CONTRACT: [&str; 33] = [
        "navigate", "snapshot", "locate", "evaluate", "emulate", "cookies", "storage", "performance", "click", "fill", "type", "select", "hover", "drag",
        "upload", "handle_dialog", "press", "scroll", "back", "sequence", "read", "extract", "wait", "status", "console", "network", "intercept",
        "init_script", "list_tabs", "close_tab", "downloads", "open", "hide",
    ];

    #[test]
    fn the_registry_is_the_contract() {
        let names: Vec<&str> = Action::ALL.iter().map(|action| action.name()).collect();
        assert_eq!(names, CONTRACT);
    }

    #[test]
    fn every_name_parses_back_and_nothing_else_does() {
        for action in Action::ALL {
            assert_eq!(Action::parse(action.name()), Some(*action));
            assert_eq!(Action::parse(&format!("  {}\n", action.name().to_uppercase())), Some(*action));
            assert!(is_action(action.name()));
        }
        for unknown in ["", "begin_turn", "finish_turn", "secret_fill", "Click2", "saved_login_type"] {
            assert_eq!(Action::parse(unknown), None, "{unknown}");
            assert!(!is_action(unknown), "{unknown}");
        }
    }

    #[test]
    fn the_limit_tables_name_only_registered_actions() {
        for table in [TABLESS_ACTIONS, DIALOG_TOLERANT_ACTIONS, OBSERVATION_ACTIONS, POSTCONDITION_ACTIONS, SEQUENCE_STEP_ACTIONS] {
            for name in table {
                assert!(is_action(name), "{name}");
            }
        }
    }

    #[test]
    fn the_session_bookkeeping_actions_are_the_tabless_ones() {
        let tabless: Vec<&str> = Action::ALL.iter().filter(|action| action.is_tabless()).map(|action| action.name()).collect();
        assert_eq!(tabless, ["list_tabs", "close_tab", "downloads", "hide"]);
    }
}
