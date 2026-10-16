//! the media routes over a real socket and a real store in the temp dir.
//! the gate in front of them is the router's (`http/mod.rs` tests prove the
//! sign-in refusal and its headers); here, what the routes answer.

use std::net::SocketAddr;

use axum::Router;
use axum::routing::{get, post};

use super::*;
use crate::store::tests::scratch;

struct Served {
    addr: SocketAddr,
    store: crate::store::Store,
    dir: std::path::PathBuf,
}

impl Drop for Served {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn served(cap: u64) -> Served {
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
    let app = Router::new()
        .route(
            "/api/media",
            post(
                |State(media): State<Media>, headers: HeaderMap, body: Body| async move {
                    take(&media, &headers, body).await
                },
            ),
        )
        .route(
            "/api/media/{id}",
            get(
                |State(media): State<Media>,
                 Path(id): Path<String>,
                 method: Method,
                 headers: HeaderMap| async move {
                    give(&media, &id, &method, &headers).await
                },
            ),
        )
        .with_state(media);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Served { addr, store, dir }
}

fn png(size: usize, seed: u8) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.resize(size, seed);
    bytes
}

async fn post_file(
    addr: SocketAddr,
    mime: &str,
    bytes: Vec<u8>,
    extra: &[(&str, &str)],
) -> reqwest::Response {
    let mut request = reqwest::Client::new()
        .post(format!("http://{addr}/api/media"))
        .header("content-type", mime)
        .body(bytes);
    for (name, value) in extra {
        request = request.header(*name, *value);
    }
    request.send().await.unwrap()
}

async fn fetch(addr: SocketAddr, id: &str, extra: &[(&str, &str)]) -> reqwest::Response {
    let mut request = reqwest::Client::new().get(format!("http://{addr}/api/media/{id}"));
    for (name, value) in extra {
        request = request.header(*name, *value);
    }
    request.send().await.unwrap()
}

async fn json(answer: reqwest::Response) -> serde_json::Value {
    serde_json::from_slice(&answer.bytes().await.unwrap()).unwrap()
}

fn header<'a>(answer: &'a reqwest::Response, name: &str) -> &'a str {
    answer
        .headers()
        .get(name)
        .map_or("", |v| v.to_str().unwrap())
}

#[tokio::test]
async fn an_upload_answers_its_object_and_the_same_bytes_answer_the_same() {
    let s = served(crate::media::DEFAULT_MAX_BYTES).await;
    let bytes = png(5000, 1);
    let first = post_file(
        s.addr,
        "image/png",
        bytes.clone(),
        &[("x-boxbox-filename", "caf%C3%A9%20menu.png")],
    )
    .await;
    assert_eq!(first.status(), 201);
    let object: serde_json::Value = json(first).await;
    assert_eq!(object["mime"], "image/png");
    assert_eq!(object["size"], 5000);
    assert_eq!(object["filename"], "café menu.png");
    assert!(object.get("durationMs").is_none());
    let again = post_file(s.addr, "image/png", bytes, &[]).await;
    assert_eq!(again.status(), 201);
    let same: serde_json::Value = json(again).await;
    assert_eq!(same, object);
}

#[tokio::test]
async fn a_voice_note_keeps_its_duration_and_waveform() {
    let s = served(crate::media::DEFAULT_MAX_BYTES).await;
    let mut note = b"\0\0\0\x20ftypM4A \0\0\0\0".to_vec();
    note.resize(9000, 5);
    let answer = post_file(
        s.addr,
        "audio/mp4",
        note,
        &[
            ("x-boxbox-duration-ms", "3500"),
            ("x-boxbox-waveform", "AID/"),
        ],
    )
    .await;
    assert_eq!(answer.status(), 201);
    let object: serde_json::Value = json(answer).await;
    assert_eq!(object["durationMs"], 3500);
    assert_eq!(object["waveform"], serde_json::json!([0, 128, 255]));
}

#[tokio::test]
async fn the_upload_refuses_in_words_what_it_cannot_take() {
    let s = served(crate::media::DEFAULT_MAX_BYTES).await;
    let lie = post_file(s.addr, "audio/mpeg", png(100, 2), &[]).await;
    assert_eq!(lie.status(), 415);
    let said: serde_json::Value = json(lie).await;
    assert_eq!(said["error"]["code"], "media-kind");
    assert!(
        said["error"]["message"]
            .as_str()
            .unwrap()
            .contains("its bytes are image/png")
    );
    let empty = post_file(s.addr, "image/png", Vec::new(), &[]).await;
    assert_eq!(empty.status(), 400);
    let long_wave = post_file(
        s.addr,
        "audio/mp4",
        vec![1; 10],
        &[("x-boxbox-waveform", &data_encoding::BASE64.encode(&[0; 65]))],
    )
    .await;
    assert_eq!(long_wave.status(), 400);
    let bad_type = post_file(s.addr, "not a type", vec![1; 10], &[]).await;
    assert_eq!(bad_type.status(), 400);
}

#[tokio::test]
async fn an_upload_announced_past_64_mib_is_refused_before_its_body_is_read() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let s = served(crate::media::DEFAULT_MAX_BYTES).await;
    let mut stream = tokio::net::TcpStream::connect(s.addr).await.unwrap();
    let head = format!(
        "POST /api/media HTTP/1.1\r\nhost: boxbox\r\ncontent-type: video/mp4\r\ncontent-length: {}\r\n\r\n",
        MEDIA_BODY + 1
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    let mut line = [0u8; 12];
    stream.read_exact(&mut line).await.unwrap();
    assert_eq!(&line[9..12], b"413");
}

#[tokio::test]
async fn a_file_is_served_whole_with_immutable_caching_and_one_range_as_206() {
    let s = served(crate::media::DEFAULT_MAX_BYTES).await;
    let bytes = png(200_000, 3);
    let object: serde_json::Value =
        json(post_file(s.addr, "image/png", bytes.clone(), &[]).await).await;
    let id = object["id"].as_str().unwrap();
    let whole = fetch(s.addr, id, &[]).await;
    assert_eq!(whole.status(), 200);
    assert_eq!(header(&whole, "accept-ranges"), "bytes");
    assert_eq!(
        header(&whole, "cache-control"),
        "private, max-age=31536000, immutable"
    );
    assert_eq!(header(&whole, "etag"), format!("\"{id}\""));
    assert_eq!(header(&whole, "content-type"), "image/png");
    assert_eq!(header(&whole, "content-disposition"), "inline");
    assert_eq!(whole.bytes().await.unwrap(), bytes);

    let part = fetch(s.addr, id, &[("range", "bytes=100-199")]).await;
    assert_eq!(part.status(), 206);
    assert_eq!(header(&part, "content-range"), "bytes 100-199/200000");
    assert_eq!(part.bytes().await.unwrap(), bytes[100..200]);

    let tail = fetch(s.addr, id, &[("range", "bytes=-10")]).await;
    assert_eq!(tail.status(), 206);
    assert_eq!(tail.bytes().await.unwrap(), bytes[199_990..]);

    let several = fetch(s.addr, id, &[("range", "bytes=0-1,5-6")]).await;
    assert_eq!(several.status(), 200);
    assert_eq!(several.bytes().await.unwrap().len(), 200_000);

    let beyond = fetch(s.addr, id, &[("range", "bytes=200000-")]).await;
    assert_eq!(beyond.status(), 416);
    assert_eq!(header(&beyond, "content-range"), "bytes */200000");

    let current = fetch(s.addr, id, &[("if-none-match", &format!("\"{id}\""))]).await;
    assert_eq!(current.status(), 304);

    let head = reqwest::Client::new()
        .head(format!("http://{}/api/media/{id}", s.addr))
        .send()
        .await
        .unwrap();
    assert_eq!(head.status(), 200);
    assert_eq!(header(&head, "content-length"), "200000");
}

#[tokio::test]
async fn a_document_is_an_attachment_with_its_name() {
    let s = served(crate::media::DEFAULT_MAX_BYTES).await;
    let object: serde_json::Value = json(
        post_file(
            s.addr,
            "text/csv",
            b"a,b\n1,2\n".to_vec(),
            &[("x-boxbox-filename", "r%C3%A9sum%C3%A9.csv")],
        )
        .await,
    )
    .await;
    let answer = fetch(s.addr, object["id"].as_str().unwrap(), &[]).await;
    assert_eq!(object["mime"], "text/csv", "the index keeps the type");
    assert_eq!(
        header(&answer, "content-type"),
        "application/octet-stream",
        "an attachment goes out as bytes"
    );
    assert_eq!(
        header(&answer, "content-disposition"),
        "attachment; filename=\"r_sum_.csv\"; filename*=UTF-8''r%C3%A9sum%C3%A9.csv"
    );
}

#[tokio::test]
async fn ids_that_are_not_ids_unknown_ids_and_evicted_ids_each_answer_their_own_refusal() {
    let s = served(2 * 1024 * 1024).await;
    let bad = fetch(s.addr, "NOT-AN-ID", &[]).await;
    assert_eq!(bad.status(), 400);
    let unknown = fetch(s.addr, &"0".repeat(64), &[]).await;
    assert_eq!(unknown.status(), 404);
    let said: serde_json::Value = json(unknown).await;
    assert_eq!(said["error"]["code"], "no-such-media");

    let old: serde_json::Value =
        json(post_file(s.addr, "image/png", png(1024 * 1024, 4), &[]).await).await;
    let old = old["id"].as_str().unwrap().to_owned();
    // a day passes and its send settled
    s.store
        .call(|c| {
            c.execute(
                "UPDATE media SET created = created - 2 * ?1, pinned_until = NULL",
                [crate::media::index::FLOOR_MS],
            )
        })
        .await
        .unwrap();
    let newer = post_file(s.addr, "image/png", png(1536 * 1024, 5), &[]).await;
    assert_eq!(newer.status(), 201);
    let gone = fetch(s.addr, &old, &[]).await;
    assert_eq!(gone.status(), 410);
    let said: serde_json::Value = json(gone).await;
    assert_eq!(said["error"]["code"], "media-evicted");

    // nothing old enough is left, so a third is refused and the store keeps what it has
    let full = post_file(s.addr, "image/png", png(1536 * 1024, 6), &[]).await;
    assert_eq!(full.status(), 507);
    let said: serde_json::Value = json(full).await;
    assert_eq!(said["error"]["code"], "media-full");
}
