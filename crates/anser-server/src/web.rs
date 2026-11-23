use axum::Router;
use axum::extract::Path;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::get;

include!(concat!(env!("OUT_DIR"), "/embedded_web.rs"));

pub fn router() -> Router {
    Router::new()
        .route("/", get(|| async { Redirect::temporary("/login") }))
        .route("/login", get(entry))
        .route("/admin", get(entry))
        .route("/admin/", get(entry))
        .route("/admin/{*page}", get(entry))
        .route("/assets/anser/{*path}", get(asset))
}

async fn entry() -> Response {
    if let Some(bytes) = website("index.html") {
        (
            [
                (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                (header::CACHE_CONTROL, "no-cache"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
                (header::X_FRAME_OPTIONS, "DENY"),
                (header::CONTENT_SECURITY_POLICY, "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"),
                (header::REFERRER_POLICY, "no-referrer"),
            ],
            bytes,
        )
            .into_response()
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "The management frontend is missing from this development build.",
        )
            .into_response()
    }
}

async fn asset(Path(path): Path<String>) -> Response {
    let Some(bytes) = website(&path).filter(|_| !path.ends_with(".html")) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let content_type = match path.rsplit_once('.').map(|(_, extension)| extension) {
        Some("js" | "mjs") => "application/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("json") => "application/json",
        Some("txt" | "md") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    };
    (
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, "public, max-age=86400"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        bytes,
    )
        .into_response()
}
