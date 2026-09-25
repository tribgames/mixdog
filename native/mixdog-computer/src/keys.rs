//! The key-stream grammar the desktop host sends: `^` Ctrl, `%` Alt, `+`
//! Shift, `#` the system key (Command on macOS, Super on Linux), `{NAME n}`
//! named keys with an optional repeat, `(...)` groups sharing modifiers, `~`
//! Enter. The whole stream is parsed and validated before any key is sent.

use std::collections::HashSet;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Mod {
    Shift,
    Ctrl,
    Alt,
    Super,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Named {
    Backspace,
    Tab,
    Enter,
    Escape,
    Space,
    PageUp,
    PageDown,
    End,
    Home,
    Left,
    Up,
    Right,
    Down,
    Insert,
    Delete,
    CapsLock,
    NumLock,
    ScrollLock,
    Apps,
    PrintScreen,
    Pause,
    F(u8),
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Key {
    Named(Named),
    /// A key named by the unshifted character it types on a US layout.
    Char(char),
    Mod(Mod),
}

pub trait KeySink {
    fn down(&mut self, key: Key) -> Result<(), String>;
    fn up(&mut self, key: Key) -> Result<(), String>;
    fn tap(&mut self, key: Key) -> Result<(), String> {
        self.down(key)?;
        self.up(key)
    }
    fn text(&mut self, text: &str) -> Result<(), String>;
}

#[derive(Debug, Default, Clone)]
struct Node {
    modifiers: Vec<Mod>,
    children: Option<Vec<Node>>,
    key: Option<Key>,
    text: Option<String>,
    repeat: u32,
}

fn invalid<T>() -> Result<T, String> {
    Err("invalid_keys: malformed or excessive key stream".into())
}

pub fn named_key(name: &str) -> Result<Key, String> {
    let key = match name {
        "BACKSPACE" | "BS" => Key::Named(Named::Backspace),
        "TAB" => Key::Named(Named::Tab),
        "ENTER" | "RETURN" => Key::Named(Named::Enter),
        "ESC" | "ESCAPE" => Key::Named(Named::Escape),
        "SPACE" => Key::Named(Named::Space),
        "PGUP" | "PRIOR" => Key::Named(Named::PageUp),
        "PGDN" | "NEXT" => Key::Named(Named::PageDown),
        "END" => Key::Named(Named::End),
        "HOME" => Key::Named(Named::Home),
        "LEFT" => Key::Named(Named::Left),
        "UP" => Key::Named(Named::Up),
        "RIGHT" => Key::Named(Named::Right),
        "DOWN" => Key::Named(Named::Down),
        "INSERT" | "INS" => Key::Named(Named::Insert),
        "DELETE" | "DEL" => Key::Named(Named::Delete),
        "PLUS" => Key::Char('='),
        "MINUS" => Key::Char('-'),
        "SHIFT" => Key::Mod(Mod::Shift),
        "CTRL" | "CONTROL" => Key::Mod(Mod::Ctrl),
        "ALT" | "MENU" => Key::Mod(Mod::Alt),
        "CAPSLOCK" => Key::Named(Named::CapsLock),
        "NUMLOCK" => Key::Named(Named::NumLock),
        "SCROLLLOCK" => Key::Named(Named::ScrollLock),
        "LWIN" | "WIN" | "CMD" | "COMMAND" | "SUPER" | "META" => Key::Mod(Mod::Super),
        "APPS" => Key::Named(Named::Apps),
        "PRTSC" | "PRINTSCREEN" => Key::Named(Named::PrintScreen),
        "PAUSE" => Key::Named(Named::Pause),
        other => {
            let number = other
                .strip_prefix('F')
                .and_then(|digits| digits.parse::<u8>().ok())
                .filter(|number| (1..=24).contains(number));
            match number {
                Some(number) => Key::Named(Named::F(number)),
                None => {
                    return Err(format!(
                        "invalid_keys: unsupported key token {{{other}}}"
                    ))
                }
            }
        }
    };
    Ok(key)
}

/// The key that types `glyph` on a US layout, and whether Shift is part of it.
pub fn glyph_key(glyph: char) -> Option<(char, bool)> {
    if glyph.is_ascii_lowercase() || glyph.is_ascii_digit() {
        return Some((glyph, false));
    }
    if glyph.is_ascii_uppercase() {
        return Some((glyph.to_ascii_lowercase(), true));
    }
    const PLAIN: &str = "`-=[]\\;',./ ";
    const SHIFTED: [(char, char); 21] = [
        ('~', '`'),
        ('!', '1'),
        ('@', '2'),
        ('#', '3'),
        ('$', '4'),
        ('%', '5'),
        ('^', '6'),
        ('&', '7'),
        ('*', '8'),
        ('(', '9'),
        (')', '0'),
        ('_', '-'),
        ('+', '='),
        ('{', '['),
        ('}', ']'),
        ('|', '\\'),
        (':', ';'),
        ('"', '\''),
        ('<', ','),
        ('>', '.'),
        ('?', '/'),
    ];
    if PLAIN.contains(glyph) {
        return Some((glyph, false));
    }
    SHIFTED
        .iter()
        .find(|(shifted, _)| *shifted == glyph)
        .map(|(_, base)| (*base, true))
}

struct Parser<'a> {
    source: Vec<char>,
    at: usize,
    cost: u32,
    _marker: std::marker::PhantomData<&'a ()>,
}

impl<'a> Parser<'a> {
    fn new(value: &'a str) -> Result<Parser<'a>, String> {
        let source: Vec<char> = value.chars().collect();
        if value.encode_utf16().count() > 512 {
            return invalid();
        }
        Ok(Parser { source, at: 0, cost: 0, _marker: std::marker::PhantomData })
    }

    fn parse(&mut self, depth: u32, group: bool) -> Result<Vec<Node>, String> {
        if depth > 8 {
            return invalid();
        }
        let mut nodes = Vec::new();
        while self.at < self.source.len() {
            if self.source[self.at] == ')' {
                if !group {
                    return invalid();
                }
                self.at += 1;
                return Ok(nodes);
            }
            let mut node = Node { repeat: 1, ..Node::default() };
            // '#' as the final character is the literal glyph, not the system key.
            while self.at < self.source.len()
                && "^%+#".contains(self.source[self.at])
                && !(self.source[self.at] == '#' && self.at + 1 >= self.source.len())
            {
                let modifier = match self.source[self.at] {
                    '^' => Mod::Ctrl,
                    '%' => Mod::Alt,
                    '#' => Mod::Super,
                    _ => Mod::Shift,
                };
                if node.modifiers.contains(&modifier) {
                    return invalid();
                }
                node.modifiers.push(modifier);
                self.at += 1;
            }
            if self.at >= self.source.len() {
                return invalid();
            }
            let token = self.source[self.at];
            self.at += 1;
            if token == '(' {
                node.children = Some(self.parse(depth + 1, true)?);
            } else if token == '{' {
                if self.at + 1 < self.source.len()
                    && (self.source[self.at] == '{' || self.source[self.at] == '}')
                    && self.source[self.at + 1] == '}'
                {
                    node.text = Some(self.source[self.at].to_string());
                    self.at += 2;
                } else {
                    let Some(offset) = self.source[self.at..].iter().position(|c| *c == '}') else {
                        return invalid();
                    };
                    let end = self.at + offset;
                    let mut text: String = self.source[self.at..end].iter().collect();
                    self.at = end + 1;
                    if let Some(space) = text.rfind(' ') {
                        let repeat: u32 = match text[space + 1..].parse() {
                            Ok(repeat) if (1..=100).contains(&repeat) => repeat,
                            _ => return invalid(),
                        };
                        node.repeat = repeat;
                        text.truncate(space);
                    }
                    let mut chars = text.chars();
                    match (chars.next(), chars.next()) {
                        (Some(glyph), None) if "+^%~()[]".contains(glyph) => {
                            node.text = Some(glyph.to_string())
                        }
                        _ => node.key = Some(named_key(&text.to_uppercase())?),
                    }
                }
            } else if token == '~' {
                node.key = Some(Key::Named(Named::Enter));
            } else if token == ')' || token == '}' || token.is_control() {
                return invalid();
            } else {
                node.text = Some(token.to_string());
            }
            self.cost += node.repeat;
            if self.cost > 10_000 {
                return invalid();
            }
            nodes.push(node);
        }
        if group {
            return invalid();
        }
        Ok(nodes)
    }
}

fn resolve_text_key(node: &mut Node, modifiers: &HashSet<Mod>) -> Result<(), String> {
    let glyph = node
        .text
        .as_ref()
        .and_then(|text| text.chars().next())
        .ok_or_else(|| "invalid_keys: empty key".to_string())?;
    let (base, shifted) = glyph_key(glyph)
        .ok_or_else(|| "invalid_keys: character has no modified-key mapping".to_string())?;
    node.key = Some(Key::Char(base));
    node.text = None;
    // A letter's case names the key, not a shift: '^S' and '^s' are both Ctrl+S.
    if shifted && !glyph.is_ascii_alphabetic() && !modifiers.contains(&Mod::Shift) {
        node.modifiers.push(Mod::Shift);
    }
    Ok(())
}

/// Chords that end the user's session or app without a question.
fn blocked(key: Key, modifiers: &HashSet<Mod>) -> Option<&'static str> {
    if key == Key::Named(Named::F(4)) && modifiers.contains(&Mod::Alt) {
        return Some("unsafe_key: Alt+F4 is blocked");
    }
    if cfg!(target_os = "macos") {
        if key == Key::Char('q') && modifiers.contains(&Mod::Super) {
            return Some("unsafe_key: Command+Q is blocked");
        }
    } else if key == Key::Char('l') && modifiers.contains(&Mod::Super) {
        return Some("unsafe_key: Super+L is blocked");
    }
    None
}

fn validate(nodes: &mut [Node], inherited: &HashSet<Mod>) -> Result<(), String> {
    for node in nodes.iter_mut() {
        let mut modifiers = inherited.clone();
        modifiers.extend(node.modifiers.iter().copied());
        if let Some(children) = node.children.as_mut() {
            validate(children, &modifiers)?;
        } else if node.text.is_some() && !modifiers.is_empty() {
            resolve_text_key(node, &modifiers)?;
        }
        if let Some(key) = node.key {
            if let Some(reason) = blocked(key, &modifiers) {
                return Err(reason.into());
            }
        }
    }
    Ok(())
}

fn execute(nodes: &[Node], sink: &mut dyn KeySink, held: &mut HashSet<Mod>) -> Result<(), String> {
    for node in nodes {
        let mut pressed = Vec::new();
        let mut outcome = Ok(());
        for modifier in &node.modifiers {
            if held.contains(modifier) {
                continue;
            }
            // Tracked before dispatch: a partial failure still needs its release.
            pressed.push(*modifier);
            held.insert(*modifier);
            if let Err(error) = sink.down(Key::Mod(*modifier)) {
                outcome = Err(error);
                break;
            }
        }
        if outcome.is_ok() {
            outcome = if let Some(children) = &node.children {
                execute(children, sink, held)
            } else {
                (0..node.repeat).try_for_each(|_| match (node.key, &node.text) {
                    (Some(key), _) => sink.tap(key),
                    (None, Some(text)) => sink.text(text),
                    (None, None) => Ok(()),
                })
            };
        }
        let mut release_error = None;
        for modifier in pressed.iter().rev() {
            if let Err(error) = sink.up(Key::Mod(*modifier)) {
                release_error.get_or_insert(error);
            }
            held.remove(modifier);
        }
        if let Some(error) = release_error {
            return Err(format!("input_cleanup_unconfirmed: key release failed: {error}"));
        }
        outcome?;
    }
    Ok(())
}

pub fn send(value: &str, sink: &mut dyn KeySink) -> Result<(), String> {
    let mut nodes = Parser::new(value)?.parse(0, false)?;
    validate(&mut nodes, &HashSet::new())?;
    execute(&nodes, sink, &mut HashSet::new())
}

/// The single key and its modifiers a held stream names.
pub fn held_key(value: &str) -> Result<(Vec<Mod>, Key), String> {
    let mut nodes = Parser::new(value)?.parse(0, false)?;
    validate(&mut nodes, &HashSet::new())?;
    if nodes.len() != 1 {
        return Err("invalid_keys: a held key must name exactly one key".into());
    }
    let mut node = nodes.remove(0);
    if node.children.is_some() || node.repeat != 1 {
        return Err("invalid_keys: a held key cannot be a group or a repeat".into());
    }
    if node.key.is_none() {
        if node.text.as_ref().map(|text| text.chars().count()) != Some(1) {
            return Err("invalid_keys: a held key must name exactly one key".into());
        }
        resolve_text_key(&mut node, &HashSet::new())?;
    }
    let key = node.key.ok_or_else(|| "invalid_keys: a held key must name exactly one key".to_string())?;
    Ok((node.modifiers, key))
}

pub fn hold(value: &str, down: bool, sink: &mut dyn KeySink) -> Result<(), String> {
    let (modifiers, key) = held_key(value)?;
    if down {
        for modifier in &modifiers {
            sink.down(Key::Mod(*modifier))?;
        }
        return sink.down(key);
    }
    sink.up(key)?;
    for modifier in modifiers.iter().rev() {
        sink.up(Key::Mod(*modifier))?;
    }
    Ok(())
}

/// Whether a stream is plain text rather than grammar: one character, or no
/// grammar characters at all.
pub fn is_plain_text(value: &str) -> bool {
    value.chars().count() == 1 || !value.chars().any(|c| "{}^%+~()#".contains(c))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Log(Vec<String>);
    impl KeySink for Log {
        fn down(&mut self, key: Key) -> Result<(), String> {
            self.0.push(format!("down {key:?}"));
            Ok(())
        }
        fn up(&mut self, key: Key) -> Result<(), String> {
            self.0.push(format!("up {key:?}"));
            Ok(())
        }
        fn text(&mut self, text: &str) -> Result<(), String> {
            self.0.push(format!("text {text}"));
            Ok(())
        }
    }

    fn run(value: &str) -> Result<Vec<String>, String> {
        let mut log = Log::default();
        send(value, &mut log)?;
        Ok(log.0)
    }

    #[test]
    fn chords_press_and_release_in_order() {
        assert_eq!(
            run("^s").unwrap(),
            vec!["down Mod(Ctrl)", "down Char('s')", "up Char('s')", "up Mod(Ctrl)"]
        );
    }

    #[test]
    fn named_keys_repeat() {
        assert_eq!(run("{TAB 2}").unwrap().len(), 4);
        assert!(run("{TAB 101}").is_err());
    }

    #[test]
    fn plain_characters_are_text() {
        assert_eq!(run("ab").unwrap(), vec!["text a", "text b"]);
        assert_eq!(run("{+}").unwrap(), vec!["text +"]);
    }

    #[test]
    fn groups_share_modifiers() {
        let log = run("+(ab)").unwrap();
        assert_eq!(log.first().unwrap(), "down Mod(Shift)");
        assert_eq!(log.last().unwrap(), "up Mod(Shift)");
    }

    #[test]
    fn shifted_glyph_brings_shift() {
        let log = run("^!").unwrap();
        assert!(log.contains(&"down Mod(Shift)".to_string()));
        assert!(log.contains(&"down Char('1')".to_string()));
    }

    #[test]
    fn unsafe_chords_are_refused_before_input() {
        assert!(run("%{F4}").unwrap_err().starts_with("unsafe_key"));
    }

    #[test]
    fn malformed_streams_are_refused() {
        for value in ["^", "(a", "a)", "{ENTER", "^^a"] {
            assert!(run(value).is_err(), "{value}");
        }
    }

    #[test]
    fn trailing_hash_is_the_glyph() {
        assert_eq!(run("a#").unwrap(), vec!["text a", "text #"]);
    }

    #[test]
    fn held_key_names_one_key() {
        assert_eq!(held_key("+a").unwrap(), (vec![Mod::Shift], Key::Char('a')));
        assert!(held_key("ab").is_err());
        assert!(held_key("{TAB 2}").is_err());
    }
}
