//! How a stdio server's command line is made safe for `cmd.exe` and its Windows path is normalised: the quoting and caret rules of a
//! command and of an argument, and `path.win32.normalize`.

use mixdog_mcp::cross_spawn::escape_argument;
use mixdog_mcp::cross_spawn::escape_command;
use mixdog_mcp::cross_spawn::normalize_win32;

#[test]
fn a_command_has_each_cmd_metacharacter_caret_escaped_and_nothing_else_changed() {
    assert_eq!(escape_command("node"), "node");
    assert_eq!(escape_command("C:\\Program Files\\tool.cmd"), "C:\\Program^ Files\\tool.cmd");
    assert_eq!(escape_command("a&b|c>d<e^f%g!h"), "a^&b^|c^>d^<e^^f^%g^!h");
    assert_eq!(escape_command("(x)[y];,*?`"), "^(x^)^[y^]^;^,^*^?^`");
}

#[test]
fn an_argument_is_quoted_with_its_quotes_and_trailing_backslashes_made_literal_and_every_metacharacter_escaped() {
    assert_eq!(escape_argument("plain", false), "^\"plain^\"");
    assert_eq!(escape_argument("a b", false), "^\"a^ b^\"");
    assert_eq!(escape_argument("say \"hi\"", false), "^\"say^ \\^\"hi\\^\"^\"");
    // A backslash before a quote is doubled and the quote escaped: three backslashes and the quote.
    assert_eq!(escape_argument("a\\\"b", false), "^\"a\\\\\\^\"b^\"");
    // A backslash at the end would escape the closing quote, so it is doubled.
    assert_eq!(escape_argument("C:\\dir\\", false), "^\"C:\\dir\\\\^\"");
    assert_eq!(escape_argument("", false), "^\"^\"");
}

#[test]
fn a_command_run_through_a_cmd_shim_escapes_its_arguments_twice() {
    assert_eq!(escape_argument("a", true), "^^^\"a^^^\"");
    assert_eq!(escape_argument("a b", true), "^^^\"a^^^ b^^^\"");
}

#[test]
fn a_windows_path_is_normalised_as_node_does() {
    for (path, normal) in [
        ("", "."),
        ("C:\\a\\b\\..\\c", "C:\\a\\c"),
        ("C:/a//b/./c/", "C:\\a\\b\\c\\"),
        ("C:\\..\\x", "C:\\x"),
        ("C:a\\..", "C:."),
        ("a\\..\\..\\b", "..\\b"),
        ("\\\\server\\share\\x\\..\\y", "\\\\server\\share\\y"),
        ("\\a\\.\\b", "\\a\\b"),
        ("tool.cmd", "tool.cmd"),
    ] {
        assert_eq!(normalize_win32(path), normal, "{path:?}");
    }
}
