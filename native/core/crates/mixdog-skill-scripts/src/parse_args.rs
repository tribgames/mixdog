//! The part of `node:util` `parseArgs` the shipped scripts use (Node 22, strict mode): string and boolean
//! options, one-character aliases, `--name=value` and `--name value`, short-option groups, positionals and the
//! `--` terminator, with Node's error text.
//!
//! Arguments are read by character where Node reads by UTF-16 unit; they differ only for an option name that is
//! outside the Basic Multilingual Plane, which no shipped script declares.

use std::fmt;

use mixdog_js::json_quote;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OptionKind {
    String,
    Boolean,
}

/// One declared option.
#[derive(Clone, Copy, Debug)]
pub struct OptionSpec {
    pub name: &'static str,
    pub kind: OptionKind,
    pub short: Option<char>,
}

impl OptionSpec {
    pub const fn string(name: &'static str) -> Self {
        Self { name, kind: OptionKind::String, short: None }
    }

    pub const fn boolean(name: &'static str) -> Self {
        Self { name, kind: OptionKind::Boolean, short: None }
    }

    pub const fn short(self, alias: char) -> Self {
        Self { short: Some(alias), ..self }
    }
}

/// `{ options, allowPositionals }` of a `parseArgs` call (strict mode).
#[derive(Clone, Copy, Debug)]
pub struct ParseConfig<'a> {
    pub options: &'a [OptionSpec],
    pub allow_positionals: bool,
}

/// What an option was given: its text, or `true` for a boolean option.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OptionValue {
    Text(String),
    Flag,
}

/// `{ values, positionals }`: the values in the order their names first appeared.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Parsed {
    pub values: Vec<(String, OptionValue)>,
    pub positionals: Vec<String>,
}

impl Parsed {
    /// The text of a string option, when it was given.
    pub fn text(&self, name: &str) -> Option<&str> {
        self.values.iter().find(|(key, _)| key == name).and_then(|(_, value)| match value {
            OptionValue::Text(text) => Some(text.as_str()),
            OptionValue::Flag => None,
        })
    }

    /// Whether a boolean option was given.
    pub fn flag(&self, name: &str) -> bool {
        self.values.iter().any(|(key, value)| key == name && *value == OptionValue::Flag)
    }

    fn store(&mut self, name: &str, value: OptionValue) {
        match self.values.iter_mut().find(|(key, _)| key == name) {
            Some(slot) => slot.1 = value,
            None => self.values.push((name.to_owned(), value)),
        }
    }
}

/// The `TypeError` Node throws, by its `code` and `message`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParseArgsError {
    pub code: &'static str,
    pub message: String,
}

impl fmt::Display for ParseArgsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ParseArgsError {}

struct Token {
    name: String,
    raw_name: String,
    value: Option<String>,
    inline_value: bool,
}

enum Item {
    Option(Token),
    Positional(String),
}

fn find<'a>(options: &'a [OptionSpec], name: &str) -> Option<&'a OptionSpec> {
    options.iter().find(|spec| spec.name == name)
}

/// `findLongOptionForShort`: the declared option with this alias, otherwise the character itself.
fn long_for_short(options: &[OptionSpec], short: char) -> String {
    options.iter().find(|spec| spec.short == Some(short)).map_or_else(|| short.to_string(), |spec| spec.name.to_owned())
}

fn kind_of(options: &[OptionSpec], name: &str) -> Option<OptionKind> {
    find(options, name).map(|spec| spec.kind)
}

fn length(arg: &str) -> usize {
    arg.chars().count()
}

/// `arg.includes('=', 3)`.
fn has_equals_from_three(arg: &str) -> bool {
    arg.chars().skip(3).any(|c| c == '=')
}

fn second_char(arg: &str) -> Option<char> {
    arg.chars().nth(1)
}

fn tokens(args: &[String], options: &[OptionSpec]) -> Vec<Item> {
    let mut items = Vec::new();
    let mut remaining: std::collections::VecDeque<String> = args.iter().cloned().collect();
    while let Some(arg) = remaining.pop_front() {
        if arg == "--" {
            items.extend(remaining.drain(..).map(Item::Positional));
            break;
        }
        let starts_dash = arg.starts_with('-');
        let starts_double = arg.starts_with("--");
        let second = second_char(&arg);
        if length(&arg) == 2 && starts_dash && second != Some('-') {
            let short = second.unwrap_or('-');
            let name = long_for_short(options, short);
            let value = (kind_of(options, &name) == Some(OptionKind::String)).then(|| remaining.pop_front()).flatten();
            let inline_value = false;
            items.push(Item::Option(Token { name, raw_name: arg, value, inline_value }));
            continue;
        }
        if length(&arg) > 2 && starts_dash && second != Some('-') {
            let first = long_for_short(options, second.unwrap_or('-'));
            if kind_of(options, &first) != Some(OptionKind::String) {
                // `-fXzy` is `-f -X -z -y`; a string option inside the group takes the rest: `-abfFILE` is `-a -b -fFILE`.
                let chars: Vec<char> = arg.chars().collect();
                let mut expanded: Vec<String> = Vec::new();
                for (at, short) in chars.iter().enumerate().skip(1) {
                    let name = long_for_short(options, *short);
                    if kind_of(options, &name) != Some(OptionKind::String) || at == chars.len() - 1 {
                        expanded.push(format!("-{short}"));
                    } else {
                        expanded.push(format!("-{}", chars[at..].iter().collect::<String>()));
                        break;
                    }
                }
                for item in expanded.into_iter().rev() {
                    remaining.push_front(item);
                }
                continue;
            }
            // `-fFILE`
            let short = second.unwrap_or('-');
            let value: String = arg.chars().skip(2).collect();
            items.push(Item::Option(Token {
                name: long_for_short(options, short),
                raw_name: format!("-{short}"),
                value: Some(value),
                inline_value: true,
            }));
            continue;
        }
        if length(&arg) > 2 && starts_double && !has_equals_from_three(&arg) {
            let name: String = arg.chars().skip(2).collect();
            let value = (kind_of(options, &name) == Some(OptionKind::String)).then(|| remaining.pop_front()).flatten();
            items.push(Item::Option(Token { name, raw_name: arg, value, inline_value: false }));
            continue;
        }
        if length(&arg) > 2 && starts_double {
            // `--foo=bar`; the first `=` is at or after the third character.
            let body: String = arg.chars().skip(2).collect();
            let equal = body.find('=').unwrap_or(body.len());
            let name = body[..equal].to_owned();
            let value = body[(equal + 1).min(body.len())..].to_owned();
            items.push(Item::Option(Token { raw_name: format!("--{name}"), name, value: Some(value), inline_value: true }));
            continue;
        }
        items.push(Item::Positional(arg));
    }
    items
}

fn invalid_value(message: String) -> ParseArgsError {
    ParseArgsError { code: "ERR_PARSE_ARGS_INVALID_OPTION_VALUE", message }
}

fn check(options: &[OptionSpec], allow_positionals: bool, token: &Token) -> Result<(), ParseArgsError> {
    let Some(spec) = find(options, &token.name) else {
        let mut quoted = String::new();
        json_quote(&token.raw_name, &mut quoted);
        let suggestion = if allow_positionals {
            format!(
                ". To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- {quoted}"
            )
        } else {
            String::new()
        };
        return Err(ParseArgsError {
            code: "ERR_PARSE_ARGS_UNKNOWN_OPTION",
            message: format!("Unknown option '{}'{suggestion}", token.raw_name),
        });
    };
    let short_and_long = match spec.short {
        Some(short) => format!("-{short}, --{}", spec.name),
        None => format!("--{}", spec.name),
    };
    match (spec.kind, &token.value) {
        (OptionKind::String, None) => Err(invalid_value(format!("Option '{short_and_long} <value>' argument missing"))),
        (OptionKind::Boolean, Some(_)) => Err(invalid_value(format!("Option '{short_and_long}' does not take an argument"))),
        _ => Ok(()),
    }?;
    // A value that looks like an option, taken from the next argument, is most likely a forgotten value.
    if token.value.as_deref().is_some_and(|value| !token.inline_value && length(value) > 1 && value.starts_with('-')) {
        let example = if token.raw_name.starts_with("--") {
            format!("'{}=-XYZ'", token.raw_name)
        } else {
            format!("'--{}=-XYZ' or '{}-XYZ'", token.name, token.raw_name)
        };
        return Err(invalid_value(format!(
            "Option '{raw}' argument is ambiguous.\nDid you forget to specify the option argument for '{raw}'?\nTo specify an option argument starting with a dash use {example}.",
            raw = token.raw_name
        )));
    }
    Ok(())
}

/// `parseArgs({ args, options, allowPositionals })`.
pub fn parse_args(args: &[String], config: &ParseConfig<'_>) -> Result<Parsed, ParseArgsError> {
    let mut parsed = Parsed::default();
    for item in tokens(args, config.options) {
        match item {
            Item::Option(token) => {
                check(config.options, config.allow_positionals, &token)?;
                let value = token.value.map_or(OptionValue::Flag, OptionValue::Text);
                parsed.store(&token.name, value);
            }
            Item::Positional(value) => {
                if !config.allow_positionals {
                    return Err(ParseArgsError {
                        code: "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL",
                        message: format!("Unexpected argument '{value}'. This command does not take positional arguments"),
                    });
                }
                parsed.positionals.push(value);
            }
        }
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPTIONS: &[OptionSpec] = &[
        OptionSpec::string("provider").short('p'),
        OptionSpec::boolean("no-vision"),
        OptionSpec::boolean("v").short('v'),
        OptionSpec::string("o"),
    ];

    fn run(args: &[&str]) -> Result<Parsed, ParseArgsError> {
        let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
        parse_args(&args, &ParseConfig { options: OPTIONS, allow_positionals: true })
    }

    fn message(args: &[&str]) -> String {
        run(args).expect_err("an error").message
    }

    #[test]
    fn values_are_read_from_every_spelling() {
        let parsed = run(&["--provider", "a", "-pfoo", "--o=1", "x", "--no-vision", "-vpq", "--", "--z"]).expect("parses");
        assert_eq!(parsed.text("provider"), Some("q"));
        assert_eq!(parsed.text("o"), Some("1"));
        assert!(parsed.flag("no-vision") && parsed.flag("v"));
        assert_eq!(parsed.positionals, ["x", "--z"]);
        assert_eq!(parsed.values.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>(), ["provider", "o", "no-vision", "v"]);
    }

    #[test]
    fn an_empty_value_and_an_inline_dash_value_are_values() {
        assert_eq!(run(&["-p", ""]).expect("parses").text("provider"), Some(""));
        assert_eq!(run(&["--provider="]).expect("parses").text("provider"), Some(""));
        assert_eq!(run(&["--provider=-a"]).expect("parses").text("provider"), Some("-a"));
        assert_eq!(run(&["-p=x"]).expect("parses").text("provider"), Some("=x"));
        assert_eq!(run(&["--provider=a=b"]).expect("parses").text("provider"), Some("a=b"));
        assert_eq!(run(&["-"]).expect("parses").positionals, ["-"]);
    }

    #[test]
    fn errors_carry_nodes_text() {
        assert_eq!(
            message(&["--x"]),
            "Unknown option '--x'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"--x\""
        );
        assert_eq!(message(&["--provider"]), "Option '-p, --provider <value>' argument missing");
        assert_eq!(message(&["-o"]), "Option '--o <value>' argument missing");
        assert_eq!(message(&["--no-vision=1"]), "Option '--no-vision' does not take an argument");
        assert_eq!(
            message(&["--provider", "-q"]),
            "Option '--provider' argument is ambiguous.\nDid you forget to specify the option argument for '--provider'?\nTo specify an option argument starting with a dash use '--provider=-XYZ'."
        );
        assert_eq!(
            message(&["-p", "-a"]),
            "Option '-p' argument is ambiguous.\nDid you forget to specify the option argument for '-p'?\nTo specify an option argument starting with a dash use '--provider=-XYZ' or '-p-XYZ'."
        );
        assert!(message(&["-v=3"]).starts_with("Unknown option '-='."));
        assert!(message(&["--=x"]).starts_with("Unknown option '--=x'."));
        assert!(message(&["--==x"]).starts_with("Unknown option '--'."));
        assert!(message(&["---a"]).starts_with("Unknown option '---a'."));
    }

    #[test]
    fn without_positionals_the_message_has_no_suggestion_and_a_positional_is_refused() {
        let args = vec!["--x".to_owned()];
        let config = ParseConfig { options: OPTIONS, allow_positionals: false };
        assert_eq!(parse_args(&args, &config).expect_err("unknown").message, "Unknown option '--x'");
        let positional = parse_args(&["a".to_owned()], &config).expect_err("positional");
        assert_eq!(positional.code, "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL");
        assert_eq!(positional.message, "Unexpected argument 'a'. This command does not take positional arguments");
    }
}
