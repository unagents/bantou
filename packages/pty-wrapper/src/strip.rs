/// Streaming terminal-control stripper. Feed decoded text; get printable text back.
/// Removes CSI, OSC (incl. OSC 8 hyperlinks; BEL or ST terminated), DCS/SOS/PM/APC strings,
/// other ESC sequences and C0/C1 controls. Keeps `\n` and `\t`; drops `\r`.
/// State survives across `feed` calls, so sequences split over chunks are handled.
#[derive(Default)]
pub struct Stripper {
    state: State,
}

#[derive(Default, Clone, Copy, PartialEq, Debug)]
enum State {
    #[default]
    Ground,
    Esc,
    EscInter,
    Csi,
    Str,
    StrEsc,
}

impl Stripper {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn feed(&mut self, input: &str) -> String {
        let mut out = String::with_capacity(input.len());
        for c in input.chars() {
            self.step(c, &mut out);
        }
        out
    }

    fn step(&mut self, c: char, out: &mut String) {
        use State::*;
        match self.state {
            Ground => match c {
                '\x1b' => self.state = Esc,
                '\u{9b}' => self.state = Csi,
                '\u{90}' | '\u{98}' | '\u{9d}' | '\u{9e}' | '\u{9f}' => self.state = Str,
                '\n' | '\t' => out.push(c),
                '\r' => {}
                c if (c as u32) < 0x20 || c == '\x7f' || ('\u{80}'..='\u{9f}').contains(&c) => {}
                c => out.push(c),
            },
            Esc => match c {
                '[' => self.state = Csi,
                ']' | 'P' | 'X' | '^' | '_' => self.state = Str,
                '\x1b' => {}
                ' '..='/' => self.state = EscInter,
                _ => self.state = Ground,
            },
            EscInter => match c {
                ' '..='/' => {}
                '\x1b' => self.state = Esc,
                _ => self.state = Ground,
            },
            Csi => match c {
                '@'..='~' => self.state = Ground,
                '\x18' | '\x1a' => self.state = Ground,
                '\x1b' => self.state = Esc,
                _ => {}
            },
            Str => match c {
                '\x07' | '\u{9c}' | '\x18' | '\x1a' => self.state = Ground,
                '\x1b' => self.state = StrEsc,
                _ => {}
            },
            StrEsc => match c {
                '\\' => self.state = Ground,
                _ => {
                    self.state = Esc;
                    self.step(c, out);
                }
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strip(s: &str) -> String {
        Stripper::new().feed(s)
    }

    #[test]
    fn plain_text_and_newline() {
        assert_eq!(strip("hello\nworld"), "hello\nworld");
    }

    #[test]
    fn drops_cr() {
        assert_eq!(strip("a\r\nb\rc"), "a\nbc");
    }

    #[test]
    fn csi_sgr_and_cursor() {
        assert_eq!(strip("\x1b[1;31mred\x1b[0m \x1b[2K\x1b[10;5Hx"), "red x");
        assert_eq!(strip("\x1b[?25l\x1b[?2004hok"), "ok");
    }

    #[test]
    fn osc_bel_terminated() {
        assert_eq!(strip("\x1b]0;title\x07after"), "after");
    }

    #[test]
    fn osc_st_terminated() {
        assert_eq!(strip("\x1b]0;title\x1b\\after"), "after");
    }

    #[test]
    fn osc8_hyperlink() {
        let s = "\x1b]8;;https://example.com/a?b=1\x07link\x1b]8;;\x07 and \x1b]8;id=1;https://x.y\x1b\\two\x1b]8;;\x1b\\";
        assert_eq!(strip(s), "link and two");
    }

    #[test]
    fn dcs_and_apc_strings() {
        assert_eq!(strip("a\x1bPq#0;2;0;0;0\x1b\\b\x1b_Gf=24;AAAA\x1b\\c"), "abc");
    }

    #[test]
    fn simple_esc_sequences() {
        assert_eq!(strip("\x1b7a\x1b8b\x1b=c\x1b>d\x1b(Be\x1b#8f"), "abcdef");
    }

    #[test]
    fn other_controls_dropped_tab_kept() {
        assert_eq!(strip("a\x07b\x08c\x00d\te\x7f"), "abcd\te");
    }

    #[test]
    fn c1_controls() {
        assert_eq!(strip("a\u{9b}31mb\u{9d}0;t\u{9c}c"), "abc");
    }

    #[test]
    fn sequence_split_across_chunks() {
        let mut s = Stripper::new();
        let mut out = String::new();
        for part in ["x\x1b", "[3", "1mred\x1b]8;;http", "://a\x1b", "\\link", "\x1b]8;;\x07"] {
            out.push_str(&s.feed(part));
        }
        assert_eq!(out, "xredlink");
    }

    #[test]
    fn esc_inside_string_starts_new_sequence() {
        assert_eq!(strip("\x1b]0;t\x1b[31mred"), "red");
    }

    #[test]
    fn unicode_kept() {
        assert_eq!(strip("\x1b[32m日本語\x1b[0m😀"), "日本語😀");
    }
}
