use std::io::Read;

#[derive(Debug, PartialEq, Eq)]
pub enum BodyError {
    TooLarge,
    Io,
}

/// Reads a response body while enforcing a hard wire-byte cap.
///
/// A declared Content-Length is checked first, but the streaming read still
/// stops at `limit + 1` bytes so a missing or false header cannot bypass it.
pub fn read_bounded<R: Read>(
    mut reader: R,
    declared_length: Option<u64>,
    limit: usize,
) -> Result<Vec<u8>, BodyError> {
    if declared_length.is_some_and(|length| length > limit as u64) {
        return Err(BodyError::TooLarge);
    }
    let mut body = Vec::new();
    reader
        .by_ref()
        .take(limit as u64 + 1)
        .read_to_end(&mut body)
        .map_err(|_| BodyError::Io)?;
    if body.len() > limit {
        return Err(BodyError::TooLarge);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::{read_bounded, BodyError};
    use std::io::{self, Cursor, Read};

    #[test]
    fn accepts_a_body_at_the_limit() {
        let body = read_bounded(Cursor::new(vec![7u8; 64]), Some(64), 64).unwrap();
        assert_eq!(body.len(), 64);
    }

    #[test]
    fn rejects_a_declared_oversized_body_before_reading() {
        assert_eq!(
            read_bounded(io::repeat(0), Some(65), 64),
            Err(BodyError::TooLarge)
        );
    }

    #[test]
    fn stops_a_stream_without_a_declared_length() {
        assert_eq!(
            read_bounded(io::repeat(0), None, 64),
            Err(BodyError::TooLarge)
        );
    }

    #[test]
    fn rejects_a_false_small_length() {
        let reader = Cursor::new(vec![0u8; 65]);
        assert_eq!(read_bounded(reader, Some(1), 64), Err(BodyError::TooLarge));
    }

    #[test]
    fn reads_chunked_style_input_to_the_cap() {
        struct Chunks {
            remaining: usize,
        }
        impl Read for Chunks {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                if self.remaining == 0 {
                    return Ok(0);
                }
                let count = buffer.len().min(7).min(self.remaining);
                buffer[..count].fill(1);
                self.remaining -= count;
                Ok(count)
            }
        }
        let body = read_bounded(Chunks { remaining: 21 }, None, 64).unwrap();
        assert_eq!(body.len(), 21);
    }
}
