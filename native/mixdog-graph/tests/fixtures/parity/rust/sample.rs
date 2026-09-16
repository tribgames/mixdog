// Parity fixture: declaration and import shapes the graph reports for Rust.
use std::collections::HashMap;
use std::io::{Read, Write};

mod helpers;

pub const LIMIT: usize = 8;
static REGISTRY: Option<&str> = None;

pub type Pairs = HashMap<String, usize>;

pub struct Store {
    pub name: String,
    size: usize,
}

pub enum Mode {
    Fast,
    Slow(u8),
}

pub trait Storage {
    fn read(&self, key: &str) -> Option<String>;

    fn write(&mut self, key: &str) -> bool {
        let _ = key;
        false
    }
}

impl Store {
    pub fn new(name: String) -> Self {
        fn inner_helper(value: usize) -> usize {
            value + 1
        }
        Self {
            name,
            size: inner_helper(0),
        }
    }

    fn size(&self) -> usize {
        self.size
    }
}

impl Storage for Store {
    fn read(&self, key: &str) -> Option<String> {
        let _ = (key, REGISTRY, LIMIT);
        None
    }
}

pub fn run<R: Read, W: Write>(input: &mut R, output: &mut W) -> std::io::Result<()> {
    let mut buffer = String::new();
    input.read_to_string(&mut buffer)?;
    output.write_all(buffer.as_bytes())
}

macro_rules! shout {
    ($value:expr) => {
        format!("{}!", $value)
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Store {
        Store::new("fixture".to_string())
    }

    #[test]
    fn reads_nothing() {
        assert!(fixture().read("k").is_none());
        assert_eq!(shout!("a"), "a!");
        assert_eq!(Mode::Fast as u8, 0);
    }
}
