//! the board stream's server-sent events, parsed from bytes as they come:
//! `data:` lines gather until a blank line hands over one event; comments
//! (`: hb`) and other fields are read past. a pure parser, so the tests hold
//! it without a socket.

/// a view is a few kilobytes; a line past this is not the board's stream.
pub const LINE_CAP: usize = 256 * 1024;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SseError {
    #[error("an event line ran past {LINE_CAP} bytes")]
    TooLong,
}

#[derive(Debug, Default)]
pub struct Parser {
    line: Vec<u8>,
    data: String,
    has_data: bool,
}

impl Parser {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// feeds bytes; returns every event's data completed by them.
    ///
    /// # Errors
    /// a line or an event past [`LINE_CAP`].
    pub fn feed(&mut self, bytes: &[u8]) -> Result<Vec<String>, SseError> {
        let mut out = Vec::new();
        for &b in bytes {
            if b == b'\n' {
                self.end_line(&mut out);
            } else {
                self.line.push(b);
                if self.line.len() + self.data.len() > LINE_CAP {
                    return Err(SseError::TooLong);
                }
            }
        }
        Ok(out)
    }

    fn end_line(&mut self, out: &mut Vec<String>) {
        if self.line.last() == Some(&b'\r') {
            self.line.pop();
        }
        if self.line.is_empty() {
            if self.has_data {
                out.push(std::mem::take(&mut self.data));
                self.has_data = false;
            }
            return;
        }
        let line = String::from_utf8_lossy(&self.line);
        if let Some(value) = line.strip_prefix("data")
            && (value.is_empty() || value.starts_with(':'))
        {
            {
                let value = value.strip_prefix(':').unwrap_or(value);
                let value = value.strip_prefix(' ').unwrap_or(value);
                if self.has_data {
                    self.data.push('\n');
                }
                self.data.push_str(value);
                self.has_data = true;
            }
        }
        self.line.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_split_across_reads_come_whole() -> Result<(), SseError> {
        let mut p = Parser::new();
        assert!(p.feed(b": hb\n\nevent: x\ndata: {\"type\":")?.is_empty());
        let out = p.feed(b"\"replaced\"}\r\n\r\n: hb\n\n")?;
        assert_eq!(out, vec![r#"{"type":"replaced"}"#.to_owned()]);
        Ok(())
    }

    #[test]
    fn data_lines_join_with_newlines() -> Result<(), SseError> {
        let mut p = Parser::new();
        assert_eq!(p.feed(b"data:a\ndata: b\n\n")?, vec!["a\nb".to_owned()]);
        Ok(())
    }

    #[test]
    fn a_runaway_line_is_refused() {
        let mut p = Parser::new();
        assert_eq!(p.feed(&vec![b'x'; LINE_CAP + 1]), Err(SseError::TooLong));
    }
}
