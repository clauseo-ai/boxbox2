//! the http surface: the gate, the api, the app, and one log line per
//! request.

pub mod agents;
pub mod asks;
pub mod assets;
pub mod compose;
pub mod compress;
pub mod error;
pub mod fleet;
pub mod history;
pub mod hosts;
pub mod login;
pub mod media;
pub mod needs;
pub mod openapi;
pub mod prefs;
pub mod push;
pub mod repo_icon;
pub mod review;
pub mod session;
pub mod stream;
pub mod telemetry;
pub mod threads;

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Router;
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::HeaderValue;
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{any, get, post};

use crate::pty::routes as pty;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info};

use crate::auth::Auth;
use crate::fleet::Fleet;
use crate::upstream::Upstreams;
use crate::wire::Capability;
use assets::Assets;
use error::ApiError;

/// what every route may read. each part has its own owner; nothing here is
/// mutable.
#[derive(Debug)]
pub struct AppState {
    pub auth: Auth,
    pub upstreams: Upstreams,
    pub fleet: Fleet,
    /// for reads the server makes of a host on a client's behalf.
    pub client: reqwest::Client,
    pub telemetry: crate::telemetry::Sender,
    pub push: crate::push::Push,
    /// `boxbox.db`'s writer: paired hosts and prefs go through it.
    pub store: crate::store::Store,
    /// the terminal relays and what they share.
    pub terminals: crate::pty::Terminals,
    pub assets: Assets,
    /// repo favicons, found on their hosts once and remembered (`icons/`).
    pub icons: crate::icons::Icons,
    /// the media store (`media/`): uploads, agents' copies, the files served by id.
    pub media: crate::media::Media,
    /// new threads by client id, so a retried birth makes no second thread.
    pub births: compose::Births,
    /// the thread summaries (`fleet/summary.rs`).
    pub summaries: crate::fleet::summary::Summaries,
    /// contract 2's sends by agent and client id, so none runs twice.
    pub sends: crate::source::sends::Sends,
    /// the board's channel, only with `[board]` in `boxbox.toml`.
    pub board: Option<Arc<crate::board::Board>>,
    /// the event streams holding a gzip context, at most 64.
    pub gzip_streams: compress::GzipStreams,
    /// fired at shutdown; streams end on it.
    pub shutdown: CancellationToken,
}

/// the id `log_request` gave a request, for the routes that log a line of
/// their own about it.
#[derive(Debug, Clone)]
pub struct RequestId(pub Arc<str>);

/// a login or any other small json body; nothing legitimate is larger.
const SMALL_BODY: usize = 64 * 1024;
/// 500 events of a few hundred bytes each, with room to spare.
const TELEMETRY_BODY: usize = 1024 * 1024;
/// a message of 100,000 characters, most of them multibyte, in json (under 1 MiB), with the photos and
/// files of one message as data urls: at most 24 MiB together (`compose::MAX_ATTACHMENTS_TOTAL`: four
/// resized jpegs, or two heic originals or two pdfs at the limit).
const PROMPT_BODY: usize = 25 * 1024 * 1024;
const MIB: usize = 1024 * 1024;
/// the memory, in MiB, the routes may use for photos at once: two messages at the body limit, each counted twice
/// (`photo_weight`). it is a limit on what the process can reach and not on what it is told, so the peak above an
/// idle server is this and no more however many phones send together (`architecture.md`, memory).
pub(crate) const PHOTO_BUDGET_MIB: usize = 2 * 2 * (PROMPT_BODY / MIB);
/// how long a message with photos waits for room before it is turned away. nothing of it has been read while it
/// waits, so waiting holds no memory, and a message behind two others that are being converted goes when they
/// are done. the device's post is given this on top of everything else it waits for (`postBudgetMs`).
const PHOTO_WAIT: Duration = Duration::from_secs(120);
/// a body this small carries no photo worth counting: words never wait for photos.
const PHOTO_WEIGHT_FLOOR: usize = 256 * 1024;

pub fn router(state: Arc<AppState>) -> Router {
    router_waiting(state, PHOTO_WAIT)
}

/// the router, with `photo_wait` as the time a message with photos waits for room (the tests make it short)
#[allow(
    clippy::too_many_lines,
    reason = "the route table is one list, read top to bottom"
)]
fn router_waiting(state: Arc<AppState>, photo_wait: Duration) -> Router {
    let photos = PhotoBudget {
        room: Arc::new(Semaphore::new(PHOTO_BUDGET_MIB)),
        wait: photo_wait,
    };
    let gated = Router::new()
        .route("/api/hosts", get(hosts::list))
        .route("/api/hosts/pair", post(hosts::pair))
        .route("/api/hosts/{host}", axum::routing::delete(hosts::forget))
        .route("/api/hosts/{host}/reload", post(hosts::reload))
        .route("/api/hosts/{host}/restart", post(hosts::restart))
        .route("/api/hosts/{host}/models", get(hosts::models))
        .route("/api/prefs", get(prefs::all))
        .route(
            "/api/prefs/devices/{device}",
            axum::routing::put(prefs::device),
        )
        .route("/api/prefs/repos", axum::routing::put(prefs::repo))
        .route("/api/prefs/colours", axum::routing::put(prefs::colour))
        .route(
            "/api/prefs/models",
            axum::routing::put(prefs::favorite_models),
        )
        .route("/api/stream", get(stream::stream))
        .route("/api/stream/{stream}/interest", post(stream::interest))
        .route("/api/fleet", get(fleet::snapshot))
        .route(
            "/api/hosts/{host}/sessions/{session}/messages/{message}",
            axum::routing::delete(session::unsend),
        )
        .merge(lifecycle())
        .route("/api/needs", get(needs::list))
        .route("/api/read", post(needs::read))
        .route(
            "/api/hosts/{host}/permissions/{ask}",
            post(asks::permission),
        )
        .route("/api/hosts/{host}/questions/{ask}", post(asks::question))
        .route(
            "/api/hosts/{host}/questions/{ask}/reject",
            post(asks::reject),
        )
        .route(
            "/api/hosts/{host}/sessions/{session}/prompt",
            post(asks::prompt)
                .layer(DefaultBodyLimit::max(PROMPT_BODY))
                .layer(middleware::from_fn_with_state(photos.clone(), photo_budget)),
        )
        .route(
            "/api/hosts/{host}/sessions/{session}/steer",
            post(compose::steer)
                .layer(DefaultBodyLimit::max(PROMPT_BODY))
                .layer(middleware::from_fn_with_state(photos.clone(), photo_budget)),
        )
        .route(
            "/api/hosts/{host}/sessions/{session}/shell",
            post(compose::shell),
        )
        .route(
            "/api/hosts/{host}/sessions/{session}/command",
            post(compose::command),
        )
        .route(
            "/api/hosts/{host}/sessions",
            post(compose::start)
                .layer(DefaultBodyLimit::max(PROMPT_BODY))
                .layer(middleware::from_fn_with_state(photos.clone(), photo_budget)),
        )
        .route("/api/hosts/{host}/commands", get(compose::commands))
        .route("/api/hosts/{host}/projects", get(compose::projects))
        .route("/api/hosts/{host}/folders", get(compose::folders))
        .route(
            "/api/hosts/{host}/sessions/{session}/abort",
            post(asks::abort),
        )
        .route(
            "/api/hosts/{host}/sessions/{session}/compact",
            post(asks::compact),
        )
        .route(
            "/api/hosts/{host}/sessions/{session}/queue",
            post(session::queue).layer(DefaultBodyLimit::max(session::SEND_BODY)),
        )
        .route(
            "/api/hosts/{host}/sessions/{session}/loop",
            post(session::run_now),
        )
        .route(
            "/api/hosts/{host}/sessions/{session}/review",
            get(review::show),
        )
        .route(
            "/api/hosts/{host}/sessions/{session}/review/merge",
            post(review::merge),
        )
        .route(
            "/api/hosts/{host}/sessions/{session}/review/discard",
            post(review::discard),
        )
        .route("/api/hosts/{host}/providers", get(session::providers))
        .route("/api/hosts/{host}/find/file", get(session::find_file))
        .route("/api/push", get(push::state))
        .route("/api/push/subscribe", post(push::subscribe))
        .route("/api/push/unsubscribe", post(push::unsubscribe))
        .route("/api/push/test", post(push::test))
        .route("/api/presence", post(push::presence))
        .route("/api/hosts/{host}/pty", get(pty::list).post(pty::create))
        .route("/api/hosts/{host}/pty/shells", get(pty::shells))
        .route(
            "/api/hosts/{host}/pty/{id}",
            get(pty::one).put(pty::update).delete(pty::kill),
        )
        .route("/api/hosts/{host}/pty/{id}/connect", get(pty::connect))
        .route(
            "/api/telemetry",
            post(telemetry::ingest).layer(DefaultBodyLimit::max(TELEMETRY_BODY)),
        )
        .merge(contract_two(&state))
        .merge(board_routes(&state))
        .route_layer(middleware::from_fn_with_state(
            Arc::clone(&state),
            require_session,
        ))
        // after the gate, so a refusal is compressed like any answer; json only (compress.rs), so the stream is not
        .layer(compress::layer());
    // its own router, so the headers that make an svg harmless wrap every answer
    // it gives, the sign-in refusal and the errors included
    let repo_icon = Router::new()
        .route("/api/hosts/{host}/repo-icon", get(repo_icon::repo_icon))
        .merge(
            Router::new()
                .route("/api/agents/{agent}/repo-icon", get(repo_icon::repo_icon))
                .route_layer(middleware::from_fn_with_state(
                    (Arc::clone(&state), Capability::Places),
                    agents::guard,
                )),
        )
        .route_layer(middleware::from_fn_with_state(
            Arc::clone(&state),
            require_session,
        ))
        .layer(middleware::map_response(repo_icon::isolated));
    // the media routes take their own bodies (streamed, 64 MiB, `media/`) and wear the icon route's headers on every
    // answer, since a stored svg is a document; json errors only, so nothing to compress
    let media = Router::new()
        .route("/api/media", post(media::upload))
        .route("/api/media/{id}", get(media::serve))
        .route_layer(middleware::from_fn_with_state(
            Arc::clone(&state),
            require_session,
        ))
        .layer(middleware::map_response(repo_icon::isolated));
    Router::new()
        .route("/api/login", post(login::login))
        .route("/api/logout", post(login::logout))
        .merge(gated)
        .merge(repo_icon)
        .merge(media)
        .route("/api/{*rest}", any(no_such_route))
        .fallback(assets::serve)
        .layer(DefaultBodyLimit::max(SMALL_BODY))
        .layer(middleware::from_fn(log_request))
        .with_state(state)
}

/// the board's routes, with `[board]` only: without it they are no route at
/// all, and `/api/{*rest}` answers 404 (`docs/board.md`).
fn board_routes(state: &AppState) -> Router<Arc<AppState>> {
    if state.board.is_none() {
        return Router::new();
    }
    Router::new()
        .route("/api/board/act", post(crate::board::routes::act))
        .route("/api/board/pin", post(crate::board::routes::pin))
}

/// what a message with photos takes of the budget, in MiB: twice its size, since while it is parsed the server holds the
/// bytes it came in and the strings read from them (and, a moment later, the value and the body written from it). none
/// for a body too small to carry a photo
fn photo_weight(announced: usize) -> Option<u32> {
    if announced <= PHOTO_WEIGHT_FLOOR {
        return None;
    }
    u32::try_from(2 * announced.min(PROMPT_BODY).div_ceil(MIB)).ok()
}

/// the room photos may take on the server, and how long a message waits for it
#[derive(Clone)]
struct PhotoBudget {
    room: Arc<Semaphore>,
    wait: Duration,
}

/// takes a place in the photo budget by the size of the body the request announces, before a byte of it is read, and
/// keeps it until the answer has gone. a body that does not say its size is counted at the most a route takes. a message
/// that does not fit the room left waits for it (nothing is held while it does, so the wait costs no memory), and one
/// that has not had its turn within the wait is turned away with a 503 that says so.
async fn photo_budget(
    State(budget): State<PhotoBudget>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let announced = request
        .headers()
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(PROMPT_BODY);
    let Some(weight) = photo_weight(announced) else {
        return Ok(next.run(request).await);
    };
    let started = Instant::now();
    let taken = tokio::time::timeout(
        budget.wait,
        Arc::clone(&budget.room).acquire_many_owned(weight),
    )
    .await;
    let waited_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let Ok(Ok(_permit)) = taken else {
        info!(
            weight,
            waited_ms, "a message with photos was turned away: the photo budget stayed in use"
        );
        return Err(ApiError::PhotosBusy);
    };
    if waited_ms > 50 {
        info!(
            weight,
            waited_ms, "a message with photos waited for room in the photo budget"
        );
    }
    Ok(next.run(request).await)
}

/// contract 2's routes, `/api/agents/{agent}/...`: one per verb through the
/// trait (`agents/routes.rs`), and the cmx2-only capabilities through
/// contract 1's handlers behind the same check (`agents::guard`).
#[allow(
    clippy::too_many_lines,
    reason = "the route table is one list, read top to bottom"
)]
fn contract_two(state: &Arc<AppState>) -> Router<Arc<AppState>> {
    use agents::routes as v2;
    const T: &str = "/api/agents/{agent}/threads/{thread}";
    let at = |tail: &str| format!("{T}{tail}");
    let guarded = |state: &Arc<AppState>, capability: Capability| {
        middleware::from_fn_with_state((Arc::clone(state), capability), agents::guard)
    };
    let trait_routes = Router::new()
        .route("/api/agents", get(v2::list))
        .route(
            "/api/agents/{agent}/threads",
            post(v2::start).layer(DefaultBodyLimit::max(session::SEND_BODY)),
        )
        .route(
            &at("/prompt"),
            post(v2::prompt).layer(DefaultBodyLimit::max(session::SEND_BODY)),
        )
        .route(
            &at("/steer"),
            post(v2::steer).layer(DefaultBodyLimit::max(session::SEND_BODY)),
        )
        .route(
            &at("/queue"),
            post(v2::queue).layer(DefaultBodyLimit::max(session::SEND_BODY)),
        )
        .route(&at("/abort"), post(v2::abort))
        .route(&at("/compact"), post(v2::compact))
        .route(&at("/run-now"), post(v2::run_now))
        .route(&at("/messages"), get(agents::read::messages))
        .route(&at("/summary"), get(agents::summary::summary))
        .route(
            &at("/messages/{message}"),
            get(agents::read::message).delete(v2::unsend),
        )
        .route(
            &at("/messages/{message}/reactions"),
            axum::routing::put(v2::react),
        )
        .route(
            &at("/btw"),
            get(agents::btw::btw_list).post(agents::btw::btw_ask),
        )
        .route(&at("/btw/{btw}/dismiss"), post(agents::btw::btw_dismiss))
        .route(&at("/btw/{btw}/promote"), post(agents::btw::btw_promote))
        .route(&at("/archive"), post(v2::archive))
        .route(&at("/adopt"), post(v2::adopt))
        .route("/api/agents/{agent}/asks/{id}", post(v2::answer))
        .route("/api/agents/{agent}/models", get(v2::models))
        .route("/api/connections/pair", post(v2::pair))
        .route(
            "/api/connections/{name}",
            axum::routing::delete(hosts::forget),
        );
    let commands = Router::new()
        .route("/api/agents/{agent}/commands", get(compose::commands))
        .route(&at("/command"), post(compose::command))
        .route_layer(guarded(state, Capability::Commands));
    let shell = Router::new()
        .route(&at("/shell"), post(compose::shell))
        .route_layer(guarded(state, Capability::Shell));
    let places = Router::new()
        .route("/api/agents/{agent}/projects", get(compose::projects))
        .route("/api/agents/{agent}/folders", get(compose::folders))
        .route_layer(guarded(state, Capability::Places));
    let files = Router::new()
        .route("/api/agents/{agent}/find/file", get(session::find_file))
        .route_layer(guarded(state, Capability::Files));
    let review = Router::new()
        .route(&at("/review"), get(review::show))
        .route(&at("/review/merge"), post(review::merge))
        .route(&at("/review/discard"), post(review::discard))
        .route_layer(guarded(state, Capability::Review));
    let admin = Router::new()
        .route("/api/agents/{agent}/reload", post(hosts::reload))
        .route("/api/agents/{agent}/restart", post(hosts::restart))
        .route_layer(guarded(state, Capability::Admin));
    let terminal = Router::new()
        .route("/api/agents/{agent}/pty", get(pty::list).post(pty::create))
        .route("/api/agents/{agent}/pty/shells", get(pty::shells))
        .route(
            "/api/agents/{agent}/pty/{id}",
            get(pty::one).put(pty::update).delete(pty::kill),
        )
        .route("/api/agents/{agent}/pty/{id}/connect", get(pty::connect))
        .route_layer(guarded(state, Capability::Terminal));
    trait_routes
        .merge(commands)
        .merge(shell)
        .merge(places)
        .merge(files)
        .merge(review)
        .merge(admin)
        .merge(terminal)
}

/// threads leaving and returning: history, clearing off home, archive, and
/// opening one the fleet does not hold.
fn lifecycle() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/history", get(history::page))
        .route("/api/clear", post(threads::clear))
        .route(
            "/api/hosts/{host}/sessions/{session}/archive",
            post(threads::archive),
        )
        .route(
            "/api/hosts/{host}/sessions/{session}/adopt",
            post(threads::adopt),
        )
}

async fn require_session(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    match state.auth.token_in(request.headers()) {
        Some(token) if state.auth.verify(token, crate::now_ms()) => Ok(next.run(request).await),
        _ => Err(ApiError::SignInFirst),
    }
}

async fn no_such_route() -> ApiError {
    ApiError::NotFound
}

/// one line per request: id, method, path, status, latency. api calls log
/// at info; app files at debug, since a cold load fetches a dozen.
async fn log_request(mut request: Request, next: Next) -> Response {
    let started = Instant::now();
    let id = format!("{:08x}", rand::random::<u32>());
    request
        .extensions_mut()
        .insert(RequestId(Arc::from(id.as_str())));
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let mut response = next.run(request).await;
    let status = response.status().as_u16();
    let latency_ms = started.elapsed().as_secs_f64() * 1000.0;
    if path.starts_with("/api/") {
        info!(request = %id, %method, %path, status, latency_ms = format_args!("{latency_ms:.1}"), "request");
    } else {
        debug!(request = %id, %method, %path, status, latency_ms = format_args!("{latency_ms:.1}"), "request");
    }
    if let Ok(value) = HeaderValue::from_str(&id) {
        response.headers_mut().insert("x-request-id", value);
    }
    response
}

#[cfg(test)]
pub(crate) mod tests {
    use std::net::SocketAddr;

    use tokio::sync::mpsc;

    use super::*;
    use crate::config::{CookieConfig, Secret};
    use crate::fleet::Fleet;
    use crate::upstream::Upstreams;

    pub(crate) const PASSWORD: &str = "a long enough password";

    /// the real router on a local port, with nothing behind it: no hosts, no
    /// fleet, no store. what these tests judge is how the router wraps a route.
    async fn serve() -> SocketAddr {
        serve_waiting(PHOTO_WAIT).await
    }

    /// the same, with a message that is waiting for room in the photo budget given `photo_wait` for it
    async fn serve_waiting(photo_wait: Duration) -> SocketAddr {
        serve_hosts(photo_wait, Vec::new()).await
    }

    /// the same, watching `views`.
    async fn serve_hosts(
        photo_wait: Duration,
        views: Vec<crate::upstream::HostView>,
    ) -> SocketAddr {
        serve_state(
            photo_wait,
            Upstreams::fixed(views, Vec::new(), Vec::new()),
            crate::source::sends::Sends::new(mpsc::channel(1).0),
            crate::media::Media::detached(),
            crate::store::Store::detached(),
            Fleet::detached(),
        )
        .await
    }

    /// the real router on a local port over `upstreams`, with `sends` as
    /// its send ledger and `media` as its store.
    pub(crate) async fn serve_state(
        photo_wait: Duration,
        upstreams: Upstreams,
        sends: crate::source::sends::Sends,
        media: crate::media::Media,
        store: crate::store::Store,
        fleet: Fleet,
    ) -> SocketAddr {
        serve_board(photo_wait, upstreams, sends, media, store, fleet, None).await
    }

    /// the same, with the board's channel when `board` is set.
    pub(crate) async fn serve_board(
        photo_wait: Duration,
        upstreams: Upstreams,
        sends: crate::source::sends::Sends,
        media: crate::media::Media,
        store: crate::store::Store,
        fleet: Fleet,
        board: Option<Arc<crate::board::Board>>,
    ) -> SocketAddr {
        let client = reqwest::Client::new();
        let shutdown = CancellationToken::new();
        let (icons, _task) = crate::icons::spawn(client.clone(), fleet.clone(), shutdown.clone());
        let state = Arc::new(AppState {
            auth: Auth::new(
                [7; 32],
                &Secret::new(PASSWORD.into()),
                CookieConfig {
                    name: "boxbox_test".into(),
                    secure: false,
                },
            ),
            upstreams,
            fleet,
            client,
            telemetry: crate::telemetry::Sender::detached(),
            push: crate::push::Push::detached(),
            store,
            terminals: crate::pty::Terminals::new().unwrap(),
            assets: Assets::Embedded,
            icons,
            media,
            births: compose::Births::default(),
            summaries: crate::fleet::summary::Summaries::new(),
            sends,
            board,
            gzip_streams: compress::GzipStreams::default(),
            shutdown,
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                router_waiting(state, photo_wait)
                    .into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });
        addr
    }

    /// signs in through the real login route and returns the cookie to send back.
    pub(crate) async fn sign_in(addr: SocketAddr) -> String {
        let answer = reqwest::Client::new()
            .post(format!("http://{addr}/api/login"))
            .header("content-type", "application/json")
            .body(serde_json::json!({ "password": PASSWORD }).to_string())
            .send()
            .await
            .unwrap();
        assert_eq!(answer.status(), 200);
        let set = answer.headers()[reqwest::header::SET_COOKIE]
            .to_str()
            .unwrap();
        set.split(';').next().unwrap().to_owned()
    }

    fn isolated(answer: &reqwest::Response) -> bool {
        answer
            .headers()
            .get("x-content-type-options")
            .map(axum::http::HeaderValue::as_bytes)
            == Some(b"nosniff")
            && answer
                .headers()
                .get("content-security-policy")
                .map(axum::http::HeaderValue::as_bytes)
                == Some(repo_icon::POLICY.as_bytes())
    }

    /// a prompt on its way: the head has gone, the body is being written, and the connection stays open until this is dropped
    struct OnItsWay {
        read: tokio::net::tcp::OwnedReadHalf,
        writing: tokio::task::JoinHandle<()>,
    }

    impl Drop for OnItsWay {
        fn drop(&mut self) {
            self.writing.abort();
        }
    }

    impl OnItsWay {
        /// the status of the answer, when it comes
        async fn status(&mut self) -> u16 {
            use tokio::io::AsyncReadExt;
            let mut line = [0u8; 12];
            self.read.read_exact(&mut line).await.unwrap();
            String::from_utf8_lossy(&line[9..12]).parse().unwrap()
        }
    }

    /// sends the head of a prompt that announces `announced` bytes of body and, in the background, the first `sent` of them
    /// (a server that is waiting to take it does not read them, so the writing must not hold the test up)
    async fn announce(addr: SocketAddr, cookie: &str, announced: usize, sent: usize) -> OnItsWay {
        use tokio::io::AsyncWriteExt;
        let stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let (read, mut write) = stream.into_split();
        let head = format!(
            "POST /api/hosts/desk/sessions/ses_a/prompt HTTP/1.1\r\nhost: boxbox\r\ncookie: {cookie}\r\ncontent-type: application/json\r\ncontent-length: {announced}\r\n\r\n"
        );
        let writing = tokio::spawn(async move {
            let _ = write.write_all(head.as_bytes()).await;
            let _ = write.write_all(&vec![b' '; sent]).await;
            // the connection stays open: closing it would end the body early, and with it the message's place in the budget
            std::future::pending::<()>().await;
        });
        tokio::time::sleep(Duration::from_millis(150)).await;
        OnItsWay { read, writing }
    }

    #[test]
    fn a_message_is_counted_twice_over_and_the_budget_holds_two_at_the_limit() {
        assert_eq!(photo_weight(2), None);
        assert_eq!(photo_weight(PHOTO_WEIGHT_FLOOR), None);
        assert_eq!(photo_weight(PHOTO_WEIGHT_FLOOR + 1), Some(2));
        assert_eq!(photo_weight(24 * MIB), Some(48));
        assert_eq!(photo_weight(24 * MIB + 1), Some(50));
        // a body is never counted past what the routes take
        assert_eq!(photo_weight(40 * MIB), photo_weight(PROMPT_BODY));
        assert_eq!(
            2 * photo_weight(PROMPT_BODY).unwrap() as usize,
            PHOTO_BUDGET_MIB
        );
    }

    #[tokio::test]
    async fn photos_in_flight_are_bounded_and_a_message_that_gets_no_room_is_turned_away_after_its_wait()
     {
        let addr = serve_waiting(Duration::from_millis(400)).await;
        let cookie = sign_in(addr).await;
        // two messages at the limit hold the whole budget while their bodies are still coming
        let _first = announce(addr, &cookie, 24 * MIB, 0).await;
        let _second = announce(addr, &cookie, 24 * MIB, 0).await;
        // a third waits for room, and when none comes it is turned away in words that say so (a 503 of its own kind)
        let started = Instant::now();
        let mut third = announce(addr, &cookie, 8 * MIB, 0).await;
        assert_eq!(third.status().await, 503);
        assert!(started.elapsed() >= Duration::from_millis(400));
        // words are never counted: a small message goes through whatever photos are in flight
        let mut words = announce(addr, &cookie, 2, 2).await;
        assert_ne!(words.status().await, 503);
    }

    #[tokio::test]
    async fn a_message_waits_for_room_and_goes_when_another_ends() {
        let addr = serve_waiting(Duration::from_secs(10)).await;
        let cookie = sign_in(addr).await;
        let first = announce(addr, &cookie, 24 * MIB, 0).await;
        let _second = announce(addr, &cookie, 24 * MIB, 0).await;
        // the third waits (it is not turned away) and takes the room the first gives up
        let mut third = announce(addr, &cookie, 8 * MIB, 8 * MIB).await;
        drop(first);
        // its body is not json: the answer is the route's own refusal, which only a message that was let in can get
        assert_eq!(third.status().await, 400);
    }

    #[tokio::test]
    async fn a_message_is_read_into_one_buffer_and_refused_in_words_when_it_is_not_one() {
        let addr = serve().await;
        let cookie = sign_in(addr).await;
        let post = |kind: &'static str, body: String| {
            let cookie = cookie.clone();
            async move {
                reqwest::Client::new()
                    .post(format!(
                        "http://{addr}/api/hosts/desk/sessions/ses_a/prompt"
                    ))
                    .header("cookie", cookie)
                    .header("content-type", kind)
                    .body(body)
                    .send()
                    .await
                    .unwrap()
            }
        };
        let plain = post("text/plain", "hello".into()).await;
        assert_eq!(plain.status(), 400);
        let empty = post("application/json", "{}".into()).await;
        assert_eq!(empty.status(), 400);
        let said = empty.text().await.unwrap();
        assert!(said.contains("not a message boxbox can read"), "{said}");
        // a body announced past what the routes take is refused before it is read
        let mut big = announce(addr, &cookie, 26 * MIB, 0).await;
        assert_eq!(big.status().await, 413);
    }

    #[tokio::test]
    async fn the_sign_in_refusal_of_the_icon_route_carries_nosniff_and_the_policy() {
        let addr = serve().await;
        let answer = reqwest::get(format!(
            "http://{addr}/api/hosts/desk/repo-icon?root=/work/app"
        ))
        .await
        .unwrap();
        assert_eq!(answer.status(), 401);
        assert!(isolated(&answer), "{:?}", answer.headers());
    }

    #[tokio::test]
    async fn the_errors_of_a_signed_in_icon_request_carry_them_too() {
        let addr = serve().await;
        let cookie = sign_in(addr).await;
        let get = |query: &'static str, host: &'static str| {
            let cookie = cookie.clone();
            async move {
                reqwest::Client::new()
                    .get(format!("http://{addr}/api/hosts/{host}/repo-icon?{query}"))
                    .header("cookie", cookie)
                    .send()
                    .await
                    .unwrap()
            }
        };
        let bad_root = get("root=/", "desk").await;
        assert_eq!(bad_root.status(), 400);
        assert!(isolated(&bad_root), "{:?}", bad_root.headers());
        let unknown_host = get("root=/work/app", "nowhere").await;
        assert_eq!(unknown_host.status(), 404);
        assert!(isolated(&unknown_host), "{:?}", unknown_host.headers());
    }

    #[tokio::test]
    async fn the_media_routes_refuse_a_stranger_with_nosniff_and_the_policy() {
        let addr = serve().await;
        let fetch = reqwest::get(format!("http://{addr}/api/media/{}", "a".repeat(64)))
            .await
            .unwrap();
        assert_eq!(fetch.status(), 401);
        assert!(isolated(&fetch), "{:?}", fetch.headers());
        let upload = reqwest::Client::new()
            .post(format!("http://{addr}/api/media"))
            .header("content-type", "image/png")
            .body(vec![0u8; 16])
            .send()
            .await
            .unwrap();
        assert_eq!(upload.status(), 401);
        assert!(isolated(&upload), "{:?}", upload.headers());
    }

    #[tokio::test]
    async fn a_signed_in_media_refusal_wears_them_too() {
        let addr = serve().await;
        let cookie = sign_in(addr).await;
        let answer = reqwest::Client::new()
            .get(format!("http://{addr}/api/media/not-an-id"))
            .header("cookie", cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(answer.status(), 400);
        assert!(isolated(&answer), "{:?}", answer.headers());
    }

    #[tokio::test]
    async fn no_other_route_wears_the_icon_policy() {
        let addr = serve().await;
        let answer = reqwest::get(format!("http://{addr}/api/hosts"))
            .await
            .unwrap();
        assert_eq!(answer.status(), 401);
        assert!(
            answer.headers().get("content-security-policy").is_none(),
            "the layer belongs to the icon route alone"
        );
    }

    /// a cmx2 host whose agent can do nothing, at an address that answers
    /// nothing: whatever reaches the daemon fails as unreachable, so a 422
    /// proves the check ran first.
    fn incapable() -> crate::upstream::HostView {
        crate::upstream::HostView::detached(
            crate::config::HostConfig {
                name: "desk".into(),
                url: reqwest::Url::parse("http://127.0.0.1:9/").unwrap(),
                credential: None,
                origin: crate::config::Origin::Config,
            },
            crate::wire::Capabilities::default(),
        )
    }

    #[tokio::test]
    async fn every_gated_route_answers_422_unsupported_and_reaches_no_daemon() {
        let addr = serve_hosts(PHOTO_WAIT, vec![incapable()]).await;
        let cookie = sign_in(addr).await;
        let client = reqwest::Client::new();
        let send = serde_json::json!({"clientID": "0f1e2d3c-4b5a-6978", "text": "hi"});
        let routes: [(&str, &str, Option<serde_json::Value>, &str); 16] = [
            ("GET", "/api/hosts/desk/providers", None, "model"),
            ("GET", "/api/hosts/desk/models", None, "model"),
            ("GET", "/api/hosts/desk/find/file?query=a", None, "files"),
            (
                "GET",
                "/api/hosts/desk/commands?directory=/w",
                None,
                "commands",
            ),
            ("GET", "/api/hosts/desk/projects", None, "places"),
            ("GET", "/api/hosts/desk/folders?path=/w", None, "places"),
            ("GET", "/api/hosts/desk/pty", None, "terminal"),
            ("GET", "/api/hosts/desk/pty/shells", None, "terminal"),
            (
                "GET",
                "/api/hosts/desk/sessions/ses_1/review",
                None,
                "review",
            ),
            ("POST", "/api/hosts/desk/sessions/ses_1/loop", None, "queue"),
            (
                "POST",
                "/api/hosts/desk/sessions/ses_1/queue",
                Some(send.clone()),
                "queue",
            ),
            (
                "DELETE",
                "/api/hosts/desk/sessions/ses_1/messages/msg_1",
                None,
                "queue",
            ),
            (
                "POST",
                "/api/hosts/desk/sessions/ses_1/archive",
                None,
                "archive",
            ),
            (
                "POST",
                "/api/hosts/desk/sessions/ses_1/adopt",
                None,
                "history",
            ),
            ("POST", "/api/hosts/desk/reload", None, "admin"),
            ("POST", "/api/hosts/desk/restart", None, "admin"),
        ];
        for (method, path, body, capability) in routes {
            let mut request = client
                .request(method.parse().unwrap(), format!("http://{addr}{path}"))
                .header("cookie", &cookie)
                .header("origin", format!("http://{addr}"));
            if let Some(body) = body {
                request = request
                    .header("content-type", "application/json")
                    .body(body.to_string());
            }
            let answer = request.send().await.unwrap();
            assert_eq!(answer.status(), 422, "{method} {path}");
            let body: serde_json::Value =
                serde_json::from_slice(&answer.bytes().await.unwrap()).unwrap();
            assert_eq!(body["error"], "unsupported", "{method} {path}: {body}");
            assert_eq!(body["capability"], capability, "{method} {path}: {body}");
            assert!(
                body["message"]
                    .as_str()
                    .unwrap()
                    .starts_with("cmx · desk has no "),
                "{body}"
            );
        }
    }
}
