//! The text of the `SyntaxError` V8 raises when `JSON.parse` rejects a string (json-parser.cc of
//! the Node the goldens were recorded on). The message is part of what a user or a model reads
//! when a service answers 200 with something that is not JSON, so it is reproduced exactly:
//! which message V8 picks for which place in the text, the short/"…" context window around an
//! unexpected token, and the position (UTF-16 units) with its line and column.
//!
//! [`crate::json_parse`] decides what parses; this answers why a text does not.

type Failure = String;
type Step = Result<(), Failure>;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Token {
    Eos,
    String,
    Number,
    LBrack,
    LBrace,
    RBrack,
    RBrace,
    Colon,
    Comma,
    True,
    False,
    Null,
    Whitespace,
    Illegal,
}

fn token_of(unit: Option<u16>) -> Token {
    let Some(c) = unit else { return Token::Eos };
    match c {
        0x22 => Token::String,
        0x30..=0x39 | 0x2d => Token::Number,
        0x5b => Token::LBrack,
        0x7b => Token::LBrace,
        0x5d => Token::RBrack,
        0x7d => Token::RBrace,
        0x3a => Token::Colon,
        0x2c => Token::Comma,
        0x74 => Token::True,
        0x66 => Token::False,
        0x6e => Token::Null,
        0x20 | 0x09 | 0x0a | 0x0d => Token::Whitespace,
        _ => Token::Illegal,
    }
}

/// The characters V8 keeps on each side of an unexpected token in the message.
const CONTEXT: usize = 10;

struct Scan<'a> {
    text: &'a str,
    units: Vec<u16>,
    at: usize,
}

fn digit(unit: Option<u16>) -> bool {
    matches!(unit, Some(0x30..=0x39))
}

impl Scan<'_> {
    fn unit(&self) -> Option<u16> {
        self.units.get(self.at).copied()
    }

    fn slice(&self, from: usize, to: usize) -> String {
        String::from_utf16_lossy(&self.units[from..to.min(self.units.len())])
    }

    /// `CalculateFileLocation`: the line and column (1-based) of `pos`; `\r\n` is one break.
    fn location(&self, pos: usize) -> (usize, usize) {
        let (mut line, mut last) = (1, -1_i64);
        for (i, &c) in self.units.iter().enumerate().take(pos) {
            if c == 0x0d && self.units.get(i + 1) == Some(&0x0a) {
                continue;
            }
            if c == 0x0a || c == 0x0d {
                line += 1;
                last = i as i64;
            }
        }
        (line, (pos as i64 - last) as usize)
    }

    fn at_position(&self, message: &str, pos: usize) -> Failure {
        let (line, column) = self.location(pos);
        let place = if message.ends_with("after JSON") { "" } else { " in JSON" };
        format!("{message}{place} at position {pos} (line {line} column {column})")
    }

    /// `ReportUnexpectedToken(token, message)` at `pos`.
    fn unexpected(&self, pos: usize, message: Option<&str>) -> Failure {
        if let Some(message) = message {
            return self.at_position(message, pos);
        }
        match token_of(self.units.get(pos).copied()) {
            Token::Eos => return "Unexpected end of JSON input".to_owned(),
            Token::Number => return self.at_position("Unexpected number", pos),
            Token::String => return self.at_position("Unexpected string", pos),
            _ => {}
        }
        if ["NaN", "Infinity", "undefined", "[object Object]"].contains(&self.text) {
            return format!("\"{}\" is not valid JSON", self.text);
        }
        let shown = String::from_utf16_lossy(&self.units[pos..=pos]);
        let length = self.units.len();
        if length < 2 * CONTEXT + 1 {
            return format!("Unexpected token '{shown}', \"{}\" is not valid JSON", self.text);
        }
        if pos < CONTEXT {
            format!("Unexpected token '{shown}', \"{}\"... is not valid JSON", self.slice(0, pos + CONTEXT))
        } else if pos < length - CONTEXT {
            format!("Unexpected token '{shown}', ...\"{}\"... is not valid JSON", self.slice(pos - CONTEXT, pos + CONTEXT))
        } else {
            format!("Unexpected token '{shown}', ...\"{}\" is not valid JSON", self.slice(pos - CONTEXT, length))
        }
    }

    fn skip_space(&mut self) {
        while matches!(self.unit(), Some(0x20 | 0x09 | 0x0a | 0x0d)) {
            self.at += 1;
        }
    }

    fn peek(&mut self) -> Token {
        self.skip_space();
        token_of(self.unit())
    }

    fn expect(&mut self, token: Token, message: &str) -> Step {
        if self.peek() == token { Ok(()) } else { Err(self.unexpected(self.at, Some(message))) }
    }

    fn string(&mut self) -> Step {
        self.at += 1;
        loop {
            let Some(c) = self.unit() else { return Err(self.at_position("Unterminated string", self.at)) };
            if c == 0x22 {
                self.at += 1;
                return Ok(());
            }
            if c < 0x20 {
                return Err(self.at_position("Bad control character in string literal", self.at));
            }
            if c != 0x5c {
                self.at += 1;
                continue;
            }
            self.at += 1;
            let Some(escape) = self.unit() else { return Err(self.unexpected(self.at, None)) };
            if escape > 0xff {
                return Err(self.unexpected(self.at, None));
            }
            if b"\"\\/bfnrt".contains(&(escape as u8)) {
                self.at += 1;
            } else if escape == 0x75 {
                self.at += 1;
                for _ in 0..4 {
                    if !matches!(self.unit(), Some(0x30..=0x39 | 0x41..=0x46 | 0x61..=0x66)) {
                        return Err(self.at_position("Bad Unicode escape", self.at));
                    }
                    self.at += 1;
                }
            } else {
                return Err(self.at_position("Bad escaped character", self.at));
            }
        }
    }

    fn number(&mut self) -> Step {
        if self.unit() == Some(0x2d) {
            self.at += 1;
            if !digit(self.unit()) {
                return Err(self.at_position("No number after minus sign", self.at));
            }
        }
        if self.unit() == Some(0x30) {
            self.at += 1;
            if digit(self.unit()) {
                return Err(self.at_position("Unexpected number", self.at));
            }
        } else {
            while digit(self.unit()) {
                self.at += 1;
            }
        }
        if self.unit() == Some(0x2e) {
            self.at += 1;
            if !digit(self.unit()) {
                return Err(self.at_position("Unterminated fractional number", self.at));
            }
            while digit(self.unit()) {
                self.at += 1;
            }
        }
        if matches!(self.unit(), Some(0x65 | 0x45)) {
            self.at += 1;
            if matches!(self.unit(), Some(0x2b | 0x2d)) {
                self.at += 1;
            }
            if !digit(self.unit()) {
                return Err(self.at_position("Exponent part is missing a number", self.at));
            }
            while digit(self.unit()) {
                self.at += 1;
            }
        }
        Ok(())
    }

    fn literal(&mut self, word: &str) -> Step {
        for expected in word.bytes() {
            if self.unit() != Some(u16::from(expected)) {
                return Err(self.unexpected(self.at, None));
            }
            self.at += 1;
        }
        Ok(())
    }

    fn value(&mut self) -> Step {
        match self.peek() {
            Token::String => self.string(),
            Token::Number => self.number(),
            Token::True => self.literal("true"),
            Token::False => self.literal("false"),
            Token::Null => self.literal("null"),
            Token::LBrack => {
                self.at += 1;
                if self.peek() == Token::RBrack {
                    self.at += 1;
                    return Ok(());
                }
                loop {
                    self.value()?;
                    if self.peek() == Token::Comma {
                        self.at += 1;
                        continue;
                    }
                    self.expect(Token::RBrack, "Expected ',' or ']' after array element")?;
                    self.at += 1;
                    return Ok(());
                }
            }
            Token::LBrace => {
                self.at += 1;
                if self.peek() == Token::RBrace {
                    self.at += 1;
                    return Ok(());
                }
                self.expect(Token::String, "Expected property name or '}'")?;
                loop {
                    self.string()?;
                    self.expect(Token::Colon, "Expected ':' after property name")?;
                    self.at += 1;
                    self.value()?;
                    if self.peek() == Token::Comma {
                        self.at += 1;
                        self.expect(Token::String, "Expected double-quoted property name")?;
                        continue;
                    }
                    self.expect(Token::RBrace, "Expected ',' or '}' after property value")?;
                    self.at += 1;
                    return Ok(());
                }
            }
            _ => Err(self.unexpected(self.at, None)),
        }
    }
}

/// The message of the `SyntaxError` `JSON.parse(text)` throws, or `None` when `text` parses.
pub fn v8_json_parse_error(text: &str) -> Option<String> {
    let mut scan = Scan { text, units: text.encode_utf16().collect(), at: 0 };
    let outcome = scan.value().and_then(|()| {
        if scan.peek() == Token::Eos { Ok(()) } else { Err(scan.unexpected(scan.at, Some("Unexpected non-whitespace character after JSON"))) }
    });
    outcome.err()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `[input, message]` rows written by Node (`testdata/json_error.mjs`); the first row names
    /// the Node version, a `null` message means the input parses.
    const ROWS: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("testdata/json_error.json");

    #[test]
    fn the_message_is_the_one_node_raises() {
        let rows: Vec<(String, Option<String>)> = serde_json::from_str(&ROWS).expect("fixture");
        assert!(rows.len() > 5000);
        for (input, expected) in &rows[1..] {
            assert_eq!(v8_json_parse_error(input), *expected, "{input:?}");
        }
    }

    #[test]
    fn it_rejects_exactly_what_the_parser_rejects() {
        let rows: Vec<(String, Option<String>)> = serde_json::from_str(&ROWS).expect("fixture");
        for (input, _) in &rows[1..] {
            assert_eq!(v8_json_parse_error(input).is_none(), crate::json_parse(input).is_ok(), "{input:?}");
        }
    }
}