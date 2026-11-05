//! Protobuf wire primitives shared by the two Connect+protobuf providers
//! (`cursor`, `devin`): field iteration for decoding and a field writer for
//! encoding. Messages are described by the providers' own typed structs; this
//! module knows tags, varints and length-delimited values only.
//!
//! Encoding is canonical proto3 as the Node codec wrote it: the caller
//! decides which fields are written (implicit-presence fields holding their
//! default are skipped through the `*_if` writers); every repeated element is
//! written.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PbError(pub &'static str);

impl fmt::Display for PbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for PbError {}

/// One decoded field value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Value<'a> {
    Varint(u64),
    Fixed64(u64),
    Len(&'a [u8]),
    Fixed32(u32),
}

impl<'a> Value<'a> {
    pub fn as_u64(self) -> u64 {
        match self {
            Self::Varint(v) | Self::Fixed64(v) => v,
            Self::Fixed32(v) => u64::from(v),
            Self::Len(_) => 0,
        }
    }

    pub fn as_bool(self) -> bool {
        self.as_u64() != 0
    }

    pub fn as_i32(self) -> i32 {
        self.as_u64() as i32
    }

    pub fn as_f32(self) -> f32 {
        match self {
            Self::Fixed32(v) => f32::from_bits(v),
            _ => 0.0,
        }
    }

    pub fn as_f64(self) -> f64 {
        match self {
            Self::Fixed64(v) => f64::from_bits(v),
            _ => 0.0,
        }
    }

    pub fn bytes(self) -> &'a [u8] {
        match self {
            Self::Len(b) => b,
            _ => &[],
        }
    }

    /// UTF-8 text; invalid sequences are replaced (a server string is never
    /// a reason to fail a stream).
    pub fn text(self) -> String {
        String::from_utf8_lossy(self.bytes()).into_owned()
    }
}

/// Iterates the fields of one message in wire order.
pub struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    fn varint(&mut self) -> Result<u64, PbError> {
        let mut value = 0u64;
        for shift in (0..64).step_by(7) {
            let byte = *self.buf.get(self.pos).ok_or(PbError("truncated varint"))?;
            self.pos += 1;
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err(PbError("varint too long"))
    }

    fn take(&mut self, len: usize) -> Result<&'a [u8], PbError> {
        let end = self.pos.checked_add(len).ok_or(PbError("length overflow"))?;
        let slice = self.buf.get(self.pos..end).ok_or(PbError("truncated field"))?;
        self.pos = end;
        Ok(slice)
    }

    /// The next `(field number, value)`; `None` at the end of the message.
    pub fn next_field(&mut self) -> Result<Option<(u32, Value<'a>)>, PbError> {
        if self.pos >= self.buf.len() {
            return Ok(None);
        }
        let tag = self.varint()?;
        let number = u32::try_from(tag >> 3).map_err(|_| PbError("field number out of range"))?;
        if number == 0 {
            return Err(PbError("field number zero"));
        }
        let value = match tag & 7 {
            0 => Value::Varint(self.varint()?),
            1 => {
                let b = self.take(8)?;
                Value::Fixed64(u64::from_le_bytes(b.try_into().expect("8 bytes")))
            }
            2 => {
                let len = usize::try_from(self.varint()?).map_err(|_| PbError("length overflow"))?;
                Value::Len(self.take(len)?)
            }
            5 => {
                let b = self.take(4)?;
                Value::Fixed32(u32::from_le_bytes(b.try_into().expect("4 bytes")))
            }
            _ => return Err(PbError("unsupported wire type")),
        };
        Ok(Some((number, value)))
    }

    /// Every packed varint of a length-delimited value (repeated enums).
    pub fn packed_varints(bytes: &[u8]) -> Result<Vec<u64>, PbError> {
        let mut reader = Reader::new(bytes);
        let mut out = Vec::new();
        while reader.pos < reader.buf.len() {
            out.push(reader.varint()?);
        }
        Ok(out)
    }
}

/// Appends fields to a message body.
#[derive(Default, Debug, Clone)]
pub struct Writer {
    buf: Vec<u8>,
}

impl Writer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn finish(self) -> Vec<u8> {
        self.buf
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    fn put_varint(&mut self, mut value: u64) {
        while value >= 0x80 {
            self.buf.push((value as u8 & 0x7f) | 0x80);
            value >>= 7;
        }
        self.buf.push(value as u8);
    }

    fn tag(&mut self, number: u32, wire: u8) {
        self.put_varint(u64::from(number) << 3 | u64::from(wire));
    }

    pub fn varint(&mut self, number: u32, value: u64) {
        self.tag(number, 0);
        self.put_varint(value);
    }

    /// `int32`: a negative value takes ten bytes, as protobuf specifies.
    pub fn int32(&mut self, number: u32, value: i32) {
        self.varint(number, i64::from(value) as u64);
    }

    pub fn varint_if(&mut self, number: u32, value: u64) {
        if value != 0 {
            self.varint(number, value);
        }
    }

    pub fn bool_if(&mut self, number: u32, value: bool) {
        if value {
            self.varint(number, 1);
        }
    }

    pub fn bytes(&mut self, number: u32, value: &[u8]) {
        self.tag(number, 2);
        self.put_varint(value.len() as u64);
        self.buf.extend_from_slice(value);
    }

    pub fn bytes_if(&mut self, number: u32, value: &[u8]) {
        if !value.is_empty() {
            self.bytes(number, value);
        }
    }

    pub fn string(&mut self, number: u32, value: &str) {
        self.bytes(number, value.as_bytes());
    }

    pub fn string_if(&mut self, number: u32, value: &str) {
        self.bytes_if(number, value.as_bytes());
    }

    pub fn message(&mut self, number: u32, body: Writer) {
        self.bytes(number, &body.buf);
    }

    pub fn fixed32(&mut self, number: u32, value: f32) {
        self.tag(number, 5);
        self.buf.extend_from_slice(&value.to_bits().to_le_bytes());
    }

    pub fn double(&mut self, number: u32, value: f64) {
        self.tag(number, 1);
        self.buf.extend_from_slice(&value.to_bits().to_le_bytes());
    }

    pub fn double_if(&mut self, number: u32, value: f64) {
        if value != 0.0 {
            self.double(number, value);
        }
    }

    /// A packed repeated varint field.
    pub fn packed(&mut self, number: u32, values: &[u64]) {
        if values.is_empty() {
            return;
        }
        let mut inner = Writer::new();
        for v in values {
            inner.put_varint(*v);
        }
        self.bytes(number, &inner.buf);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_every_wire_type() {
        let mut w = Writer::new();
        w.varint(1, 300);
        w.string(2, "héllo");
        w.fixed32(3, 1.5);
        w.double(4, -2.25);
        w.int32(5, -1);
        let bytes = w.finish();
        let mut r = Reader::new(&bytes);
        assert_eq!(r.next_field().unwrap(), Some((1, Value::Varint(300))));
        let (n, v) = r.next_field().unwrap().unwrap();
        assert_eq!((n, v.text()), (2, "héllo".to_string()));
        assert_eq!(r.next_field().unwrap().unwrap().1.as_f32(), 1.5);
        assert_eq!(r.next_field().unwrap().unwrap().1.as_f64(), -2.25);
        assert_eq!(r.next_field().unwrap().unwrap().1.as_i32(), -1);
        assert_eq!(r.next_field().unwrap(), None);
    }

    #[test]
    fn truncated_input_is_an_error() {
        assert!(Reader::new(&[0x0a, 0x05, b'a']).next_field().is_err());
        assert!(Reader::new(&[0x08]).next_field().is_err());
    }

    #[test]
    fn packed_varints_decode() {
        let mut w = Writer::new();
        w.packed(30, &[3, 4, 6, 7, 8]);
        let bytes = w.finish();
        let (n, v) = Reader::new(&bytes).next_field().unwrap().unwrap();
        assert_eq!(n, 30);
        assert_eq!(Reader::packed_varints(v.bytes()).unwrap(), vec![3, 4, 6, 7, 8]);
    }
}
