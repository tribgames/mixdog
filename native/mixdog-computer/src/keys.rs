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
    /// A key named by a character: the unshifted character the key types on
    /// a US layout.
    Char(char),
    /// The virtual key the keyboard layout resolved a character to when the
    /// stream was validated. It is sent as is, so a later layout switch
    /// cannot change the key a press or its release names.
    Vk(u16),
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
    /// The virtual key and modifiers that type `glyph` on this keyboard's
    /// layout (`Desktop::resolve_glyph`); None leaves the US table to decide.
    fn resolve_glyph(&self, _glyph: char) -> Option<(u16, Vec<Mod>)> {
        None
    }
}

/// A keyboard layout, as `KeySink::resolve_glyph` answers it.
pub type Layout<'a> = &'a dyn Fn(char) -> Option<(u16, Vec<Mod>)>;

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

/// NamedVirtualKey (MixWin32Keyboard.cs:400-437). An unknown token is refused
/// as `invalid_keys`: the C# worker answered `background_unsupported` even for
/// a foreground key, a code that names the wrong cause. {CMD}, {COMMAND},
/// {SUPER} and {META} name the system key on every platform.
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
                None => return Err(format!("invalid_keys: unsupported key token {{{other}}}")),
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

struct Parser {
    source: Vec<char>,
    at: usize,
    cost: u32,
}

impl Parser {
    fn new(value: &str) -> Result<Parser, String> {
        let source: Vec<char> = value.chars().collect();
        if value.encode_utf16().count() > 512 {
            return invalid();
        }
        Ok(Parser {
            source,
            at: 0,
            cost: 0,
        })
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
            let mut node = Node {
                repeat: 1,
                ..Node::default()
            };
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

/// ResolveTextKey (TaggedKeys.cs:155-170): a character becomes a key through
/// the keyboard layout, which may demand modifiers the caller never wrote. A
/// glyph the layout does not map falls back to the US table.
fn resolve_text_key(
    node: &mut Node,
    modifiers: &HashSet<Mod>,
    layout: Layout,
) -> Result<(), String> {
    let glyph = node
        .text
        .as_ref()
        .and_then(|text| text.chars().next())
        .ok_or_else(|| "invalid_keys: empty key".to_string())?;
    let (key, mut implied) = match layout(glyph) {
        Some((vk, implied)) => (Key::Vk(vk), implied),
        None => {
            let (base, shifted) = glyph_key(glyph).ok_or_else(|| {
                "invalid_keys: character has no modified-key mapping".to_string()
            })?;
            let implied = if shifted { vec![Mod::Shift] } else { Vec::new() };
            (Key::Char(base), implied)
        }
    };
    // A letter's case names the key, not a shift: '^S' and '^s' are both Ctrl+S.
    if glyph.is_ascii_alphabetic() {
        implied.retain(|modifier| *modifier != Mod::Shift);
    }
    node.key = Some(key);
    node.text = None;
    for modifier in implied {
        if !modifiers.contains(&modifier) {
            node.modifiers.push(modifier);
        }
    }
    Ok(())
}

/// Chords that end the user's session or app without a question
/// (Validate, TaggedKeys.cs:102-121). A glyph the layout put on the L key is
/// the same chord as the letter.
fn blocked(key: Key, modifiers: &HashSet<Mod>) -> Option<&'static str> {
    if key == Key::Named(Named::F(4)) && modifiers.contains(&Mod::Alt) {
        return Some("unsafe_key: Alt+F4 is blocked");
    }
    if !modifiers.contains(&Mod::Super) {
        return None;
    }
    if cfg!(target_os = "macos") {
        if key == Key::Char('q') {
            return Some("unsafe_key: Command+Q is blocked");
        }
    } else if key == Key::Vk(0x4C) || key == Key::Char('l') {
        return Some(if cfg!(windows) {
            "unsafe_key: Win+L is blocked"
        } else {
            "unsafe_key: Super+L is blocked"
        });
    }
    None
}

fn validate(nodes: &mut [Node], inherited: &HashSet<Mod>, layout: Layout) -> Result<(), String> {
    for node in nodes.iter_mut() {
        let mut modifiers = inherited.clone();
        modifiers.extend(node.modifiers.iter().copied());
        if let Some(children) = node.children.as_mut() {
            validate(children, &modifiers, layout)?;
        } else if node.text.is_some() && !modifiers.is_empty() {
            resolve_text_key(node, &modifiers, layout)?;
        }
        // Checked after a character resolves to its key, so a chord cannot
        // slip past as text.
        if let Some(key) = node.key {
            if let Some(reason) = blocked(key, &modifiers) {
                return Err(reason.into());
            }
        }
    }
    Ok(())
}

/// Releases every key, whatever fails on the way; the first failure is the
/// one reported (Execute's finally, TaggedKeys.cs:141-151).
fn release(keys: impl Iterator<Item = Key>, sink: &mut dyn KeySink) -> Result<(), String> {
    let mut failure = None;
    for key in keys {
        if let Err(error) = sink.up(key) {
            failure.get_or_insert(error);
        }
    }
    match failure {
        Some(error) => Err(format!(
            "input_cleanup_unconfirmed: key release failed: {error}"
        )),
        None => Ok(()),
    }
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
        let released = release(
            pressed.iter().rev().map(|modifier| Key::Mod(*modifier)),
            sink,
        );
        for modifier in &pressed {
            held.remove(modifier);
        }
        released?;
        outcome?;
    }
    Ok(())
}

pub fn send(value: &str, sink: &mut dyn KeySink) -> Result<(), String> {
    let mut nodes = Parser::new(value)?.parse(0, false)?;
    validate(&mut nodes, &HashSet::new(), &|glyph| sink.resolve_glyph(glyph))?;
    execute(&nodes, sink, &mut HashSet::new())
}

/// The single key and its modifiers a held stream names.
pub fn held_key(value: &str, layout: Layout) -> Result<(Vec<Mod>, Key), String> {
    let mut nodes = Parser::new(value)?.parse(0, false)?;
    validate(&mut nodes, &HashSet::new(), layout)?;
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
        resolve_text_key(&mut node, &HashSet::new(), layout)?;
    }
    let key = node
        .key
        .ok_or_else(|| "invalid_keys: a held key must name exactly one key".to_string())?;
    Ok((node.modifiers, key))
}

/// Presses a held key (Hold down, TaggedKeys.cs:173-200). A press that fails
/// part way lets go of the modifiers it already pressed.
pub fn press(modifiers: &[Mod], key: Key, sink: &mut dyn KeySink) -> Result<(), String> {
    for (pressed, modifier) in modifiers.iter().enumerate() {
        if let Err(error) = sink.down(Key::Mod(*modifier)) {
            // Tracked before dispatch, as Execute does: a failed down may
            // still have landed.
            release(modifiers[..=pressed].iter().rev().map(|m| Key::Mod(*m)), sink)?;
            return Err(error);
        }
    }
    if let Err(error) = sink.down(key) {
        release(modifiers.iter().rev().map(|m| Key::Mod(*m)), sink)?;
        return Err(error);
    }
    Ok(())
}

/// Lets go of a held key, then its modifiers in reverse (Hold up). A release
/// that fails still releases the rest and answers `input_cleanup_unconfirmed`,
/// as Execute does.
pub fn lift(modifiers: &[Mod], key: Key, sink: &mut dyn KeySink) -> Result<(), String> {
    let modifiers = modifiers.iter().rev().map(|modifier| Key::Mod(*modifier));
    release(std::iter::once(key).chain(modifiers), sink)
}

/// Whether a stream is plain text rather than grammar: one character, or no
/// grammar characters at all.
pub fn is_plain_text(value: &str) -> bool {
    value.chars().count() == 1 || !value.chars().any(|c| "{}^%+~()#".contains(c))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// FakeKeySink of backend/tagged-keys.test.mjs: every event is logged
    /// before it fails.
    #[derive(Default)]
    struct Log {
        events: Vec<String>,
        fail_tap: bool,
        fail_up: Option<Key>,
        layout: Option<fn(char) -> Option<(u16, Vec<Mod>)>>,
    }
    impl KeySink for Log {
        fn down(&mut self, key: Key) -> Result<(), String> {
            self.events.push(format!("down {key:?}"));
            Ok(())
        }
        fn up(&mut self, key: Key) -> Result<(), String> {
            self.events.push(format!("up {key:?}"));
            if self.fail_up == Some(key) {
                return Err("release".into());
            }
            Ok(())
        }
        fn tap(&mut self, key: Key) -> Result<(), String> {
            self.events.push(format!("tap {key:?}"));
            if self.fail_tap {
                return Err("interrupt".into());
            }
            Ok(())
        }
        fn text(&mut self, text: &str) -> Result<(), String> {
            self.events.push(format!("text {text}"));
            Ok(())
        }
        fn resolve_glyph(&self, glyph: char) -> Option<(u16, Vec<Mod>)> {
            self.layout.and_then(|layout| layout(glyph))
        }
    }

    /// A German layout's punctuation, as VkKeyScanExW answers it, and a
    /// Cyrillic letter that sits on the L key.
    fn german(glyph: char) -> Option<(u16, Vec<Mod>)> {
        match glyph {
            '/' => Some((0x37, vec![Mod::Shift])),
            '@' => Some((0x51, vec![Mod::Ctrl, Mod::Alt])),
            'S' => Some((0x53, vec![Mod::Shift])),
            's' => Some((0x53, Vec::new())),
            'д' => Some((0x4C, Vec::new())),
            _ => None,
        }
    }

    fn sent(value: &str, mut log: Log) -> (Result<(), String>, Vec<String>) {
        let outcome = send(value, &mut log);
        (outcome, log.events)
    }

    /// No layout is read: the US table decides.
    fn us(value: &str) -> (Result<(), String>, Vec<String>) {
        sent(value, Log::default())
    }

    fn on_german(value: &str) -> (Result<(), String>, Vec<String>) {
        sent(
            value,
            Log {
                layout: Some(german),
                ..Log::default()
            },
        )
    }

    fn run(value: &str) -> Result<Vec<String>, String> {
        let (outcome, events) = us(value);
        outcome.map(|()| events)
    }

    #[test]
    fn groups_repeats_and_literal_escapes_keep_their_order() {
        assert_eq!(
            run("^(ab){TAB 2}{+}{{}{}}~").unwrap(),
            vec![
                "down Mod(Ctrl)",
                "tap Char('a')",
                "tap Char('b')",
                "up Mod(Ctrl)",
                "tap Named(Tab)",
                "tap Named(Tab)",
                "text +",
                "text {",
                "text }",
                "tap Named(Enter)",
            ]
        );
    }

    #[test]
    fn a_letters_case_names_the_key_not_a_shift() {
        assert_eq!(
            run("^S").unwrap(),
            vec!["down Mod(Ctrl)", "tap Char('s')", "up Mod(Ctrl)"]
        );
        assert_eq!(
            run("^+s").unwrap(),
            vec![
                "down Mod(Ctrl)",
                "down Mod(Shift)",
                "tap Char('s')",
                "up Mod(Shift)",
                "up Mod(Ctrl)",
            ]
        );
    }

    #[test]
    fn a_glyph_that_needs_shift_brings_it() {
        assert_eq!(
            run("^?").unwrap(),
            vec![
                "down Mod(Ctrl)",
                "down Mod(Shift)",
                "tap Char('/')",
                "up Mod(Shift)",
                "up Mod(Ctrl)",
            ]
        );
    }

    #[test]
    fn hash_holds_the_system_key_and_alone_is_the_glyph() {
        assert_eq!(
            run("#r").unwrap(),
            vec!["down Mod(Super)", "tap Char('r')", "up Mod(Super)"]
        );
        assert_eq!(
            run("^#{RIGHT}").unwrap(),
            vec![
                "down Mod(Ctrl)",
                "down Mod(Super)",
                "tap Named(Right)",
                "up Mod(Super)",
                "up Mod(Ctrl)",
            ]
        );
        assert_eq!(run("#").unwrap(), vec!["text #"]);
        assert_eq!(run("a#").unwrap(), vec!["text a", "text #"]);
        assert_eq!(run("{LWIN}").unwrap(), vec!["tap Mod(Super)"]);
        assert_eq!(run("{cmd}").unwrap(), vec!["tap Mod(Super)"]);
    }

    #[test]
    fn plain_characters_are_text() {
        assert_eq!(run("ab").unwrap(), vec!["text a", "text b"]);
    }

    #[test]
    fn groups_share_modifiers() {
        assert_eq!(
            run("+(ab)").unwrap(),
            vec![
                "down Mod(Shift)",
                "tap Char('a')",
                "tap Char('b')",
                "up Mod(Shift)",
            ]
        );
    }

    #[test]
    fn invalid_streams_emit_nothing() {
        let malformed = "invalid_keys: malformed or excessive key stream";
        for value in ["a{TAB 101}", "abc(", "text^", "^", "a)", "{ENTER", "^^a"] {
            let (outcome, events) = us(value);
            assert_eq!(outcome.unwrap_err(), malformed, "{value}");
            assert!(events.is_empty(), "{value}");
        }
        for value in ["x%{F4}", "%(ab{F4})"] {
            let (outcome, events) = us(value);
            assert_eq!(outcome.unwrap_err(), "unsafe_key: Alt+F4 is blocked", "{value}");
            assert!(events.is_empty(), "{value}");
        }
        let (outcome, events) = us("a{NOPE}");
        assert_eq!(
            outcome.unwrap_err(),
            "invalid_keys: unsupported key token {NOPE}"
        );
        assert!(events.is_empty());
        let (outcome, events) = us("a^é");
        assert_eq!(
            outcome.unwrap_err(),
            "invalid_keys: character has no modified-key mapping"
        );
        assert!(events.is_empty());
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn the_lock_chord_is_refused_on_the_resolved_key() {
        let reason = if cfg!(windows) {
            "unsafe_key: Win+L is blocked"
        } else {
            "unsafe_key: Super+L is blocked"
        };
        let run: [(&str, fn(&str) -> (Result<(), String>, Vec<String>)); 4] = [
            ("#l", us),
            ("+#L", us),
            ("#(al)", us),
            // No Latin letter is written, but the glyph sits on the L key.
            ("a#д", on_german),
        ];
        for (value, send) in run {
            let (outcome, events) = send(value);
            assert_eq!(outcome.unwrap_err(), reason, "{value}");
            assert!(events.is_empty(), "{value}");
        }
    }

    #[test]
    fn a_failing_tap_and_release_still_release_every_modifier() {
        let mut log = Log {
            fail_tap: true,
            fail_up: Some(Key::Mod(Mod::Alt)),
            ..Log::default()
        };
        let error = send("^%a", &mut log).unwrap_err();
        assert_eq!(error, "input_cleanup_unconfirmed: key release failed: release");
        assert_eq!(
            log.events,
            vec![
                "down Mod(Ctrl)",
                "down Mod(Alt)",
                "tap Char('a')",
                "up Mod(Alt)",
                "up Mod(Ctrl)",
            ]
        );
    }

    #[test]
    fn the_layout_names_the_key_and_its_modifiers() {
        // German: '/' is Shift+7, '@' is AltGr+Q (Ctrl+Alt).
        assert_eq!(
            on_german("^/").1,
            vec![
                "down Mod(Ctrl)",
                "down Mod(Shift)",
                "tap Vk(55)",
                "up Mod(Shift)",
                "up Mod(Ctrl)",
            ]
        );
        assert_eq!(
            on_german("^@").1,
            vec![
                "down Mod(Ctrl)",
                "down Mod(Alt)",
                "tap Vk(81)",
                "up Mod(Alt)",
                "up Mod(Ctrl)",
            ]
        );
        // A modifier the caller wrote, here or on the group, is not pressed twice.
        assert_eq!(
            on_german("+(^/)").1,
            vec![
                "down Mod(Shift)",
                "down Mod(Ctrl)",
                "tap Vk(55)",
                "up Mod(Ctrl)",
                "up Mod(Shift)",
            ]
        );
        // The layout's Shift for a capital letter is dropped like the US table's.
        assert_eq!(
            on_german("^S").1,
            vec!["down Mod(Ctrl)", "tap Vk(83)", "up Mod(Ctrl)"]
        );
        // A glyph the layout does not map falls back to the US table.
        assert_eq!(
            on_german("^!").1,
            vec![
                "down Mod(Ctrl)",
                "down Mod(Shift)",
                "tap Char('1')",
                "up Mod(Shift)",
                "up Mod(Ctrl)",
            ]
        );
    }

    #[test]
    fn held_key_names_one_key() {
        assert_eq!(
            held_key("+a", &|_| None).unwrap(),
            (vec![Mod::Shift], Key::Char('a'))
        );
        assert_eq!(
            held_key("@", &german).unwrap(),
            (vec![Mod::Ctrl, Mod::Alt], Key::Vk(0x51))
        );
        assert_eq!(
            held_key("ab", &|_| None).unwrap_err(),
            "invalid_keys: a held key must name exactly one key"
        );
        assert_eq!(
            held_key("{TAB 2}", &|_| None).unwrap_err(),
            "invalid_keys: a held key cannot be a group or a repeat"
        );
    }

    fn hold(value: &str, down: bool, log: &mut Log) -> Result<(), String> {
        let (modifiers, key) = held_key(value, &|glyph| log.resolve_glyph(glyph))?;
        if down {
            press(&modifiers, key, log)
        } else {
            lift(&modifiers, key, log)
        }
    }

    #[test]
    fn a_modifier_named_alone_is_held_and_released() {
        let mut log = Log::default();
        hold("{SHIFT}", true, &mut log).unwrap();
        hold("{SHIFT}", false, &mut log).unwrap();
        assert_eq!(log.events, vec!["down Mod(Shift)", "up Mod(Shift)"]);
    }

    #[test]
    fn a_held_chord_releases_in_reverse_and_reports_a_failed_release() {
        let mut log = Log {
            fail_up: Some(Key::Char('a')),
            ..Log::default()
        };
        hold("^+a", true, &mut log).unwrap();
        let error = hold("^+a", false, &mut log).unwrap_err();
        assert_eq!(error, "input_cleanup_unconfirmed: key release failed: release");
        assert_eq!(
            log.events,
            vec![
                "down Mod(Ctrl)",
                "down Mod(Shift)",
                "down Char('a')",
                "up Char('a')",
                "up Mod(Shift)",
                "up Mod(Ctrl)",
            ]
        );
    }

    /// A sink whose key down fails for one key.
    struct FailDown(Log, Key);
    impl KeySink for FailDown {
        fn down(&mut self, key: Key) -> Result<(), String> {
            self.0.down(key)?;
            if key == self.1 {
                return Err("press".into());
            }
            Ok(())
        }
        fn up(&mut self, key: Key) -> Result<(), String> {
            self.0.up(key)
        }
        fn text(&mut self, text: &str) -> Result<(), String> {
            self.0.text(text)
        }
    }

    #[test]
    fn a_held_press_that_fails_lets_go_of_its_modifiers() {
        let mut sink = FailDown(Log::default(), Key::Char('a'));
        let error = press(&[Mod::Ctrl, Mod::Alt], Key::Char('a'), &mut sink).unwrap_err();
        assert_eq!(error, "press");
        assert_eq!(
            sink.0.events,
            vec![
                "down Mod(Ctrl)",
                "down Mod(Alt)",
                "down Char('a')",
                "up Mod(Alt)",
                "up Mod(Ctrl)",
            ]
        );
        let mut sink = FailDown(Log::default(), Key::Mod(Mod::Alt));
        press(&[Mod::Ctrl, Mod::Alt], Key::Char('a'), &mut sink).unwrap_err();
        assert_eq!(
            sink.0.events,
            vec!["down Mod(Ctrl)", "down Mod(Alt)", "up Mod(Alt)", "up Mod(Ctrl)"]
        );
    }

    #[test]
    fn a_held_key_is_released_as_it_was_pressed() {
        // '@' pressed on a German layout is released as AltGr+Q whatever
        // layout is in front by then.
        let (modifiers, key) = held_key("@", &german).unwrap();
        let mut log = Log::default();
        lift(&modifiers, key, &mut log).unwrap();
        assert_eq!(log.events, vec!["up Vk(81)", "up Mod(Alt)", "up Mod(Ctrl)"]);
    }
}
