//! what a file's bytes are, from the bytes. an icon is only ever served
//! with a type found here, never one a daemon, a file name or a build's
//! sidecar claimed: a mislabelled file must not reach a browser as an
//! image, and an image must not lose its type to an extension it does not
//! have (Next's `icon.body`).

/// the image type of `bytes`, or none when they are not an image a browser
/// draws in an `<img>`.
#[must_use]
pub fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && matches!(&bytes[8..12], b"avif" | b"avis")
    {
        Some("image/avif")
    } else if is_ico(bytes) {
        Some("image/x-icon")
    } else if is_svg(bytes) {
        Some("image/svg+xml")
    } else {
        None
    }
}

/// an icon file: a reserved zero, type 1, at least one image, and room for
/// the directory entries it counts. a cursor (type 2) is not one.
fn is_ico(bytes: &[u8]) -> bool {
    let [0, 0, 1, 0, low, high, ..] = *bytes else {
        return false;
    };
    let count = usize::from(u16::from_le_bytes([low, high]));
    count > 0 && bytes.len() >= 6 + 16 * count
}

/// a document whose root element is `<svg`, after the byte order mark,
/// whitespace, an xml declaration, comments and a doctype. the whole file
/// must be utf-8, as a browser reads it.
fn is_svg(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    let mut rest = text.strip_prefix('\u{feff}').unwrap_or(text);
    loop {
        rest = rest.trim_start();
        if let Some(after) = rest.strip_prefix("<?") {
            let Some((_, tail)) = after.split_once("?>") else {
                return false;
            };
            rest = tail;
        } else if let Some(after) = rest.strip_prefix("<!--") {
            let Some((_, tail)) = after.split_once("-->") else {
                return false;
            };
            rest = tail;
        } else if rest.len() >= 9 && rest[..9].eq_ignore_ascii_case("<!doctype") {
            rest = match doctype_end(rest) {
                Some(end) => &rest[end..],
                None => return false,
            };
        } else {
            break;
        }
    }
    let Some(after) = rest.strip_prefix("<svg") else {
        return false;
    };
    after.starts_with(|c: char| c.is_ascii_whitespace() || c == '>' || c == '/')
}

/// where a doctype ends: its first `>`, or the `]>` that closes an
/// internal subset.
fn doctype_end(doctype: &str) -> Option<usize> {
    match (doctype.find('['), doctype.find('>')) {
        (Some(open), Some(close)) if open < close => {
            doctype[open..].find("]>").map(|at| open + at + 2)
        }
        (_, Some(close)) => Some(close + 1),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    #[test]
    fn each_image_kind_is_known_by_its_magic_bytes() {
        assert_eq!(image_type(PNG), Some("image/png"));
        assert_eq!(
            image_type(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10]),
            Some("image/jpeg")
        );
        assert_eq!(image_type(b"GIF89a\x01\0\x01\0"), Some("image/gif"));
        assert_eq!(image_type(b"GIF87a\x01\0\x01\0"), Some("image/gif"));
        assert_eq!(image_type(b"RIFF\x24\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(
            image_type(b"\0\0\0\x1cftypavif\0\0\0\0avifmif1"),
            Some("image/avif")
        );
        let mut ico = vec![0, 0, 1, 0, 1, 0];
        ico.extend_from_slice(&[16, 16, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0]);
        assert_eq!(image_type(&ico), Some("image/x-icon"));
    }

    #[test]
    fn an_extensionless_png_is_a_png() {
        // Next's `.next/server/app/icon.body`: no extension to go by
        assert_eq!(image_type(PNG), Some("image/png"));
    }

    #[test]
    fn an_ico_header_with_no_room_for_its_entries_is_not_an_icon() {
        assert_eq!(image_type(&[0, 0, 1, 0, 3, 0, 16, 16]), None);
        assert_eq!(image_type(&[0, 0, 1, 0, 0, 0]), None);
        assert_eq!(
            image_type(&[
                0, 0, 2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
            ]),
            None
        );
    }

    #[test]
    fn an_svg_is_found_after_a_prolog_comments_and_a_doctype() {
        let svg = |text: &str| image_type(text.as_bytes());
        assert_eq!(
            svg("<svg xmlns=\"http://www.w3.org/2000/svg\"/>"),
            Some("image/svg+xml")
        );
        assert_eq!(svg("\n  <svg>\n</svg>"), Some("image/svg+xml"));
        assert_eq!(
            svg(
                "<?xml version=\"1.0\"?>\n<!-- made by hand -->\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"x.dtd\">\n<svg viewBox=\"0 0 1 1\"/>"
            ),
            Some("image/svg+xml")
        );
        assert_eq!(
            svg("<!DOCTYPE svg [ <!ENTITY a \"b\"> ]><svg/>"),
            Some("image/svg+xml")
        );
        assert_eq!(svg("\u{feff}<svg/>"), Some("image/svg+xml"));
    }

    #[test]
    fn a_document_that_only_mentions_svg_is_not_an_svg() {
        let svg = |text: &str| image_type(text.as_bytes());
        assert_eq!(svg("<html><svg></svg></html>"), None);
        assert_eq!(svg("<svgfoo/>"), None);
        assert_eq!(svg("<?xml version=\"1.0\"?><html/>"), None);
        assert_eq!(svg("<!-- never closed <svg/>"), None);
        assert_eq!(svg("<?xml never closed <svg/>"), None);
        assert_eq!(svg("not svg"), None);
    }

    #[test]
    fn an_svg_that_is_not_utf8_is_refused() {
        assert_eq!(image_type(b"<svg>\xff\xfe</svg>"), None);
    }

    #[test]
    fn text_html_and_empty_files_are_not_images() {
        assert_eq!(image_type(b""), None);
        assert_eq!(image_type(b"<!doctype html><title>x</title>"), None);
        assert_eq!(image_type(b"{\"status\":200}"), None);
        assert_eq!(image_type(b"RIFF\x24\0\0\0WAVEfmt "), None);
        assert_eq!(image_type(b"\x89PNG"), None);
    }
}
