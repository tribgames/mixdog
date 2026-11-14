//! The RC4 stream cipher of pdf.js `ARCFourCipher`. The state runs on across calls, so a stream decrypted in chunks
//! gives what one call over the whole stream gives.

pub struct Rc4 {
    s: [u8; 256],
    a: u8,
    b: u8,
}

impl Rc4 {
    pub fn new(key: &[u8]) -> Self {
        let mut s = [0u8; 256];
        for (i, slot) in s.iter_mut().enumerate() {
            *slot = i as u8;
        }
        let mut j: u8 = 0;
        for i in 0..256usize {
            let tmp = s[i];
            // An empty key reads as zero bytes (the JavaScript index `i % 0` is NaN and adds nothing).
            let k = if key.is_empty() { 0 } else { key[i % key.len()] };
            j = j.wrapping_add(tmp).wrapping_add(k);
            s[i] = s[usize::from(j)];
            s[usize::from(j)] = tmp;
        }
        Rc4 { s, a: 0, b: 0 }
    }

    /// Encrypts or decrypts `data` (the same operation).
    pub fn apply(&mut self, data: &[u8]) -> Vec<u8> {
        data.iter()
            .map(|&byte| {
                self.a = self.a.wrapping_add(1);
                let tmp = self.s[usize::from(self.a)];
                self.b = self.b.wrapping_add(tmp);
                let tmp2 = self.s[usize::from(self.b)];
                self.s[usize::from(self.a)] = tmp2;
                self.s[usize::from(self.b)] = tmp;
                byte ^ self.s[usize::from(tmp.wrapping_add(tmp2))]
            })
            .collect()
    }
}
