//! V8's `Date.parse` text reader (the ES5 date-time string plus the legacy, Safari-compatible
//! fallback), in V8's own tokenizer and composer structure. It yields calendar fields; the
//! caller turns them into a time value. Input is read as UTF-16 code units and ends at the
//! first NUL, as V8 reads it.

/// Marks a missing value (`kMaxInt`).
const NONE: i32 = i32::MAX;
/// Digits of a numeral that count; the rest are skipped.
const MAX_SIGNIFICANT_DIGITS: usize = 9;

/// The fields of a parsed date. `month` is 1-based; `utc_offset_secs` is `None` when the text
/// names no zone (local time, or UTC for a date-only ISO string).
pub(crate) struct Parsed {
    pub year: i32,
    pub month: i32,
    pub day: i32,
    pub hour: i32,
    pub minute: i32,
    pub second: i32,
    pub millisecond: i32,
    pub utc_offset_secs: Option<i32>,
}

fn between(x: i32, lo: i32, hi: i32) -> bool {
    (x.wrapping_sub(lo) as u32) <= (hi - lo) as u32
}

fn is_minute(x: i32) -> bool {
    between(x, 0, 59)
}
fn is_hour(x: i32) -> bool {
    between(x, 0, 23)
}
fn is_second(x: i32) -> bool {
    between(x, 0, 59)
}
fn is_month(x: i32) -> bool {
    between(x, 1, 12)
}
fn is_day(x: i32) -> bool {
    between(x, 1, 31)
}

/// `WhiteSpace` (not the line terminators).
fn is_white_space(c: u32) -> bool {
    matches!(c, 0x09 | 0x0b | 0x0c | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

fn is_white_space_or_line_terminator(c: u32) -> bool {
    is_white_space(c) || matches!(c, 0x0a | 0x0d | 0x2028 | 0x2029)
}

struct Reader {
    units: Vec<u16>,
    i: usize,
}

impl Reader {
    fn ch(&self) -> u32 {
        self.units.get(self.i).map_or(0, |&u| u32::from(u))
    }
    fn next(&mut self) {
        self.i += 1;
    }
    fn is_end(&self) -> bool {
        self.ch() == 0
    }
    fn is_digit(&self) -> bool {
        (u32::from(b'0')..=u32::from(b'9')).contains(&self.ch())
    }
    fn is_alpha_or_above(&self) -> bool {
        self.ch() >= u32::from(b'A')
    }
    fn skip(&mut self, c: u8) -> bool {
        let hit = self.ch() == u32::from(c);
        if hit {
            self.next();
        }
        hit
    }

    fn read_unsigned_numeral(&mut self) -> i32 {
        let (mut n, mut digits) = (0i32, 0usize);
        while self.ch() == u32::from(b'0') {
            self.next();
        }
        while self.is_digit() {
            if digits < MAX_SIGNIFICANT_DIGITS {
                n = n * 10 + (self.ch() - u32::from(b'0')) as i32;
            }
            digits += 1;
            self.next();
        }
        n
    }

    /// A word: a run of characters >= 'A' that are not white space. Returns its lower-cased
    /// three-character prefix (zero padded) and its length.
    fn read_word(&mut self) -> ([u32; 3], usize) {
        let mut prefix = [0u32; 3];
        let mut len = 0;
        while self.is_alpha_or_above() && !is_white_space(self.ch()) {
            if len < 3 {
                prefix[len] = self.ch() | 0x20;
            }
            self.next();
            len += 1;
        }
        (prefix, len)
    }

    fn skip_white_space(&mut self) -> bool {
        let hit = is_white_space_or_line_terminator(self.ch());
        if hit {
            self.next();
        }
        hit
    }

    fn skip_parentheses(&mut self) -> bool {
        if self.ch() != u32::from(b'(') {
            return false;
        }
        let mut balance = 0;
        loop {
            if self.ch() == u32::from(b')') {
                balance -= 1;
            } else if self.ch() == u32::from(b'(') {
                balance += 1;
            }
            self.next();
            if !(balance > 0 && self.ch() != 0) {
                return true;
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kw {
    Invalid,
    Month,
    Zone,
    TimeSeparator,
    AmPm,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Tok {
    Invalid,
    Unknown,
    WhiteSpace,
    Number { value: i32, len: i32 },
    Symbol(u8),
    End,
    Keyword { kind: Kw, value: i32, len: i32 },
}

impl Tok {
    fn is_number(self) -> bool {
        matches!(self, Tok::Number { .. })
    }
    fn is_end(self) -> bool {
        self == Tok::End
    }
    fn is_symbol(self, c: u8) -> bool {
        self == Tok::Symbol(c)
    }
    fn is_ascii_sign(self) -> bool {
        self.is_symbol(b'-') || self.is_symbol(b'+')
    }
    /// `+` is 1, `-` is -1.
    fn ascii_sign(self) -> i32 {
        match self {
            Tok::Symbol(c) => 44 - i32::from(c),
            _ => 0,
        }
    }
    fn number(self) -> i32 {
        match self {
            Tok::Number { value, .. } => value,
            _ => 0,
        }
    }
    fn is_fixed_length_number(self, n: i32) -> bool {
        matches!(self, Tok::Number { len, .. } if len == n)
    }
    fn is_keyword_type(self, k: Kw) -> bool {
        matches!(self, Tok::Keyword { kind, .. } if kind == k)
    }
    fn is_keyword_z(self) -> bool {
        matches!(self, Tok::Keyword { kind: Kw::Zone, len: 1, value: 0 })
    }
}

/// Month names, am/pm, zone names and the ISO `T`, by their three-letter prefix.
const KEYWORDS: [([u8; 3], Kw, i32); 27] = [
    (*b"jan", Kw::Month, 1),
    (*b"feb", Kw::Month, 2),
    (*b"mar", Kw::Month, 3),
    (*b"apr", Kw::Month, 4),
    (*b"may", Kw::Month, 5),
    (*b"jun", Kw::Month, 6),
    (*b"jul", Kw::Month, 7),
    (*b"aug", Kw::Month, 8),
    (*b"sep", Kw::Month, 9),
    (*b"oct", Kw::Month, 10),
    (*b"nov", Kw::Month, 11),
    (*b"dec", Kw::Month, 12),
    (*b"am\0", Kw::AmPm, 0),
    (*b"pm\0", Kw::AmPm, 12),
    (*b"ut\0", Kw::Zone, 0),
    (*b"utc", Kw::Zone, 0),
    (*b"z\0\0", Kw::Zone, 0),
    (*b"gmt", Kw::Zone, 0),
    (*b"cdt", Kw::Zone, -5),
    (*b"cst", Kw::Zone, -6),
    (*b"edt", Kw::Zone, -4),
    (*b"est", Kw::Zone, -5),
    (*b"mdt", Kw::Zone, -6),
    (*b"mst", Kw::Zone, -7),
    (*b"pdt", Kw::Zone, -7),
    (*b"pst", Kw::Zone, -8),
    (*b"t\0\0", Kw::TimeSeparator, 0),
];

/// A word longer than its keyword only matches a month name.
fn keyword(prefix: [u32; 3], len: usize) -> (Kw, i32) {
    KEYWORDS
        .iter()
        .find(|(name, kind, _)| {
            prefix.iter().zip(name).all(|(&p, &n)| p == u32::from(n)) && (len <= 3 || *kind == Kw::Month)
        })
        .map_or((Kw::Invalid, 0), |&(_, kind, value)| (kind, value))
}

struct Scanner {
    reader: Reader,
    next: Tok,
}

impl Scanner {
    fn new(reader: Reader) -> Self {
        let mut scanner = Scanner { reader, next: Tok::End };
        scanner.next = scanner.scan();
        scanner
    }

    fn next(&mut self) -> Tok {
        let result = self.next;
        self.next = self.scan();
        result
    }

    fn peek(&self) -> Tok {
        self.next
    }

    fn skip_symbol(&mut self, c: u8) -> bool {
        let hit = self.next.is_symbol(c);
        if hit {
            self.next = self.scan();
        }
        hit
    }

    fn scan(&mut self) -> Tok {
        let r = &mut self.reader;
        let start = r.i;
        if r.is_end() {
            return Tok::End;
        }
        if r.is_digit() {
            let value = r.read_unsigned_numeral();
            return Tok::Number { value, len: (r.i - start) as i32 };
        }
        for symbol in [b':', b'-', b'+', b'.', b')'] {
            if r.skip(symbol) {
                return Tok::Symbol(symbol);
            }
        }
        if r.is_alpha_or_above() && !is_white_space(r.ch()) {
            let (prefix, len) = r.read_word();
            let (kind, value) = keyword(prefix, len);
            return Tok::Keyword { kind, value, len: len as i32 };
        }
        if r.skip_white_space() {
            return Tok::WhiteSpace;
        }
        if r.skip_parentheses() {
            return Tok::Unknown;
        }
        r.next();
        Tok::Unknown
    }
}

/// The first three significant digits of a numeral read as milliseconds.
fn read_milliseconds(token: Tok) -> i32 {
    let Tok::Number { value: mut number, len: mut length } = token else { return 0 };
    if length < 3 {
        if length == 1 {
            number *= 100;
        } else if length == 2 {
            number *= 10;
        }
    } else if length > 3 {
        length = length.min(MAX_SIGNIFICANT_DIGITS as i32);
        let mut factor = 1;
        while length > 3 {
            factor *= 10;
            length -= 1;
        }
        number /= factor;
    }
    number
}

struct TimeZoneComposer {
    sign: i32,
    hour: i32,
    minute: i32,
}

impl TimeZoneComposer {
    fn new() -> Self {
        Self { sign: NONE, hour: NONE, minute: NONE }
    }
    fn set(&mut self, offset_in_hours: i32) {
        self.sign = if offset_in_hours < 0 { -1 } else { 1 };
        self.hour = offset_in_hours * self.sign;
        self.minute = 0;
    }
    fn set_sign(&mut self, sign: i32) {
        self.sign = if sign < 0 { -1 } else { 1 };
    }
    fn is_expecting(&self, n: i32) -> bool {
        self.hour != NONE && self.minute == NONE && is_minute(n)
    }
    fn is_utc(&self) -> bool {
        self.hour == 0 && self.minute == 0
    }
    fn is_empty(&self) -> bool {
        self.hour == NONE
    }
    /// The offset in seconds, `Ok(None)` when no zone was named, `Err` when out of range.
    fn write(&mut self) -> Result<Option<i32>, ()> {
        if self.sign == NONE {
            return Ok(None);
        }
        if self.hour == NONE {
            self.hour = 0;
        }
        if self.minute == NONE {
            self.minute = 0;
        }
        // Unsigned 32-bit arithmetic, as V8 does it.
        let total = (self.hour as u32).wrapping_mul(3600).wrapping_add((self.minute as u32).wrapping_mul(60));
        if total > i32::MAX as u32 {
            return Err(());
        }
        Ok(Some(if self.sign < 0 { -(total as i32) } else { total as i32 }))
    }
}

struct TimeComposer {
    comp: [i32; 4],
    index: usize,
    hour_offset: i32,
}

impl TimeComposer {
    fn new() -> Self {
        Self { comp: [0; 4], index: 0, hour_offset: NONE }
    }
    fn is_empty(&self) -> bool {
        self.index == 0
    }
    fn is_expecting(&self, n: i32) -> bool {
        (self.index == 1 && is_minute(n)) || (self.index == 2 && is_second(n)) || (self.index == 3 && between(n, 0, 999))
    }
    fn add(&mut self, n: i32) -> bool {
        if self.index < 4 {
            self.comp[self.index] = n;
            self.index += 1;
            true
        } else {
            false
        }
    }
    fn add_final(&mut self, n: i32) -> bool {
        if !self.add(n) {
            return false;
        }
        while self.index < 4 {
            self.comp[self.index] = 0;
            self.index += 1;
        }
        true
    }
    fn write(&mut self) -> Option<[i32; 4]> {
        while self.index < 4 {
            self.comp[self.index] = 0;
            self.index += 1;
        }
        let [mut hour, minute, second, millisecond] = self.comp;
        if self.hour_offset != NONE {
            if !between(hour, 0, 12) {
                return None;
            }
            hour %= 12;
            hour += self.hour_offset;
        }
        let in_range = is_hour(hour) && is_minute(minute) && is_second(second) && between(millisecond, 0, 999);
        // A 24th hour is allowed when everything below it is zero.
        if !in_range && (hour != 24 || minute != 0 || second != 0 || millisecond != 0) {
            return None;
        }
        Some([hour, minute, second, millisecond])
    }
}

struct DayComposer {
    comp: [i32; 3],
    index: usize,
    named_month: i32,
    is_iso_date: bool,
}

impl DayComposer {
    fn new() -> Self {
        Self { comp: [0; 3], index: 0, named_month: NONE, is_iso_date: false }
    }
    fn is_empty(&self) -> bool {
        self.index == 0
    }
    fn add(&mut self, n: i32) -> bool {
        if self.index < 3 {
            self.comp[self.index] = n;
            self.index += 1;
            true
        } else {
            false
        }
    }
    /// `(year, month 1-based, day)`. The missing slots are filled with 1 first, so the
    /// component count is always three afterwards (a lone number is `month/day/1` or, with a
    /// named month, `day` and year 1).
    fn write(&mut self) -> Option<(i32, i32, i32)> {
        if self.index < 1 {
            return None;
        }
        while self.index < 3 {
            self.comp[self.index] = 1;
            self.index += 1;
        }
        let c = self.comp;
        // Default year is 0 (read as 2000).
        let (mut year, month, day);
        if self.named_month == NONE {
            if self.is_iso_date || !is_day(c[0]) {
                (year, month, day) = (c[0], c[1], c[2]);
            } else {
                (year, month, day) = (c[2], c[0], c[1]);
            }
        } else {
            month = self.named_month;
            if !is_day(c[0]) {
                (year, day) = (c[0], c[1]);
            } else {
                (year, day) = (c[1], c[0]);
            }
        }
        if !self.is_iso_date {
            if between(year, 0, 49) {
                year += 2000;
            } else if between(year, 50, 99) {
                year += 1900;
            }
        }
        (is_month(month) && is_day(day)).then_some((year, month, day))
    }
}

/// The ES5 date-time string prefix of the input. Returns the next token for the legacy reader
/// (`End` when the whole text was an ES5 string, `Invalid` when it can be nothing else).
fn parse_es5(s: &mut Scanner, day: &mut DayComposer, time: &mut TimeComposer, tz: &mut TimeZoneComposer) -> Tok {
    if s.peek().is_ascii_sign() {
        // Kept so the legacy reader can have it back when the year is not used.
        let sign_token = s.next();
        if !s.peek().is_fixed_length_number(6) {
            return sign_token;
        }
        let sign = sign_token.ascii_sign();
        let year = s.next().number();
        if sign < 0 && year == 0 {
            return sign_token;
        }
        day.add(sign * year);
    } else if s.peek().is_fixed_length_number(4) {
        day.add(s.next().number());
    } else {
        return s.next();
    }
    if s.skip_symbol(b'-') {
        if !s.peek().is_fixed_length_number(2) || !is_month(s.peek().number()) {
            return s.next();
        }
        day.add(s.next().number());
        if s.skip_symbol(b'-') {
            if !s.peek().is_fixed_length_number(2) || !is_day(s.peek().number()) {
                return s.next();
            }
            day.add(s.next().number());
        }
    }
    if !s.peek().is_keyword_type(Kw::TimeSeparator) {
        if !s.peek().is_end() {
            return s.next();
        }
    } else {
        s.next();
        if !s.peek().is_fixed_length_number(2) || !between(s.peek().number(), 0, 24) {
            return Tok::Invalid;
        }
        // 24:00[:00[.000]] only.
        let hour_is_24 = s.peek().number() == 24;
        time.add(s.next().number());
        if !s.skip_symbol(b':') {
            return Tok::Invalid;
        }
        if !s.peek().is_fixed_length_number(2) || !is_minute(s.peek().number()) || (hour_is_24 && s.peek().number() > 0) {
            return Tok::Invalid;
        }
        time.add(s.next().number());
        if s.skip_symbol(b':') {
            if !s.peek().is_fixed_length_number(2) || !is_second(s.peek().number()) || (hour_is_24 && s.peek().number() > 0) {
                return Tok::Invalid;
            }
            time.add(s.next().number());
            if s.skip_symbol(b'.') {
                if !s.peek().is_number() || (hour_is_24 && s.peek().number() > 0) {
                    return Tok::Invalid;
                }
                time.add(read_milliseconds(s.next()));
            }
        }
        if s.peek().is_keyword_z() {
            s.next();
            tz.set(0);
        } else if s.peek().is_symbol(b'+') || s.peek().is_symbol(b'-') {
            tz.set_sign(if s.next().is_symbol(b'+') { 1 } else { -1 });
            if s.peek().is_fixed_length_number(4) {
                // hhmm extension.
                let hourmin = s.next().number();
                let (hour, min) = (hourmin / 100, hourmin % 100);
                if !is_hour(hour) || !is_minute(min) {
                    return Tok::Invalid;
                }
                tz.hour = hour;
                tz.minute = min;
            } else {
                if !s.peek().is_fixed_length_number(2) || !is_hour(s.peek().number()) {
                    return Tok::Invalid;
                }
                tz.hour = s.next().number();
                if !s.skip_symbol(b':') {
                    return Tok::Invalid;
                }
                if !s.peek().is_fixed_length_number(2) || !is_minute(s.peek().number()) {
                    return Tok::Invalid;
                }
                tz.minute = s.next().number();
            }
        }
        if !s.peek().is_end() {
            return Tok::Invalid;
        }
    }
    // A date-only ISO string is UTC; a date-time without an offset is local.
    if tz.is_empty() && time.is_empty() {
        tz.set(0);
    }
    day.is_iso_date = true;
    Tok::End
}

/// `None` when V8 rejects the text.
pub(crate) fn parse(text: &str) -> Option<Parsed> {
    let mut scanner = Scanner::new(Reader { units: text.encode_utf16().collect(), i: 0 });
    let mut tz = TimeZoneComposer::new();
    let mut time = TimeComposer::new();
    let mut day = DayComposer::new();

    let mut token = parse_es5(&mut scanner, &mut day, &mut time, &mut tz);
    if token == Tok::Invalid {
        return None;
    }
    let mut has_read_number = !day.is_empty();
    while !token.is_end() {
        if let Tok::Number { value: n, .. } = token {
            has_read_number = true;
            if scanner.skip_symbol(b':') {
                if scanner.skip_symbol(b':') {
                    // n + "::"
                    if !time.is_empty() {
                        return None;
                    }
                    time.add(n);
                    time.add(0);
                } else {
                    // n + ":"
                    if !time.add(n) {
                        return None;
                    }
                    if scanner.peek().is_symbol(b'.') {
                        scanner.next();
                    }
                }
            } else if scanner.skip_symbol(b'.') && time.is_expecting(n) {
                time.add(n);
                if !scanner.peek().is_number() {
                    return None;
                }
                let ms = read_milliseconds(scanner.next());
                if ms < 0 {
                    return None;
                }
                time.add_final(ms);
            } else if tz.is_expecting(n) {
                tz.minute = n;
            } else if time.is_expecting(n) {
                time.add_final(n);
                // End, white space, "Z", "+" or "-" must follow a finished time.
                let peek = scanner.peek();
                if !peek.is_end() && peek != Tok::WhiteSpace && !peek.is_keyword_z() && !peek.is_ascii_sign() {
                    return None;
                }
            } else {
                if !day.add(n) {
                    return None;
                }
                scanner.skip_symbol(b'-');
            }
        } else if let Tok::Keyword { kind, value, .. } = token {
            if kind == Kw::AmPm && !time.is_empty() {
                time.hour_offset = value;
            } else if kind == Kw::Month {
                day.named_month = value;
                scanner.skip_symbol(b'-');
            } else if kind == Kw::Zone && has_read_number {
                tz.set(value);
            } else {
                // Garbage words are illegal once a number has been read, and the first
                // number has to be separated from them.
                if has_read_number || scanner.peek().is_number() {
                    return None;
                }
            }
        } else if token.is_ascii_sign() && (tz.is_utc() || !time.is_empty()) {
            // A UTC offset, only after UTC or a time.
            tz.set_sign(token.ascii_sign());
            let (mut n, mut length) = (0, 0);
            if scanner.peek().is_number() {
                let next = scanner.next();
                if let Tok::Number { value, len } = next {
                    (n, length) = (value, len);
                }
            }
            has_read_number = true;
            if scanner.peek().is_symbol(b':') {
                tz.hour = n;
                tz.minute = NONE;
            } else if length == 1 || length == 2 {
                tz.hour = n;
                tz.minute = 0;
            } else if length == 3 || length == 4 {
                tz.hour = n / 100;
                tz.minute = n % 100;
            } else {
                return None;
            }
        } else if (token.is_ascii_sign() || token.is_symbol(b')')) && has_read_number {
            return None;
        }
        token = scanner.next();
    }

    let (year, month, day) = day.write()?;
    let [hour, minute, second, millisecond] = time.write()?;
    let utc_offset_secs = tz.write().ok()?;
    Some(Parsed { year, month, day, hour, minute, second, millisecond, utc_offset_secs })
}
