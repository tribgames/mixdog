//! The tokenizer of PDF syntax: pdf.js's `Lexer`. Numbers (with pdf.js's tolerance for `--5`, `5-3`, a lone `.`),
//! literal strings (octal and line-continuation escapes, balanced parentheses), hex strings, names with `#xx`
//! escapes, the delimiters as commands, comments, and the keywords `true`, `false`, `null` and `BI`.

use std::collections::HashMap;
use std::sync::Arc;

use crate::error::{Guard, PdfError, Result};
use crate::object::Obj;
use crate::stream::ByteStream;

/// The argument count of a content-stream operator (`knownCommands` of pdf.js's evaluator): what the inline image
/// end search asks to tell the `EI` that ends an image from image bytes that look like it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandArgs {
    pub num_args: usize,
    pub variable_args: bool,
}

/// The operators the lexer joins greedily (`Lexer.knownCommands`).
pub type KnownCommands = HashMap<String, CommandArgs>;

/// `specialChars[ch]`: 1 for white space (NUL, HT, LF, FF, CR, space), 2 for delimiters, 0 otherwise (and for -1).
pub(crate) fn special_char(ch: i32) -> u8 {
    match ch {
        0 | 9 | 10 | 12 | 13 | 32 => 1,
        0x25 | 0x28 | 0x29 | 0x2f | 0x3c | 0x3e | 0x5b | 0x5d | 0x7b | 0x7d => 2,
        _ => 0,
    }
}

/// `isWhiteSpace`: space, HT, CR, LF.
pub(crate) fn is_white_space(ch: i32) -> bool {
    matches!(ch, 0x20 | 0x09 | 0x0d | 0x0a)
}

/// `toHexDigit`: the value of a hex digit, or -1.
pub(crate) fn to_hex_digit(ch: i32) -> i32 {
    match ch {
        0x30..=0x39 => ch & 0x0f,
        0x41..=0x46 | 0x61..=0x66 => (ch & 0x0f) + 9,
        _ => -1,
    }
}

/// `String.fromCharCode(ch)` for the values the lexer sees: a byte is its Latin-1 char, -1 is U+FFFF.
fn char_of(ch: i32) -> char {
    u8::try_from(ch).map_or('\u{ffff}', char::from)
}

pub struct Lexer {
    pub stream: ByteStream,
    current_char: i32,
    known_commands: Option<Arc<KnownCommands>>,
    hex_string_num_warn: u32,
    /// `beginInlineImagePos`: the stream position after the `BI` token last read.
    pub begin_inline_image_pos: Option<usize>,
    guard: Arc<Guard>,
}

impl Lexer {
    pub fn new(stream: ByteStream, guard: Arc<Guard>) -> Self {
        Lexer::with_known_commands(stream, guard, None)
    }

    pub fn with_known_commands(stream: ByteStream, guard: Arc<Guard>, known_commands: Option<Arc<KnownCommands>>) -> Self {
        let mut lexer = Lexer { stream, current_char: -1, known_commands, hex_string_num_warn: 0, begin_inline_image_pos: None, guard };
        lexer.next_char();
        lexer
    }

    pub fn guard(&self) -> &Arc<Guard> {
        &self.guard
    }

    pub fn known_commands(&self) -> Option<&Arc<KnownCommands>> {
        self.known_commands.as_ref()
    }

    /// `nextChar`: reads the next byte into the current character.
    pub fn next_char(&mut self) -> i32 {
        self.current_char = self.stream.get_byte();
        self.current_char
    }

    pub fn current_char(&self) -> i32 {
        self.current_char
    }

    pub fn peek_char(&self) -> i32 {
        self.stream.peek_byte()
    }

    fn get_number(&mut self) -> Result<Obj> {
        let mut ch = self.current_char;
        let mut divide_by = 0.0_f64;
        let mut sign = 1.0_f64;
        if ch == 0x2d {
            sign = -1.0;
            ch = self.next_char();
            if ch == 0x2d {
                ch = self.next_char();
            }
        } else if ch == 0x2b {
            ch = self.next_char();
        }
        if ch == 0x0a || ch == 0x0d {
            loop {
                ch = self.next_char();
                if ch != 0x0a && ch != 0x0d {
                    break;
                }
            }
        }
        if ch == 0x2e {
            divide_by = 10.0;
            ch = self.next_char();
        }
        if !(0x30..=0x39).contains(&ch) {
            if is_white_space(ch) || ch == 0x28 || ch == 0x3c || ch == -1 {
                tracing::debug!("Lexer.getNumber - \"Invalid number: {} (charCode {ch})\".", char_of(ch));
                return Ok(Obj::Num(0.0));
            }
            return Err(PdfError::format(format!("Invalid number: {} (charCode {ch})", char_of(ch))));
        }
        let mut base_value = f64::from(ch - 0x30);
        loop {
            ch = self.next_char();
            if ch < 0 {
                break;
            }
            self.guard.tick()?;
            if (0x30..=0x39).contains(&ch) {
                let current_digit = f64::from(ch - 0x30);
                if divide_by != 0.0 {
                    divide_by *= 10.0;
                }
                base_value = base_value * 10.0 + current_digit;
            } else if ch == 0x2e {
                if divide_by == 0.0 {
                    divide_by = 1.0;
                } else {
                    break;
                }
            } else if ch == 0x2d {
                tracing::warn!("Badly formatted number: minus sign in the middle");
            } else {
                break;
            }
        }
        if divide_by != 0.0 {
            base_value /= divide_by;
        }
        Ok(Obj::Num(sign * base_value))
    }

    fn get_string(&mut self) -> Result<Obj> {
        let mut num_paren = 1;
        let mut done = false;
        let mut buf: Vec<u8> = Vec::new();
        let mut ch = self.next_char();
        loop {
            self.guard.tick()?;
            let mut char_buffered = false;
            match ch {
                -1 => {
                    tracing::warn!("Unterminated string");
                    done = true;
                }
                0x28 => {
                    num_paren += 1;
                    buf.push(b'(');
                }
                0x29 => {
                    num_paren -= 1;
                    if num_paren == 0 {
                        self.next_char();
                        done = true;
                    } else {
                        buf.push(b')');
                    }
                }
                0x5c => {
                    ch = self.next_char();
                    match ch {
                        -1 => {
                            tracing::warn!("Unterminated string");
                            done = true;
                        }
                        0x6e => buf.push(b'\n'),
                        0x72 => buf.push(b'\r'),
                        0x74 => buf.push(b'\t'),
                        0x62 => buf.push(0x08),
                        0x66 => buf.push(0x0c),
                        0x5c | 0x28 | 0x29 => buf.push(ch as u8),
                        0x30..=0x37 => {
                            let mut x = ch & 0x0f;
                            ch = self.next_char();
                            char_buffered = true;
                            if (0x30..=0x37).contains(&ch) {
                                x = (x << 3) + (ch & 0x0f);
                                ch = self.next_char();
                                if (0x30..=0x37).contains(&ch) {
                                    char_buffered = false;
                                    x = (x << 3) + (ch & 0x0f);
                                }
                            }
                            // `\777` is 511 in pdf.js's string and a byte of 0xFF once read as bytes.
                            buf.push((x & 0xff) as u8);
                        }
                        0x0d => {
                            if self.peek_char() == 0x0a {
                                self.next_char();
                            }
                        }
                        0x0a => {}
                        _ => buf.push(ch as u8),
                    }
                }
                _ => buf.push(ch as u8),
            }
            if done {
                break;
            }
            if !char_buffered {
                ch = self.next_char();
            }
        }
        Ok(Obj::Str(Arc::from(buf)))
    }

    fn get_name(&mut self) -> Result<Obj> {
        let mut buf = String::new();
        loop {
            let mut ch = self.next_char();
            if ch < 0 || special_char(ch) != 0 {
                break;
            }
            self.guard.tick()?;
            if ch == 0x23 {
                ch = self.next_char();
                if special_char(ch) != 0 {
                    tracing::warn!("Lexer_getName: NUMBER SIGN (#) should be followed by a hexadecimal number.");
                    buf.push('#');
                    break;
                }
                let x = to_hex_digit(ch);
                if x != -1 {
                    let previous_ch = ch;
                    ch = self.next_char();
                    let x2 = to_hex_digit(ch);
                    if x2 == -1 {
                        tracing::warn!("Lexer_getName: Illegal digit ({}) in hexadecimal number.", char_of(ch));
                        buf.push('#');
                        buf.push(char_of(previous_ch));
                        if special_char(ch) != 0 {
                            break;
                        }
                        buf.push(char_of(ch));
                        continue;
                    }
                    buf.push(char_of((x << 4) | x2));
                } else {
                    buf.push('#');
                    buf.push(char_of(ch));
                }
            } else {
                buf.push(char_of(ch));
            }
        }
        if buf.chars().count() > 127 {
            tracing::warn!("Name token is longer than allowed by the spec: {}", buf.chars().count());
        }
        Ok(Obj::Name(Arc::from(buf)))
    }

    fn hex_string_warn(&mut self, ch: i32) {
        const MAX_HEX_STRING_NUM_WARN: u32 = 5;
        let seen = self.hex_string_num_warn;
        self.hex_string_num_warn += 1;
        if seen == MAX_HEX_STRING_NUM_WARN {
            tracing::warn!("getHexString - ignoring additional invalid characters.");
        } else if seen < MAX_HEX_STRING_NUM_WARN {
            tracing::warn!("getHexString - ignoring invalid character: {ch}");
        }
    }

    fn get_hex_string(&mut self) -> Result<Obj> {
        let mut buf: Vec<u8> = Vec::new();
        let mut ch = self.current_char;
        let mut first_digit = -1;
        self.hex_string_num_warn = 0;
        loop {
            self.guard.tick()?;
            if ch < 0 {
                tracing::warn!("Unterminated hex string");
                break;
            } else if ch == 0x3e {
                self.next_char();
                break;
            } else if special_char(ch) == 1 {
                ch = self.next_char();
                continue;
            }
            let digit = to_hex_digit(ch);
            if digit == -1 {
                self.hex_string_warn(ch);
            } else if first_digit == -1 {
                first_digit = digit;
            } else {
                buf.push(((first_digit << 4) | digit) as u8);
                first_digit = -1;
            }
            ch = self.next_char();
        }
        if first_digit != -1 {
            buf.push((first_digit << 4) as u8);
        }
        Ok(Obj::Str(Arc::from(buf)))
    }

    /// `getObj`: the next token (`Obj::Eof` at the end). Delimiters and keywords come back as [`Obj::Cmd`].
    pub fn get_obj(&mut self) -> Result<Obj> {
        let mut comment = false;
        let mut ch = self.current_char;
        loop {
            self.guard.tick()?;
            if ch < 0 {
                return Ok(Obj::Eof);
            }
            if comment {
                if ch == 0x0a || ch == 0x0d {
                    comment = false;
                }
            } else if ch == 0x25 {
                comment = true;
            } else if special_char(ch) != 1 {
                break;
            }
            ch = self.next_char();
        }
        match ch {
            0x30..=0x39 | 0x2b | 0x2d | 0x2e => return self.get_number(),
            0x28 => return self.get_string(),
            0x2f => return self.get_name(),
            0x5b => {
                self.next_char();
                return Ok(Obj::cmd("["));
            }
            0x5d => {
                self.next_char();
                return Ok(Obj::cmd("]"));
            }
            0x3c => {
                ch = self.next_char();
                if ch == 0x3c {
                    self.next_char();
                    return Ok(Obj::cmd("<<"));
                }
                return self.get_hex_string();
            }
            0x3e => {
                ch = self.next_char();
                if ch == 0x3e {
                    self.next_char();
                    return Ok(Obj::cmd(">>"));
                }
                return Ok(Obj::cmd(">"));
            }
            0x7b => {
                self.next_char();
                return Ok(Obj::cmd("{"));
            }
            0x7d => {
                self.next_char();
                return Ok(Obj::cmd("}"));
            }
            0x29 => {
                self.next_char();
                return Err(PdfError::format(format!("Illegal character: {ch}")));
            }
            _ => {}
        }
        let mut token = String::new();
        token.push(char_of(ch));
        if !(0x20..=0x7f).contains(&ch) {
            let next_ch = self.peek_char();
            if (0x20..=0x7f).contains(&next_ch) {
                self.next_char();
                return Ok(Obj::Cmd(Arc::from(token)));
            }
        }
        let known = self.known_commands.clone();
        let is_known = |s: &str| known.as_ref().is_some_and(|k| k.contains_key(s));
        let mut known_command_found = is_known(&token);
        loop {
            ch = self.next_char();
            if ch < 0 || special_char(ch) != 0 {
                break;
            }
            self.guard.tick()?;
            let mut possible = token.clone();
            possible.push(char_of(ch));
            if known_command_found && !is_known(&possible) {
                break;
            }
            if token.chars().count() == 128 {
                return Err(PdfError::format(format!("Command token too long: {}", token.chars().count())));
            }
            token = possible;
            known_command_found = is_known(&token);
        }
        match token.as_str() {
            "true" => return Ok(Obj::Bool(true)),
            "false" => return Ok(Obj::Bool(false)),
            "null" => return Ok(Obj::Null),
            "BI" => self.begin_inline_image_pos = Some(self.stream.pos),
            _ => {}
        }
        Ok(Obj::Cmd(Arc::from(token)))
    }

    /// `skipToNextLine`: past the next end of line (CR, LF or CRLF).
    pub fn skip_to_next_line(&mut self) {
        let mut ch = self.current_char;
        while ch >= 0 {
            if ch == 0x0d {
                ch = self.next_char();
                if ch == 0x0a {
                    self.next_char();
                }
                break;
            } else if ch == 0x0a {
                self.next_char();
                break;
            }
            ch = self.next_char();
        }
    }
}
