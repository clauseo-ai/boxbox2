#![allow(
    clippy::many_single_char_names,
    reason = "pixel maths: x, y, w, h, r, g, b"
)]

use std::io::Cursor;

use image::{DynamicImage, ImageFormat, Rgb, RgbImage, Rgba};

use super::*;
use crate::media::{Declared, Lookup, Media};
use crate::store::tests::scratch;

fn encoded(image: &DynamicImage, format: ImageFormat) -> Vec<u8> {
    let mut out = Cursor::new(Vec::new());
    image.write_to(&mut out, format).unwrap();
    out.into_inner()
}

/// a photo-like picture: gradients, a soft disc, and noise.
fn photo(w: u32, h: u32, seed: u64) -> RgbImage {
    let mut state = seed.max(1);
    let mut noise = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        #[allow(clippy::cast_precision_loss, reason = "under 10000")]
        let unit = (state % 10_000) as f32 / 10_000.0;
        (unit - 0.5) * 16.0
    };
    RgbImage::from_fn(w, h, |x, y| {
        #[allow(clippy::cast_precision_loss, reason = "test image sides")]
        let (fx, fy) = (x as f32 / w as f32, y as f32 / h as f32);
        let r = 255.0 * (0.5 + 0.5 * (fx * 6.0 + fy * 2.0).sin());
        let g = 255.0 * fy;
        let b = 255.0 * (0.5 + 0.5 * ((fx - 0.5).hypot(fy - 0.5) * 20.0).cos());
        let disc = if (fx - 0.3).hypot(fy - 0.6) < 0.15 {
            -60.0
        } else {
            0.0
        };
        let n = noise();
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "clamped"
        )]
        let c = |v: f32| (v + n + disc).clamp(0.0, 255.0) as u8;
        Rgb([c(r), c(g), c(b)])
    })
}

/// line art: rows of two-pixel strokes like letters, and rules.
fn text(w: u32, h: u32) -> RgbImage {
    RgbImage::from_fn(w, h, |x, y| {
        let (row, col) = (y % 40, x % 23);
        let stroke = row > 8
            && row < 30
            && (col == 3
                || col == 4
                || col == 11
                || (col > 3 && col < 12 && (row == 9 || row == 19 || row == 29)));
        if stroke || x % 200 == 0 || y % 300 == 150 {
            Rgb([20, 20, 30])
        } else {
            Rgb([250, 250, 245])
        }
    })
}

/// stripes under an alpha ramp with an opaque disc.
fn alpha(w: u32, h: u32) -> image::RgbaImage {
    image::RgbaImage::from_fn(w, h, |x, y| {
        #[allow(clippy::cast_precision_loss, reason = "test image sides")]
        let (fx, fy) = (x as f32 / w as f32, y as f32 / h as f32);
        let a = if (fx - 0.5).hypot(fy - 0.5) < 0.3 {
            255.0
        } else {
            255.0 * fx
        };
        let stripe = if (x / 7) % 2 == 0 { 200 } else { 40 };
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "0 to 255"
        )]
        Rgba([stripe, (255.0 * fy) as u8, 120, a as u8])
    })
}

fn png_of(w: u32, h: u32) -> Vec<u8> {
    encoded(&DynamicImage::ImageRgb8(photo(w, h, 7)), ImageFormat::Png)
}

/// a png with one more chunk before its pixels.
fn with_chunk(png: &[u8], kind: [u8; 4], data: &[u8]) -> Vec<u8> {
    let ihdr_end = 8 + 12 + 13;
    let mut out = png[..ihdr_end].to_vec();
    out.extend(u32::try_from(data.len()).unwrap().to_be_bytes());
    out.extend(kind);
    out.extend(data);
    out.extend([0, 0, 0, 0]);
    out.extend(&png[ihdr_end..]);
    out
}

#[test]
fn only_the_ladder_is_a_width() {
    for w in LADDER {
        assert_eq!(width(&w.to_string()), Some(w));
    }
    for raw in [
        "", "95", "97", "096", "+96", "96px", " 96", "1537", "3072", "-96", "9e1",
    ] {
        assert_eq!(width(raw), None, "{raw:?}");
    }
}

#[test]
fn the_height_keeps_the_aspect_ratio_rounded_and_never_reaches_zero() {
    assert_eq!(height_at(2000, 1333, 96), 64);
    assert_eq!(height_at(1023, 2047, 768), 1537);
    assert_eq!(height_at(3001, 401, 96), 13);
    assert_eq!(height_at(10_000, 10, 96), 1);
}

#[test]
fn an_address_is_under_thumbs_by_shard_and_only_for_ids_and_ladder_widths() {
    let root = Path::new("/store");
    let id = "ab".repeat(32);
    assert_eq!(
        address(root, &id, 384),
        Some(root.join("thumbs").join("ab").join(format!("{id}.w384.s1")))
    );
    assert_eq!(address(root, &id, 100), None);
    assert_eq!(address(root, "../etc", 96), None);
}

#[test]
fn only_png_and_webp_ship_thumbnails() {
    assert_eq!(Format::of("image/png"), Some(Format::Png));
    assert_eq!(Format::of("image/webp"), Some(Format::Webp));
    for mime in [
        "image/jpeg",
        "image/gif",
        "image/svg+xml",
        "application/pdf",
    ] {
        assert_eq!(Format::of(mime), None, "{mime}");
    }
}

#[test]
fn a_plain_png_is_probed_and_what_the_browser_would_apply_is_not() {
    let png = png_of(300, 200);
    assert_eq!(probe(Format::Png, &png), Some((300, 200)));
    // a colour profile, an orientation, animation
    for kind in [*b"iCCP", *b"eXIf", *b"acTL"] {
        assert_eq!(probe(Format::Png, &with_chunk(&png, kind, &[0; 8])), None);
    }
    // gamma alone is applied; under an srgb chunk it is not
    let gamma = with_chunk(&png, *b"gAMA", &45_455u32.to_be_bytes());
    assert_eq!(probe(Format::Png, &gamma), None);
    assert_eq!(
        probe(Format::Png, &with_chunk(&gamma, *b"sRGB", &[0])),
        Some((300, 200))
    );
    // 16-bit samples
    let deep = encoded(
        &DynamicImage::ImageRgb16(DynamicImage::ImageRgb8(photo(30, 20, 1)).into_rgb16()),
        ImageFormat::Png,
    );
    assert_eq!(probe(Format::Png, &deep), None);
    // a head that stops before the pixels says nothing
    assert_eq!(probe(Format::Png, &png[..40]), None);
    assert_eq!(probe(Format::Png, b"not a png"), None);
}

#[test]
fn a_still_webp_is_probed_and_one_with_a_profile_or_motion_is_not() {
    let webp = encoded(
        &DynamicImage::ImageRgb8(photo(301, 199, 2)),
        ImageFormat::WebP,
    );
    assert_eq!(probe(Format::Webp, &webp), Some((301, 199)));
    // an extended header: canvas 640 by 480, then the flags
    let mut extended = b"RIFF\0\0\0\0WEBPVP8X\x0a\0\0\0".to_vec();
    extended.extend([0, 0, 0, 0, 0x7f, 0x02, 0x00, 0xdf, 0x01, 0x00]);
    assert_eq!(probe(Format::Webp, &extended), Some((640, 480)));
    for flag in [0x20, 0x08, 0x02] {
        let mut flagged = extended.clone();
        flagged[20] = flag;
        assert_eq!(probe(Format::Webp, &flagged), None, "flag {flag:#x}");
    }
}

#[test]
fn a_width_at_or_past_the_original_answers_the_original() {
    let png = png_of(384, 256);
    assert_eq!(scale(Format::Png, &png, 384), Scaled::Original);
    assert_eq!(scale(Format::Png, &png, 768), Scaled::Original);
    assert!(matches!(scale(Format::Png, &png, 192), Scaled::Thumb(_)));
}

/// a png's head alone: signature, an 8-bit rgb IHDR of `w` by `h`, and the
/// start of its pixels.
fn png_head(w: u32, h: u32) -> Vec<u8> {
    let mut head = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
    head.extend(w.to_be_bytes());
    head.extend(h.to_be_bytes());
    head.extend([8, 2, 0, 0, 0, 0, 0, 0, 0]);
    head.extend(b"\0\0\0\0IDAT");
    head
}

#[test]
fn a_thumbnail_past_its_pixel_cap_answers_the_original_from_the_header() {
    // a long screenshot at 1536: 1536 by 25983 out, past 1536 by 4096
    assert_eq!(
        probe(Format::Png, &png_head(1537, 26_000)),
        Some((1537, 26_000))
    );
    assert!(!scalable(Some((1537, 26_000)), 1536));
    let dir = std::env::temp_dir().join(format!("boxbox-thumbs-cap-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("tall.png");
    std::fs::write(&path, png_head(1537, 26_000)).unwrap();
    assert!(
        !wanted(&path, Format::Png, 1536),
        "decided before any decode"
    );
    // the same original at a narrower width fits, as does a wide one at 1536
    assert!(wanted(&path, Format::Png, 192));
    assert!(scalable(Some((4000, 10_000)), 1536));
    assert!(!scalable(Some((1537, 4100)), 1536) && scalable(Some((1537, 4097)), 1536));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_thumbnail_is_named_for_its_scaler() {
    let id = "ab".repeat(32);
    assert_eq!(SCALER_VERSION, 1);
    assert_eq!(name(&id, 96), format!("{id}.w96.s1"));
}

#[test]
fn a_thumbnail_keeps_its_format_its_aspect_and_its_alpha() {
    let cases = [
        (
            DynamicImage::ImageRgb8(photo(1201, 777, 3)),
            ImageFormat::Png,
            Format::Png,
        ),
        (
            DynamicImage::ImageRgba8(alpha(1201, 777)),
            ImageFormat::Png,
            Format::Png,
        ),
        (
            DynamicImage::ImageRgb8(photo(1201, 777, 4)),
            ImageFormat::WebP,
            Format::Webp,
        ),
        (
            DynamicImage::ImageRgba8(alpha(1201, 777)),
            ImageFormat::WebP,
            Format::Webp,
        ),
    ];
    for (image, encoding, format) in cases {
        let Scaled::Thumb(bytes) = scale(format, &encoded(&image, encoding), 384) else {
            panic!("{encoding:?} answered the original");
        };
        assert_eq!(image::guess_format(&bytes).unwrap(), encoding);
        let back = image::load_from_memory_with_format(&bytes, encoding).unwrap();
        assert_eq!((back.width(), back.height()), (384, 248));
        assert_eq!(back.color().has_alpha(), image.color().has_alpha());
    }
}

#[test]
fn a_flat_colour_stays_exactly_that_colour() {
    let flat = image::RgbaImage::from_pixel(1000, 700, Rgba([12, 200, 99, 255]));
    let small = downscale(flat, 96, 67);
    assert!(small.pixels().all(|p| p.0 == [12, 200, 99, 255]));
}

#[test]
fn the_mip_chain_truncates_like_skia_at_an_exact_power_of_two() {
    // one white pixel in a 4 by 4 block of black, scaled by 4: skia's box
    // levels truncate 255/4 to 63 and 63/4 to 15
    let mut dots = image::RgbaImage::from_pixel(64, 64, Rgba([0, 0, 0, 255]));
    dots.put_pixel(1, 1, Rgba([255, 255, 255, 255]));
    let small = downscale(dots, 16, 16);
    assert!(small.get_pixel(0, 0).0[0] <= 16);
    assert!(small.get_pixel(0, 0).0[0] >= 13);
}

#[test]
fn the_ledger_counts_removes_and_rebuilds_from_disk() {
    let dir = std::env::temp_dir().join(format!("boxbox-thumbs-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("tmp")).unwrap();
    let (live, gone) = ("a".repeat(64), "b".repeat(64));
    write(&dir, &live, 96, &[1; 10]).unwrap();
    write(&dir, &live, 384, &[1; 30]).unwrap();
    write(&dir, &gone, 96, &[1; 7]).unwrap();
    let stray = dir.join("thumbs").join("aa").join("not-a-thumb");
    std::fs::write(&stray, b"x").unwrap();
    // kept by another scaler (none, or another version): never served
    let unversioned = dir.join("thumbs").join("aa").join(format!("{live}.w192"));
    let other = dir
        .join("thumbs")
        .join("aa")
        .join(format!("{live}.w192.s0"));
    std::fs::write(&unversioned, b"x").unwrap();
    std::fs::write(&other, b"x").unwrap();
    let rebuilt = scan(&dir, &HashSet::from([live.clone()]));
    assert!(!unversioned.exists() && !other.exists());
    assert_eq!(rebuilt.total(), 40);
    assert!(rebuilt.has(&live, 96) && rebuilt.has(&live, 384) && !rebuilt.has(&live, 192));
    assert!(
        !address(&dir, &gone, 96).unwrap().exists(),
        "a gone file's thumbnail is removed"
    );
    assert!(!stray.exists());
    let mut ledger = rebuilt;
    ledger.remove(&dir, &live);
    assert_eq!(ledger.total(), 0);
    assert!(!address(&dir, &live, 96).unwrap().exists());
    assert!(!address(&dir, &live, 384).unwrap().exists());
    let _ = std::fs::remove_dir_all(&dir);
}

struct Scratch {
    media: Media,
    store: crate::store::Store,
    dir: PathBuf,
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn open(cap: u64) -> Scratch {
    let (store, _thread, dir) = scratch();
    let (media, _task) = Media::open(
        &dir,
        store.clone(),
        cap,
        crate::telemetry::Sender::detached(),
        tokio_util::sync::CancellationToken::new(),
    )
    .await
    .unwrap();
    Scratch { media, store, dir }
}

async fn put(media: &Media, mime: &str, bytes: Vec<u8>) -> crate::media::MediaObject {
    let body = futures_util::stream::iter([Ok::<_, std::io::Error>(bytes::Bytes::from(bytes))]);
    let declared = Declared {
        mime: mime.into(),
        ..Declared::default()
    };
    media.copy(body, declared).await.unwrap().object
}

/// the keep runs on the media task after the answer: wait for it, a second at most.
async fn kept(path: &Path, there: bool) -> bool {
    for _ in 0..100 {
        if path.exists() == there {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    false
}

async fn age_everything(store: &crate::store::Store) {
    store
        .call(|c| {
            c.execute(
                "UPDATE media SET created = created - 2 * ?1, pinned_until = NULL",
                [super::super::index::FLOOR_MS],
            )
        })
        .await
        .unwrap();
}

fn file_size(path: &Path) -> u64 {
    std::fs::metadata(path).unwrap().len()
}

#[tokio::test]
async fn a_thumbnail_is_kept_once_and_served_from_disk_after() {
    let s = open(crate::media::DEFAULT_MAX_BYTES).await;
    let object = put(&s.media, "image/png", png_of(800, 600)).await;
    let made = s.media.thumbnail(&object, 192).await.unwrap().unwrap();
    let path = address(&s.dir.join("media"), &object.id, 192).unwrap();
    assert!(kept(&path, true).await);
    assert_eq!(std::fs::read(&path).unwrap(), made.to_vec());
    let again = s.media.thumbnail(&object, 192).await.unwrap().unwrap();
    assert_eq!(again, made);
    // a jpeg and a width past the original answer the original
    assert_eq!(s.media.thumbnail(&object, 1536).await.unwrap(), None);
    let jpeg = encoded(
        &DynamicImage::ImageRgb8(photo(800, 600, 9)),
        ImageFormat::Jpeg,
    );
    let jpeg = put(&s.media, "image/jpeg", jpeg).await;
    assert_eq!(s.media.thumbnail(&jpeg, 192).await.unwrap(), None);
}

#[tokio::test]
async fn thumbnails_go_before_their_original_and_with_it() {
    let cap = crate::media::MIN_MAX_BYTES;
    let s = open(cap).await;
    let root = s.dir.join("media");
    let a = put(&s.media, "image/png", png_of(300, 300)).await;
    let mut thumbs = 0;
    for w in [96, 192] {
        s.media.thumbnail(&a, w).await.unwrap().unwrap();
        let path = address(&root, &a.id, w).unwrap();
        assert!(kept(&path, true).await);
        thumbs += file_size(&path);
    }
    // past the cap by a little, with the original under its day-old floor:
    // the thumbnails go and it stays
    let b = cap - a.size - thumbs + 10_000;
    let mut filler = b"\x89PNG\r\n\x1a\n".to_vec();
    filler.resize(usize::try_from(b).unwrap(), 1);
    put(&s.media, "image/png", filler).await;
    assert!(!address(&root, &a.id, 96).unwrap().exists());
    assert!(!address(&root, &a.id, 192).unwrap().exists());
    assert!(matches!(
        s.media.lookup(&a.id).await.unwrap(),
        Lookup::Ready(_)
    ));

    // made again, then a file that needs the original's room too
    s.media.thumbnail(&a, 96).await.unwrap().unwrap();
    let path = address(&root, &a.id, 96).unwrap();
    assert!(kept(&path, true).await);
    age_everything(&s.store).await;
    let mut big = b"\x89PNG\r\n\x1a\n".to_vec();
    big.resize(usize::try_from(cap / 10 * 9).unwrap(), 2);
    put(&s.media, "image/png", big).await;
    assert_eq!(s.media.lookup(&a.id).await.unwrap(), Lookup::Evicted);
    assert!(!path.exists(), "an evicted original takes its thumbnails");
}

#[tokio::test]
async fn a_thumbnail_that_would_pass_the_cap_is_served_and_not_kept() {
    let cap = crate::media::MIN_MAX_BYTES;
    let s = open(cap).await;
    let a = put(&s.media, "image/png", png_of(300, 300)).await;
    let mut filler = b"\x89PNG\r\n\x1a\n".to_vec();
    filler.resize(usize::try_from(cap - a.size - 1000).unwrap(), 3);
    put(&s.media, "image/png", filler).await;
    s.media.thumbnail(&a, 192).await.unwrap().unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(!address(&s.dir.join("media"), &a.id, 192).unwrap().exists());
}

#[tokio::test]
async fn a_restart_counts_the_kept_thumbnails_and_drops_those_of_gone_files() {
    let s = open(crate::media::DEFAULT_MAX_BYTES).await;
    let root = s.dir.join("media");
    let a = put(&s.media, "image/png", png_of(400, 300)).await;
    s.media.thumbnail(&a, 96).await.unwrap().unwrap();
    let path = address(&root, &a.id, 96).unwrap();
    assert!(kept(&path, true).await);
    // the original vanishes while the server is down
    std::fs::remove_file(s.media.path_of(&a.id).unwrap()).unwrap();
    let (again, _task) = Media::open(
        &s.dir,
        s.store.clone(),
        crate::media::DEFAULT_MAX_BYTES,
        crate::telemetry::Sender::detached(),
        tokio_util::sync::CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(again.lookup(&a.id).await.unwrap(), Lookup::Evicted);
    assert!(!path.exists());
}

/// the pixel check's hook (`scripts/thumb-check.ts`): into `THUMB_CHECK_DIR`,
/// the test images (made once; the script adds lossy webp from chromium's
/// encoder), every ladder thumbnail of each, and `manifest.json`. png and
/// webp go through `scale`, the server's own path; jpeg, which the server
/// never scales, through the same downscale and a quality 90 re-encode, so
/// its numbers say why it answers the original.
#[test]
#[ignore = "writes the pixel check's set; run by scripts/thumb-check.ts"]
fn pixel_check_set() {
    let dir = PathBuf::from(std::env::var("THUMB_CHECK_DIR").unwrap());
    std::fs::create_dir_all(&dir).unwrap();
    if !dir.join("photo.png").exists() {
        for (name, w, h, seed) in [
            ("photo", 2000, 1333, 1),
            ("tall", 1023, 2047, 2),
            ("wide", 3001, 401, 3),
            ("small", 300, 211, 4),
        ] {
            let image = DynamicImage::ImageRgb8(photo(w, h, seed));
            for (ext, format) in [
                ("png", ImageFormat::Png),
                ("jpg", ImageFormat::Jpeg),
                ("webp", ImageFormat::WebP),
            ] {
                std::fs::write(dir.join(format!("{name}.{ext}")), encoded(&image, format)).unwrap();
            }
        }
        let lines = DynamicImage::ImageRgb8(text(1600, 901));
        std::fs::write(dir.join("text.png"), encoded(&lines, ImageFormat::Png)).unwrap();
        std::fs::write(dir.join("text.jpg"), encoded(&lines, ImageFormat::Jpeg)).unwrap();
        let clear = DynamicImage::ImageRgba8(alpha(1201, 777));
        std::fs::write(dir.join("alpha.png"), encoded(&clear, ImageFormat::Png)).unwrap();
        std::fs::write(dir.join("alpha.webp"), encoded(&clear, ImageFormat::WebP)).unwrap();
    }
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| {
            let stem = n.rsplit_once('.').map_or(n.as_str(), |(stem, _)| stem);
            let thumb = stem
                .rsplit_once(".w")
                .is_some_and(|(_, w)| w.parse::<u32>().is_ok());
            !thumb && [".png", ".jpg", ".webp"].iter().any(|x| n.ends_with(x))
        })
        .filter(|n| !n.starts_with("check-"))
        .collect();
    names.sort();
    let mut images = Vec::new();
    for name in names {
        let (stem, ext) = name.rsplit_once('.').unwrap();
        let bytes = std::fs::read(dir.join(&name)).unwrap();
        let original = image::load_from_memory(&bytes).unwrap();
        let (width, height) = (original.width(), original.height());
        let mut thumbs = Vec::new();
        for w in LADDER.into_iter().filter(|&w| w < width) {
            let h = height_at(width, height, w);
            let made = match ext {
                "png" => scale(Format::Png, &bytes, w),
                "webp" => scale(Format::Webp, &bytes, w),
                _ => {
                    let small = DynamicImage::ImageRgba8(downscale(original.to_rgba8(), w, h));
                    let mut out = Vec::new();
                    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90)
                        .encode_image(&small.to_rgb8())
                        .unwrap();
                    Scaled::Thumb(out)
                }
            };
            let Scaled::Thumb(made) = made else {
                panic!("{name} at {w} answered the original: not a scalable test image");
            };
            let file = format!("{stem}.w{w}.{ext}");
            std::fs::write(dir.join(&file), made).unwrap();
            thumbs.push(serde_json::json!({ "w": w, "h": h, "file": file }));
        }
        images.push(serde_json::json!({
            "name": name, "format": ext, "width": width, "height": height, "thumbs": thumbs,
        }));
    }
    let manifest = serde_json::json!({ "images": images });
    std::fs::write(dir.join("manifest.json"), manifest.to_string()).unwrap();
}
