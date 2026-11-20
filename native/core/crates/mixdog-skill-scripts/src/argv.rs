//! The argument carrier of the skill-script launcher and the entry contract of
//! `skill-script-entry.mjs`.
//!
//! The PowerShell launcher function cannot hand its arguments over on a command line (Windows PowerShell
//! 5.1 drops empty native arguments and does not escape embedded double quotes), so they travel in
//! `MIXDOG_SKILL_ARGV`: the tag `mixdog1`, then each argument as `,<UTF-8 base64>`. An empty argument is
//! an empty item and is kept.

use base64::Engine;

use crate::Outcome;

/// The environment variable that carries a PowerShell caller's arguments to the entry.
pub const SKILL_ARGV_ENV: &str = "MIXDOG_SKILL_ARGV";
const TAG: &str = "mixdog1";
/// What the entry prints when it is given no script.
pub const USAGE: &str = "Usage: <skill launcher> <script.mjs> [args...]";

/// The arguments a PowerShell caller sent through [`SKILL_ARGV_ENV`] (`decodeSkillArgv`), or `None` when the
/// value is absent or does not start with the tag. A malformed item decodes as Node's
/// `Buffer.from(item, 'base64')` decodes it: see [`node_base64`].
pub fn decode_skill_argv(value: Option<&str>) -> Option<Vec<String>> {
    let rest = value?.strip_prefix(TAG)?;
    if rest.is_empty() {
        return Some(Vec::new());
    }
    // `rest.slice(1)` drops whatever character follows the tag (the comma of a well-formed value).
    let mut chars = rest.chars();
    chars.next();
    Some(chars.as_str().split(',').map(|item| String::from_utf8_lossy(&node_base64(item)).into_owned()).collect())
}

/// `Buffer.from(text, 'base64')`: both alphabets are read, characters outside them (white space among them) are
/// skipped (a wide character by its low byte), a `=` ends the data, and a final group of two or three characters yields one or two bytes.
pub fn node_base64(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3 + 2);
    let mut held: u32 = 0;
    let mut count = 0;
    // Node reads a two-byte string a unit at a time and keeps the low byte of each: a surrogate pair of an
    // emoji can read as a `=` and end the data.
    for unit in text.encode_utf16() {
        let c = char::from(unit as u8);
        let sextet = match c {
            'A'..='Z' => c as u32 - 'A' as u32,
            'a'..='z' => c as u32 - 'a' as u32 + 26,
            '0'..='9' => c as u32 - '0' as u32 + 52,
            '+' | '-' => 62,
            '/' | '_' => 63,
            '=' => break,
            _ => continue,
        };
        held = (held << 6) | sextet;
        count += 1;
        if count == 4 {
            out.extend_from_slice(&[(held >> 16) as u8, (held >> 8) as u8, held as u8]);
            held = 0;
            count = 0;
        }
    }
    match count {
        2 => out.push((held >> 4) as u8),
        3 => out.extend_from_slice(&[(held >> 10) as u8, (held >> 2) as u8]),
        _ => {}
    }
    out
}

/// The tag and items of `arguments`, as the PowerShell launcher function writes them (the inverse of
/// [`decode_skill_argv`]).
pub fn encode_skill_argv(arguments: &[String]) -> String {
    let mut out = TAG.to_owned();
    for argument in arguments {
        out.push(',');
        out.push_str(&base64::engine::general_purpose::STANDARD.encode(argument.as_bytes()));
    }
    out
}

/// The script and the arguments the entry was asked to run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntryArguments {
    pub target: Option<String>,
    pub args: Vec<String>,
}

/// The target and arguments of `skill-script-entry.mjs`. `command_line` is what follows the entry on the
/// command line; the carried arguments are read only when there are none there.
pub fn entry_arguments(command_line: &[String], carried: Option<&str>) -> EntryArguments {
    let from_env = if command_line.is_empty() { decode_skill_argv(carried) } else { None };
    let all = from_env.as_deref().unwrap_or(command_line);
    EntryArguments { target: all.first().cloned(), args: all.iter().skip(1).cloned().collect() }
}

/// The entry's contract around a script run. No target prints the usage text on stderr and exits 2; a run
/// that fails prints the failure (its stack when it has one, otherwise its message) on stderr and exits 1;
/// otherwise the script's own outcome stands.
pub fn run_entry(command_line: &[String], carried: Option<&str>, run: impl FnOnce(&str, &[String]) -> Result<Outcome, String>) -> Outcome {
    let EntryArguments { target, args } = entry_arguments(command_line, carried);
    let mut outcome = Outcome::default();
    let Some(target) = target.filter(|target| !target.is_empty()) else {
        outcome.eprint(USAGE);
        outcome.code = 2;
        return outcome;
    };
    match run(&target, &args) {
        Ok(done) => done,
        Err(failure) => {
            outcome.eprint(&failure);
            outcome.code = 1;
            outcome
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn the_tag_alone_is_no_arguments_and_empty_items_are_kept() {
        assert_eq!(decode_skill_argv(Some("mixdog1")), Some(Vec::new()));
        assert_eq!(decode_skill_argv(Some("mixdog1,")), Some(strings(&[""])));
        assert_eq!(decode_skill_argv(Some("mixdog1,,")), Some(strings(&["", ""])));
        assert_eq!(decode_skill_argv(Some("other,YQ==")), None);
        assert_eq!(decode_skill_argv(Some("")), None);
        assert_eq!(decode_skill_argv(None), None);
    }

    #[test]
    fn arguments_round_trip_through_the_carrier() {
        let arguments = strings(&["probe.mjs", "a&b", "", "he said \"hi\"", "caf\u{e9} \u{1f600}"]);
        assert_eq!(decode_skill_argv(Some(&encode_skill_argv(&arguments))), Some(arguments));
    }

    #[test]
    fn a_malformed_item_decodes_as_node_decodes_it() {
        assert_eq!(node_base64("YQ"), b"a");
        assert_eq!(node_base64("YWI"), b"ab");
        assert_eq!(node_base64("YW Jj\nZA=="), b"abcd");
        assert_eq!(node_base64("YQ==YQ=="), b"a");
        assert_eq!(node_base64("Y*Q!="), b"a");
        assert_eq!(node_base64("-_-_"), [0xfb, 0xff, 0xbf]);
        assert_eq!(node_base64("Y"), b"");
        assert_eq!(node_base64("="), b"");
        assert_eq!(decode_skill_argv(Some("mixdog1,/w==")), Some(vec!["\u{fffd}".to_owned()]));
    }

    #[test]
    fn carried_arguments_are_read_only_when_the_command_line_has_none() {
        let carried = encode_skill_argv(&strings(&["probe.mjs", "x"]));
        let via_env = entry_arguments(&[], Some(&carried));
        assert_eq!((via_env.target.as_deref(), via_env.args), (Some("probe.mjs"), strings(&["x"])));
        let via_line = entry_arguments(&strings(&["direct.mjs", "y"]), Some(&carried));
        assert_eq!((via_line.target.as_deref(), via_line.args), (Some("direct.mjs"), strings(&["y"])));
        assert_eq!(entry_arguments(&[], Some("junk")).target, None);
        assert_eq!(entry_arguments(&[], Some("mixdog1")).target, None);
    }

    #[test]
    fn no_target_is_the_usage_text_and_exit_code_two() {
        let outcome = run_entry(&[], None, |_, _| panic!("no script runs"));
        assert_eq!(outcome, Outcome { stdout: String::new(), stderr: format!("{USAGE}\n"), code: 2 });
        let empty = run_entry(&strings(&[""]), None, |_, _| panic!("an empty target is no target"));
        assert_eq!(empty.code, 2);
    }

    #[test]
    fn a_failure_is_printed_and_exit_code_one_and_a_finished_run_stands() {
        let failed = run_entry(&strings(&["a.mjs"]), None, |_, _| Err("boom\n    at x".to_owned()));
        assert_eq!(failed, Outcome { stdout: String::new(), stderr: "boom\n    at x\n".to_owned(), code: 1 });
        let done = run_entry(&strings(&["a.mjs", "1"]), None, |target, args| {
            assert_eq!((target, args), ("a.mjs", strings(&["1"]).as_slice()));
            Ok(Outcome { stdout: "out\n".to_owned(), stderr: String::new(), code: 3 })
        });
        assert_eq!(done.code, 3);
    }
}
