/// Streaming UTF-8 decoder: an incomplete sequence at the end of a chunk is held back
/// and completed by the next chunk. Invalid bytes become U+FFFD.
#[derive(Default)]
pub struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn decode(&mut self, bytes: &[u8]) -> String {
        let mut buf = std::mem::take(&mut self.pending);
        buf.extend_from_slice(bytes);
        let mut out = String::new();
        let mut rest: &[u8] = &buf;
        loop {
            match std::str::from_utf8(rest) {
                Ok(s) => {
                    out.push_str(s);
                    break;
                }
                Err(e) => {
                    let (valid, after) = rest.split_at(e.valid_up_to());
                    out.push_str(std::str::from_utf8(valid).unwrap_or(""));
                    match e.error_len() {
                        None => {
                            self.pending = after.to_vec();
                            break;
                        }
                        Some(n) => {
                            out.push('\u{FFFD}');
                            rest = &after[n..];
                        }
                    }
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_passthrough() {
        assert_eq!(Utf8Stream::new().decode(b"hello"), "hello");
    }

    #[test]
    fn split_multibyte_across_chunks() {
        let bytes = "あい".as_bytes(); // 6 bytes
        let mut d = Utf8Stream::new();
        let mut out = String::new();
        for b in bytes {
            out.push_str(&d.decode(&[*b]));
        }
        assert_eq!(out, "あい");
    }

    #[test]
    fn split_four_byte_char() {
        let bytes = "😀".as_bytes();
        let mut d = Utf8Stream::new();
        assert_eq!(d.decode(&bytes[..1]), "");
        assert_eq!(d.decode(&bytes[1..3]), "");
        assert_eq!(d.decode(&bytes[3..]), "😀");
    }

    #[test]
    fn invalid_bytes_become_replacement() {
        let mut d = Utf8Stream::new();
        assert_eq!(d.decode(&[b'a', 0xff, b'b']), "a\u{FFFD}b");
    }

    #[test]
    fn invalid_continuation_after_lead() {
        let mut d = Utf8Stream::new();
        assert_eq!(d.decode(&[0xe3]), "");
        assert_eq!(d.decode(b"x"), "\u{FFFD}x");
    }
}
