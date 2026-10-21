//! thumbnails (`docs/protocol.md` section 13; `agents.md`, media):
//! `GET /api/media/{id}?w=<px>` scales a stored image to a ladder width,
//! never up, in its own format, and keeps the variant under
//! `<media root>/thumbs/<first 2 hex>/<id>.w<px>.s<scaler>` against the
//! media cap.
//!
//! the scaling is the browser's own: chromium draws a downscaled `<img>`
//! from a mip chain (skia's, 2x2 boxes, 1-2-1 taps on an odd side,
//! truncating) sampled bilinearly on the two levels around the scale and
//! blended between them, on premultiplied pixels. this does the same, so a
//! thumbnail drawn 1:1 lands within 2/255 of what the browser would have
//! drawn from the original (the pixel check, `scripts/thumb-check.ts` and
//! `docs/verification.md`, thumbnails). general resampling filters
//! (lanczos3, catmull-rom, triangle, box) were measured and missed by far.
//!
//! the whole route is off for now (`THUMBNAILS`): webkit's own downscale
//! is not chromium's, and the two differ by more than the check's bar.
//!
//! only formats that pass the check get thumbnails: png (lossless, the
//! same pixels) and webp (re-encoded lossless, so a lossy original loses
//! nothing more). jpeg fails it (its re-encode and the two decoders differ
//! by more than 2/255), and gif is animation and a palette; both, and any
//! image carrying what the browser would apply and a thumbnail would drop
//! (a colour profile, gamma, an orientation, animation, 16-bit samples),
//! answer the original. so does anything this cannot read.

use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};

use image::{ImageFormat, RgbaImage};
use tracing::warn;

/// whether `?w=` makes thumbnails at all. off: the scaling matches
/// chromium's own downscale but not webkit's, and no thumbnail can match
/// both, since the two engines' downscales of the same original differ by
/// more than the bar between themselves (`docs/verification.md`,
/// thumbnails). until it is switched on (with a3's merge), `?w=` is ignored
/// and the original answers exactly as without it.
pub const THUMBNAILS: bool = false;
/// the widths a thumbnail comes in, in device pixels.
pub const LADDER: [u32; 5] = [96, 192, 384, 768, 1536];
/// scalings at once; one more waits its turn. one image can take a few
/// hundred MiB while it scales (`MAX_THUMB_PIXELS` says how many), so they
/// go one at a time.
pub const JOBS: usize = 1;
/// the largest original scaled, in pixels: past it, the original is served.
pub const MAX_PIXELS: u64 = 40_000_000;
/// the largest thumbnail made, in pixels (`w` times its height): past it,
/// the original is served, decided from the header before anything is
/// allocated. 1536 wide by 4096 tall, 24 MiB of rgba; a taller image (a
/// long screenshot) answers the original.
///
/// the peak for the worst image both caps allow (40 M pixels, a thumbnail
/// of 6.3 M): the encoded original (at most 64 MiB, `MEDIA_BODY`) and its
/// decode (an rgb decode of 120 MB and its rgba copy of 160 MB, held
/// together for the conversion; the decoder itself stays under
/// `MAX_ALLOC`), about 350 MB while it decodes; then the rgba original, its
/// next mip level (40 MB) and the thumbnail (25 MB), about 290 MB with the
/// encoded original still held. the sampling holds one row of floats per
/// level (1536 x 4 x 4 bytes, 24 KiB), never the whole thumbnail in floats.
pub const MAX_THUMB_PIXELS: u64 = 1536 * 4096;
/// the scaler's version, in every thumbnail's etag and kept file name: a
/// change to the scaling (`LEVEL_BIAS`, the chain) moves it, so different
/// bytes never answer under an etag a client already holds as immutable.
pub const SCALER_VERSION: u32 = 1;
/// what the decoder may allocate for one original.
const MAX_ALLOC: u64 = 256 * 1024 * 1024;
/// the bytes read to decide whether an original gets a thumbnail at all;
/// a png whose chunks before its pixels run past this answers the original.
const HEAD: u64 = 64 * 1024;
/// where the mip chain is sampled: `log2(scale) - LEVEL_BIAS`. skia's
/// source says 0.5; chromium's output fits 0.47 (the pixel check swept
/// 0.42 to 0.55, `docs/verification.md`).
const LEVEL_BIAS: f32 = 0.47;

/// a requested width, when it is on the ladder: exactly its decimal digits.
#[must_use]
pub fn width(raw: &str) -> Option<u32> {
    LADDER.into_iter().find(|w| w.to_string() == raw)
}

/// a thumbnail's name, its etag (quoted) and its kept file:
/// `<id>.w<px>.s<SCALER_VERSION>`.
#[must_use]
pub fn name(id: &str, w: u32) -> String {
    format!("{id}.w{w}.s{SCALER_VERSION}")
}

/// where a thumbnail lives; `None` for anything that is not a media id or
/// a ladder width.
#[must_use]
pub fn address(root: &Path, id: &str, w: u32) -> Option<PathBuf> {
    (super::is_id(id) && LADDER.contains(&w))
        .then(|| root.join("thumbs").join(&id[..2]).join(name(id, w)))
}

/// the formats that ship thumbnails.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Png,
    Webp,
}

impl Format {
    /// the format a stored type gets thumbnails in, if any.
    #[must_use]
    pub fn of(mime: &str) -> Option<Self> {
        match mime {
            "image/png" => Some(Self::Png),
            "image/webp" => Some(Self::Webp),
            _ => None,
        }
    }

    fn image(self) -> ImageFormat {
        match self {
            Self::Png => ImageFormat::Png,
            Self::Webp => ImageFormat::WebP,
        }
    }
}

/// what a width asks of an original.
#[derive(Debug, PartialEq, Eq)]
pub enum Scaled {
    /// the original answers: at or under the width, or not one to scale.
    Original,
    /// the encoded thumbnail.
    Thumb(Vec<u8>),
}

/// whether the original at `path` gets a thumbnail at `w` at all, from its
/// head alone: what decides most requests without decoding anything or
/// waiting behind a scaling.
#[must_use]
pub fn wanted(path: &Path, format: Format, w: u32) -> bool {
    let mut head = Vec::new();
    std::fs::File::open(path)
        .and_then(|file| file.take(HEAD).read_to_end(&mut head))
        .is_ok_and(|_| scalable(probe(format, &head), w))
}

fn scalable(probed: Option<(u32, u32)>, w: u32) -> bool {
    probed.is_some_and(|(width, height)| {
        width > w
            && u64::from(width) * u64::from(height) <= MAX_PIXELS
            && u64::from(w) * u64::from(height_at(width, height, w)) <= MAX_THUMB_PIXELS
    })
}

/// the original at `path` at width `w`. never fails: whatever stops a
/// thumbnail (a file gone, a decode error, a size past the caps) answers
/// the original, and the original's own path reports a missing file.
#[must_use]
pub fn make(path: &Path, format: Format, w: u32) -> Scaled {
    let read = || -> std::io::Result<Option<Vec<u8>>> {
        let mut file = std::fs::File::open(path)?;
        let mut bytes = Vec::new();
        (&mut file).take(HEAD).read_to_end(&mut bytes)?;
        if !scalable(probe(format, &bytes), w) {
            return Ok(None);
        }
        file.read_to_end(&mut bytes)?;
        Ok(Some(bytes))
    };
    match read() {
        Ok(Some(bytes)) => scale(format, &bytes, w),
        Ok(None) => Scaled::Original,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Scaled::Original,
        Err(error) => {
            warn!(path = %path.display(), %error, "a thumbnail's original could not be read; the original answers");
            Scaled::Original
        }
    }
}

/// `bytes` at width `w`, in `format`.
#[must_use]
pub fn scale(format: Format, bytes: &[u8], w: u32) -> Scaled {
    let probed = probe(format, bytes);
    let Some((width, height)) = probed.filter(|_| scalable(probed, w)) else {
        return Scaled::Original;
    };
    let decoded = match decode(format, bytes) {
        Ok(decoded) => decoded,
        Err(error) => {
            warn!(%error, "an image that looked scalable did not decode; the original answers");
            return Scaled::Original;
        }
    };
    let alpha = decoded.color().has_alpha();
    let h = height_at(width, height, w);
    let small = downscale(decoded.into_rgba8(), w, h);
    match encode(format, small, alpha) {
        Ok(bytes) => Scaled::Thumb(bytes),
        Err(error) => {
            warn!(%error, "a thumbnail did not encode; the original answers");
            Scaled::Original
        }
    }
}

/// the thumbnail's height: the original's aspect ratio, rounded, at least 1.
#[must_use]
pub fn height_at(width: u32, height: u32, w: u32) -> u32 {
    let scaled = (u64::from(height) * u64::from(w) + u64::from(width) / 2) / u64::from(width);
    u32::try_from(scaled.max(1)).unwrap_or(u32::MAX)
}

/// the original's width and height when it is one to scale: a plain 8-bit
/// png or a still webp, with nothing the browser applies that a thumbnail
/// would drop. `None` otherwise, or when the head does not say.
#[must_use]
pub fn probe(format: Format, head: &[u8]) -> Option<(u32, u32)> {
    match format {
        Format::Png => probe_png(head),
        Format::Webp => probe_webp(head),
    }
}

fn be32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn probe_png(head: &[u8]) -> Option<(u32, u32)> {
    if !head.starts_with(b"\x89PNG\r\n\x1a\n") || head.get(12..16)? != b"IHDR" {
        return None;
    }
    let (width, height) = (be32(head, 16)?, be32(head, 20)?);
    let depth = *head.get(24)?;
    if depth > 8 || width == 0 || height == 0 {
        return None;
    }
    let (mut srgb, mut gamma) = (false, false);
    let mut at = 8;
    loop {
        let length = usize::try_from(be32(head, at)?).ok()?;
        match head.get(at + 4..at + 8)? {
            b"IDAT" => break,
            // a colour profile, an orientation, animation
            b"iCCP" | b"eXIf" | b"acTL" => return None,
            b"sRGB" => srgb = true,
            b"gAMA" | b"cHRM" => gamma = true,
            _ => {}
        }
        at = at.checked_add(12)?.checked_add(length)?;
    }
    // an srgb chunk overrides gamma and chromaticities, as the browser does
    (srgb || !gamma).then_some((width, height))
}

fn probe_webp(head: &[u8]) -> Option<(u32, u32)> {
    if head.get(0..4)? != b"RIFF" || head.get(8..12)? != b"WEBP" {
        return None;
    }
    let le24 = |at: usize| -> Option<u32> {
        let b = head.get(at..at + 3)?;
        Some(u32::from(b[0]) | u32::from(b[1]) << 8 | u32::from(b[2]) << 16)
    };
    let le16 = |at: usize| -> Option<u32> {
        let b = head.get(at..at + 2)?;
        Some(u32::from(b[0]) | u32::from(b[1]) << 8)
    };
    let (width, height) = match head.get(12..16)? {
        b"VP8 " => {
            if head.get(23..26)? != [0x9d, 0x01, 0x2a] {
                return None;
            }
            (le16(26)? & 0x3fff, le16(28)? & 0x3fff)
        }
        b"VP8L" => {
            if *head.get(20)? != 0x2f {
                return None;
            }
            let bits = u32::from_le_bytes(head.get(21..25)?.try_into().ok()?);
            ((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
        }
        b"VP8X" => {
            let flags = *head.get(20)?;
            // a colour profile, exif (an orientation), animation
            if flags & (0x20 | 0x08 | 0x02) != 0 {
                return None;
            }
            (le24(24)? + 1, le24(27)? + 1)
        }
        _ => return None,
    };
    (width > 0 && height > 0).then_some((width, height))
}

fn decode(format: Format, bytes: &[u8]) -> image::ImageResult<image::DynamicImage> {
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format.image());
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_ALLOC);
    reader.limits(limits);
    reader.decode()
}

fn encode(format: Format, small: RgbaImage, alpha: bool) -> image::ImageResult<Vec<u8>> {
    let (w, h) = small.dimensions();
    let (pixels, colour) = if alpha {
        (small.into_raw(), image::ExtendedColorType::Rgba8)
    } else {
        let rgb: Vec<u8> = small
            .into_raw()
            .chunks_exact(4)
            .flat_map(|p| [p[0], p[1], p[2]])
            .collect();
        (rgb, image::ExtendedColorType::Rgb8)
    };
    let mut out = Vec::new();
    match format {
        Format::Png => image::ImageEncoder::write_image(
            image::codecs::png::PngEncoder::new(&mut out),
            &pixels,
            w,
            h,
            colour,
        )?,
        Format::Webp => image::ImageEncoder::write_image(
            image::codecs::webp::WebPEncoder::new_lossless(&mut out),
            &pixels,
            w,
            h,
            colour,
        )?,
    }
    Ok(out)
}

/// `source` scaled to `w` by `h` the way chromium draws it: premultiplied,
/// a mip chain, bilinear on the two levels around the scale, blended.
#[must_use]
pub fn downscale(source: RgbaImage, w: u32, h: u32) -> RgbaImage {
    let (width, height) = source.dimensions();
    let mut level = Level::premultiplied(source);
    #[allow(
        clippy::cast_precision_loss,
        reason = "image sides stay far below 2^24, where f32 is exact"
    )]
    let scale = (width as f32 / w as f32).min(height as f32 / h as f32);
    let at = (scale.log2() - LEVEL_BIAS).max(0.0);
    let floor = at.floor();
    let blend = at - floor;
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a level index: non-negative and under 32"
    )]
    for _ in 0..floor as u32 {
        level = level.half();
    }
    let half = (blend > 0.0).then(|| level.half());
    let upper = Sampler::new(&level, w, h);
    let lower = half.as_ref().map(|half| Sampler::new(half, w, h));
    // one row of floats per level at a time, straight into the u8 output
    let row = w as usize * 4;
    let (mut up, mut down) = (Vec::with_capacity(row), Vec::with_capacity(row));
    let mut out = Vec::with_capacity(row * h as usize);
    for y in 0..h as usize {
        upper.row(y, &mut up);
        if let Some(lower) = &lower {
            lower.row(y, &mut down);
        }
        for (i, value) in up.iter().enumerate() {
            let v = if lower.is_some() {
                value * (1.0 - blend) + down[i] * blend
            } else {
                *value
            };
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "clamped to 0..=255 first"
            )]
            out.push(v.round().clamp(0.0, 255.0) as u8);
        }
    }
    unpremultiply(&mut out);
    RgbaImage::from_raw(w, h, out).unwrap_or_else(|| RgbaImage::new(w, h))
}

/// one level of the mip chain: premultiplied rgba.
struct Level {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

impl Level {
    fn premultiplied(image: RgbaImage) -> Self {
        let (width, height) = image.dimensions();
        let mut pixels = image.into_raw();
        for p in pixels.chunks_exact_mut(4) {
            let a = u32::from(p[3]);
            if a < 255 {
                for c in &mut p[..3] {
                    *c = u8::try_from((u32::from(*c) * a + 127) / 255).unwrap_or(u8::MAX);
                }
            }
        }
        Self {
            width,
            height,
            pixels,
        }
    }

    /// the next level down, skia's way: half each side (at least 1), two
    /// taps on an even side and 1-2-1 on an odd one, truncated.
    fn half(&self) -> Self {
        let taps = |side: u32| -> &'static [u32] {
            match side {
                1 => &[1],
                s if s % 2 == 1 => &[1, 2, 1],
                _ => &[1, 1],
            }
        };
        let (xt, yt) = (taps(self.width), taps(self.height));
        let shift = (xt.iter().sum::<u32>() * yt.iter().sum::<u32>()).trailing_zeros();
        let (width, height) = ((self.width / 2).max(1), (self.height / 2).max(1));
        let stride = self.width as usize * 4;
        let mut pixels = Vec::with_capacity(width as usize * height as usize * 4);
        for y in 0..height {
            for x in 0..width {
                let mut sum = [0u32; 4];
                for (j, wy) in (0u32..).zip(yt) {
                    let row = (2 * y + j).min(self.height - 1) as usize * stride;
                    for (i, wx) in (0u32..).zip(xt) {
                        let at = row + (2 * x + i).min(self.width - 1) as usize * 4;
                        for (c, total) in sum.iter_mut().enumerate() {
                            *total += u32::from(self.pixels[at + c]) * wx * wy;
                        }
                    }
                }
                pixels.extend(sum.map(|v| u8::try_from(v >> shift).unwrap_or(u8::MAX)));
            }
        }
        Self {
            width,
            height,
            pixels,
        }
    }
}

/// bilinear samples of one level at `w` by `h`, texel centres, edges
/// clamped, unrounded, made one output row at a time.
struct Sampler<'a> {
    level: &'a Level,
    xs: Vec<(usize, usize, f32)>,
    ys: Vec<(usize, usize, f32)>,
}

impl<'a> Sampler<'a> {
    #[allow(
        clippy::cast_precision_loss,
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "sides stay far below 2^24; coordinates are clamped non-negative before flooring"
    )]
    fn new(level: &'a Level, w: u32, h: u32) -> Self {
        let axis = |from: u32, to: u32| -> Vec<(usize, usize, f32)> {
            let step = from as f32 / to as f32;
            let last = (from - 1) as f32;
            (0..to)
                .map(|i| {
                    let u = ((i as f32 + 0.5) * step - 0.5).clamp(0.0, last);
                    let lo = u.floor();
                    let next = (lo as u32 + 1).min(from - 1);
                    (lo as usize, next as usize, u - lo)
                })
                .collect()
        };
        Self {
            level,
            xs: axis(level.width, w),
            ys: axis(level.height, h),
        }
    }

    /// output row `y` into `out`, replacing what it held.
    fn row(&self, y: usize, out: &mut Vec<f32>) {
        out.clear();
        let stride = self.level.width as usize * 4;
        let pixels = &self.level.pixels;
        let texel =
            |row: usize, col: usize, c: usize| f32::from(pixels[row * stride + col * 4 + c]);
        let (y0, y1, ty) = self.ys[y];
        for &(x0, x1, tx) in &self.xs {
            for c in 0..4 {
                let top = texel(y0, x0, c) * (1.0 - tx) + texel(y0, x1, c) * tx;
                let bottom = texel(y1, x0, c) * (1.0 - tx) + texel(y1, x1, c) * tx;
                out.push(top * (1.0 - ty) + bottom * ty);
            }
        }
    }
}

fn unpremultiply(pixels: &mut [u8]) {
    for p in pixels.chunks_exact_mut(4) {
        let a = u32::from(p[3]);
        if a > 0 && a < 255 {
            for c in &mut p[..3] {
                *c = u8::try_from(((u32::from(*c) * 255 + a / 2) / a).min(255)).unwrap_or(u8::MAX);
            }
        }
    }
}

/// the thumbnails on disk and their bytes, which count against the media
/// cap. owned by the media task; an entry goes when its original goes, or
/// when eviction takes the thumbnails first.
#[derive(Debug, Default)]
pub struct Ledger {
    sizes: HashMap<String, [u64; LADDER.len()]>,
    total: u64,
}

fn rung(w: u32) -> Option<usize> {
    LADDER.iter().position(|&l| l == w)
}

impl Ledger {
    /// the bytes every kept thumbnail takes.
    #[must_use]
    pub fn total(&self) -> u64 {
        self.total
    }

    /// whether `id` has a kept thumbnail at `w`.
    #[must_use]
    pub fn has(&self, id: &str, w: u32) -> bool {
        rung(w).is_some_and(|r| self.sizes.get(id).is_some_and(|s| s[r] > 0))
    }

    /// the bytes `id`'s thumbnails take.
    #[must_use]
    pub fn bytes_of(&self, id: &str) -> u64 {
        self.sizes.get(id).map_or(0, |s| s.iter().sum())
    }

    /// every id with a kept thumbnail.
    pub fn ids(&self) -> impl Iterator<Item = &str> {
        self.sizes.keys().map(String::as_str)
    }

    /// counts a thumbnail now on disk.
    pub fn add(&mut self, id: &str, w: u32, size: u64) {
        let Some(r) = rung(w) else { return };
        let sizes = self.sizes.entry(id.to_owned()).or_default();
        self.total = self.total.saturating_sub(sizes[r]).saturating_add(size);
        sizes[r] = size;
    }

    /// removes `id`'s thumbnails from disk and the count. a file that will
    /// not go is logged and forgotten; the next startup's scan removes it.
    pub fn remove(&mut self, root: &Path, id: &str) {
        let Some(sizes) = self.sizes.remove(id) else {
            return;
        };
        self.total = self.total.saturating_sub(sizes.iter().sum());
        for (w, size) in LADDER.iter().zip(sizes) {
            if size == 0 {
                continue;
            }
            let Some(path) = address(root, id, *w) else {
                continue;
            };
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    warn!(path = %path.display(), %error, "a thumbnail could not be removed; the startup check removes it");
                }
            }
        }
    }
}

/// keeps a thumbnail: written to `tmp/`, synced, renamed into place.
///
/// # Errors
/// the disk refuses.
pub fn write(root: &Path, id: &str, w: u32, bytes: &[u8]) -> std::io::Result<()> {
    let Some(path) = address(root, id, w) else {
        return Err(std::io::Error::other("not a media id or a ladder width"));
    };
    if let Some(parent) = path.parent() {
        super::create_private_dir(parent)?;
    }
    let tmp = root.join("tmp").join(format!("thumb-{}", name(id, w)));
    let mut file = std::fs::File::create(&tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    std::fs::rename(&tmp, &path)
}

/// the startup count of `thumbs/`: every `<id>.w<px>.s<SCALER_VERSION>`
/// whose id is live, and everything else removed (thumbnails of files gone,
/// another scaler's, strays).
#[must_use]
pub fn scan(root: &Path, live: &HashSet<String>) -> Ledger {
    let mut ledger = Ledger::default();
    let Ok(shards) = std::fs::read_dir(root.join("thumbs")) else {
        return ledger;
    };
    for shard in shards.flatten() {
        let Ok(files) = std::fs::read_dir(shard.path()) else {
            continue;
        };
        for file in files.flatten() {
            let name = file.file_name();
            let kept = name.to_str().and_then(|name| {
                let (id, rest) = name.split_once(".w")?;
                let (w, version) = rest.split_once(".s")?;
                let w = width(w)?;
                (version == SCALER_VERSION.to_string()).then_some(())?;
                let size = file
                    .metadata()
                    .ok()
                    .filter(std::fs::Metadata::is_file)?
                    .len();
                (live.contains(id) && shard.file_name().to_str() == id.get(..2))
                    .then(|| (id.to_owned(), w, size))
            });
            match kept {
                Some((id, w, size)) => ledger.add(&id, w, size),
                None => {
                    if let Err(error) = std::fs::remove_file(file.path()) {
                        warn!(path = %file.path().display(), %error, "a stray thumbnail could not be removed; skipped");
                    }
                }
            }
        }
    }
    ledger
}

#[cfg(test)]
mod tests;
