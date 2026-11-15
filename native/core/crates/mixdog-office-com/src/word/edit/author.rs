//! `Apply-WordOperation`'s author wrapper: Word stamps tracked changes and comments with the application user name. An
//! explicit author on the operation labels them instead, and the name is restored right after the operation whatever
//! happens inside it.

use super::Com;
use super::Value;
use super::prop;
use super::text_of;
use crate::com::Obj;
use crate::com::Result;

/// A text that is null, empty or only white space (`[string]::IsNullOrWhiteSpace`).
fn blank(text: &str) -> bool {
    text.trim().is_empty()
}

/// Runs `run` with the application's user name (and, when the operation gives them, the initials) set to the operation's
/// author. A signed-in Office account overrides the user name unless Word is told to use the local values; all of it goes
/// back afterwards, whether `run` succeeds or not.
pub(super) fn with_author(document: &Obj, op: &Value, run: impl FnOnce() -> Result<Value>) -> Result<Value> {
    let author = prop(op, "author");
    let label = if author.is_null() { String::new() } else { text_of(&author) };
    if blank(&label) {
        return run();
    }
    let application = document.get("Application")?;
    let previous_name = super::string(&application.member("UserName")?);
    let previous_local_info = application.member("Options").and_then(|options| options.member("UseLocalUserInfo")).ok().map(|value| super::truth(&value));
    let initials = prop(op, "initials");
    let initials_label = if initials.is_null() { String::new() } else { text_of(&initials) };
    let previous_initials =
        if blank(&initials_label) { None } else { application.member("UserInitials").ok().map(|value| super::string(&value)) };
    let outcome = (|| -> Result<Value> {
        application.set_member("UserName", Com::from(label.as_str()))?;
        if previous_initials.is_some() {
            let _ = application.set_member("UserInitials", Com::from(initials_label.as_str()));
        }
        let _ = application.member("Options").and_then(|options| options.set_member("UseLocalUserInfo", Com::Bool(true)));
        run()
    })();
    let _ = application.set_member("UserName", Com::from(previous_name));
    if let Some(initials) = previous_initials {
        let _ = application.set_member("UserInitials", Com::from(initials));
    }
    if let Some(local_info) = previous_local_info {
        let _ = application.member("Options").and_then(|options| options.set_member("UseLocalUserInfo", Com::Bool(local_info)));
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_label_of_white_space_is_no_author() {
        assert!(blank("") && blank(" \t") && !blank("Reviewer"));
    }
}
