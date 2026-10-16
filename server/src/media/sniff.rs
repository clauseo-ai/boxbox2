//! what a file's bytes are, from the bytes (`agents.md`, media, upload).
//! a declared image, audio or video type the bytes contradict is refused:
//! a device that labels a file wrongly finds out at the upload, not when a
//! phone fails to play it. any other kind is kept as declared and served as
//! an attachment, so nothing here has to know every format there is.

/// how many leading bytes the table reads. every signature sits in the
/// first 12; the rest is room.
pub const HEAD: usize = 64;

/// a recognised file: the type it is served as when nothing better was
/// declared, and every declared type the same bytes may honestly carry (a
/// recorder's `audio/mp4` is an mp4 container whatever its brand says).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Signature {
    pub mime: &'static str,
    pub accepts: &'static [&'static str],
}

const PNG: Signature = Signature {
    mime: "image/png",
    accepts: &["image/png", "image/apng"],
};
const JPEG: Signature = Signature {
    mime: "image/jpeg",
    accepts: &["image/jpeg", "image/jpg", "image/pjpeg"],
};
const GIF: Signature = Signature {
    mime: "image/gif",
    accepts: &["image/gif"],
};
const WEBP: Signature = Signature {
    mime: "image/webp",
    accepts: &["image/webp"],
};
const HEIF_FAMILY: &[&str] = &[
    "image/heic",
    "image/heif",
    "image/heic-sequence",
    "image/heif-sequence",
];
const HEIC: Signature = Signature {
    mime: "image/heic",
    accepts: HEIF_FAMILY,
};
const HEIF: Signature = Signature {
    mime: "image/heif",
    accepts: HEIF_FAMILY,
};
const M4A: Signature = Signature {
    mime: "audio/mp4",
    accepts: &["audio/mp4", "audio/x-m4a", "audio/m4a", "video/mp4"],
};
const MP4: Signature = Signature {
    mime: "video/mp4",
    accepts: &[
        "video/mp4",
        "audio/mp4",
        "audio/x-m4a",
        "audio/m4a",
        "video/quicktime",
        "video/x-m4v",
    ],
};
const QUICKTIME: Signature = Signature {
    mime: "video/quicktime",
    accepts: &["video/quicktime", "video/mp4", "audio/mp4"],
};
const OGG: Signature = Signature {
    mime: "audio/ogg",
    accepts: &["audio/ogg", "video/ogg", "application/ogg", "audio/opus"],
};
const WEBM: Signature = Signature {
    mime: "video/webm",
    accepts: &[
        "video/webm",
        "audio/webm",
        "video/x-matroska",
        "audio/x-matroska",
    ],
};
const MP3: Signature = Signature {
    mime: "audio/mpeg",
    accepts: &["audio/mpeg", "audio/mp3"],
};
const WAV: Signature = Signature {
    mime: "audio/wav",
    accepts: &["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"],
};
const PDF: Signature = Signature {
    mime: "application/pdf",
    accepts: &["application/pdf"],
};

/// every signature, for the question "does the table know this type".
const TABLE: &[Signature] = &[
    PNG, JPEG, GIF, WEBP, HEIC, HEIF, M4A, MP4, QUICKTIME, OGG, WEBM, MP3, WAV, PDF,
];

/// the signature `head` (the file's first bytes) carries, if the table
/// knows it.
#[must_use]
pub fn sniff(head: &[u8]) -> Option<Signature> {
    if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(PNG);
    }
    if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(JPEG);
    }
    if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        return Some(GIF);
    }
    if head.len() >= 12 && &head[..4] == b"RIFF" {
        return match &head[8..12] {
            b"WEBP" => Some(WEBP),
            b"WAVE" => Some(WAV),
            _ => None,
        };
    }
    if head.len() >= 12 && &head[4..8] == b"ftyp" {
        return brand(&head[8..12]);
    }
    if head.starts_with(b"OggS") {
        return Some(OGG);
    }
    if head.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return Some(WEBM);
    }
    if head.starts_with(b"%PDF-") {
        return Some(PDF);
    }
    // an id3 tag, or an mpeg audio frame header (layer iii, any version)
    if head.starts_with(b"ID3") || matches!(head, [0xFF, 0xFB | 0xFA | 0xF3 | 0xF2 | 0xE3, ..]) {
        return Some(MP3);
    }
    None
}

/// an iso base media file's major brand.
fn brand(major: &[u8]) -> Option<Signature> {
    match major {
        b"heic" | b"heix" | b"hevc" | b"hevx" | b"heim" | b"heis" => Some(HEIC),
        b"mif1" | b"msf1" | b"heif" => Some(HEIF),
        b"M4A " | b"M4B " | b"M4P " => Some(M4A),
        b"qt  " => Some(QUICKTIME),
        b"isom" | b"iso2" | b"iso3" | b"iso4" | b"iso5" | b"iso6" | b"mp41" | b"mp42" | b"avc1"
        | b"dash" | b"M4V " | b"MSNV" | b"3gp4" | b"3gp5" => Some(MP4),
        _ => None,
    }
}

/// why a declared type was not kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Contradiction {
    pub declared: String,
    /// what the bytes are, when the table knows.
    pub found: Option<&'static str>,
}

/// whether a type is one the bytes are checked against: an image, audio or
/// video.
#[must_use]
pub fn is_media(mime: &str) -> bool {
    mime.starts_with("image/") || mime.starts_with("audio/") || mime.starts_with("video/")
}

/// the declared type checked against the bytes. a media type stands when
/// the bytes are that kind, or when they are nothing the table knows and
/// the type is not one it knows either (an svg, a flac); any other kind
/// stands as declared.
///
/// # Errors
/// a declared image, audio or video type the bytes contradict.
pub fn check(declared: &str, head: &[u8]) -> Result<(), Contradiction> {
    if !is_media(declared) {
        return Ok(());
    }
    let found = sniff(head);
    let fits = match found {
        Some(signature) => signature.accepts.contains(&declared),
        None => !TABLE.iter().any(|s| s.accepts.contains(&declared)),
    };
    if fits {
        Ok(())
    } else {
        Err(Contradiction {
            declared: declared.to_owned(),
            found: found.map(|s| s.mime),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ftyp(brand: [u8; 4]) -> Vec<u8> {
        let mut head = vec![0, 0, 0, 0x20];
        head.extend_from_slice(b"ftyp");
        head.extend_from_slice(&brand);
        head.extend_from_slice(&[0; 8]);
        head
    }

    #[test]
    fn every_kind_in_the_table_is_known_by_its_first_bytes() {
        let cases: &[(&[u8], &str)] = &[
            (b"\x89PNG\r\n\x1a\n....", "image/png"),
            (&[0xFF, 0xD8, 0xFF, 0xE0], "image/jpeg"),
            (b"GIF89a..", "image/gif"),
            (b"RIFF\0\0\0\0WEBPVP8 ", "image/webp"),
            (b"RIFF\0\0\0\0WAVEfmt ", "audio/wav"),
            (b"OggS\0\x02", "audio/ogg"),
            (&[0x1A, 0x45, 0xDF, 0xA3, 0x9F], "video/webm"),
            (b"ID3\x04\0", "audio/mpeg"),
            (&[0xFF, 0xFB, 0x90, 0x00], "audio/mpeg"),
            (b"%PDF-1.7\n", "application/pdf"),
        ];
        for (head, mime) in cases {
            assert_eq!(sniff(head).map(|s| s.mime), Some(*mime), "{mime}");
        }
        assert_eq!(sniff(&ftyp(*b"heic")).map(|s| s.mime), Some("image/heic"));
        assert_eq!(sniff(&ftyp(*b"mif1")).map(|s| s.mime), Some("image/heif"));
        assert_eq!(sniff(&ftyp(*b"M4A ")).map(|s| s.mime), Some("audio/mp4"));
        assert_eq!(sniff(&ftyp(*b"isom")).map(|s| s.mime), Some("video/mp4"));
        assert_eq!(sniff(b"hello world"), None);
    }

    #[test]
    fn a_recorders_audio_mp4_stands_whatever_brand_the_container_carries() {
        assert!(check("audio/mp4", &ftyp(*b"M4A ")).is_ok());
        assert!(check("audio/mp4", &ftyp(*b"iso5")).is_ok());
        assert!(check("audio/webm", &[0x1A, 0x45, 0xDF, 0xA3]).is_ok());
        assert!(check("audio/ogg", b"OggS\0").is_ok());
    }

    #[test]
    fn a_declared_media_type_the_bytes_contradict_is_refused() {
        let refused = check("image/png", b"%PDF-1.4").unwrap_err();
        assert_eq!(refused.found, Some("application/pdf"));
        // png claimed, bytes the table does not know: still a lie about a type it knows
        assert_eq!(check("image/png", b"not a png").unwrap_err().found, None);
        // an audio label on an image
        assert!(check("audio/mpeg", &[0xFF, 0xD8, 0xFF, 0xE0]).is_err());
    }

    #[test]
    fn a_type_the_table_does_not_know_stands_unless_the_bytes_are_something_it_does() {
        assert!(check("image/svg+xml", b"<svg xmlns=").is_ok());
        assert!(check("audio/flac", b"fLaC\0").is_ok());
        assert!(check("image/svg+xml", b"\x89PNG\r\n\x1a\n").is_err());
    }

    #[test]
    fn documents_and_other_kinds_stand_as_declared() {
        assert!(check("application/pdf", b"anything").is_ok());
        assert!(check("text/plain", b"\x89PNG\r\n\x1a\n").is_ok());
        assert!(check("application/octet-stream", b"").is_ok());
    }
}
