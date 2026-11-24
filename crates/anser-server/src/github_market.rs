use std::time::Duration;

use anser_core::api::Page;
use axum::Json;
use axum::http::StatusCode;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio::sync::{OnceCell, Semaphore};

use crate::auth::Identity;
use crate::error::{ApiError, ApiQuery, ApiResult};

const SEARCH: &str = "https://api.github.com/search/repositories";
const PAGE_SIZE: u32 = 20;
static CLIENT: OnceCell<Client> = OnceCell::const_new();
static SEARCH_SLOTS: Semaphore = Semaphore::const_new(3);

#[derive(Deserialize)]
pub(crate) struct Search {
    q: Option<String>,
    cursor: Option<u32>,
}

#[derive(Deserialize)]
struct SearchResult {
    total_count: u32,
    items: Vec<Repository>,
}

#[derive(Deserialize, Serialize)]
pub(crate) struct Repository {
    full_name: String,
    description: Option<String>,
    stargazers_count: u32,
}

pub(crate) async fn search(
    identity: Identity,
    ApiQuery(query): ApiQuery<Search>,
) -> ApiResult<Json<Page<Repository>>> {
    identity.admin_global()?;
    let page = query.cursor.unwrap_or(1);
    if !(1..=50).contains(&page) {
        return Err(ApiError::bad("Invalid GitHub search page"));
    }
    let term = query.q.as_deref().unwrap_or_default().trim();
    let q = search_query(term)?;
    let _slot = SEARCH_SLOTS
        .try_acquire()
        .map_err(|_| ApiError::limited())?;
    let client = CLIENT
        .get_or_try_init(|| async {
            Client::builder()
                .user_agent("Anser-Plugin-Market")
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(10))
                .build()
        })
        .await
        .map_err(|_| unavailable())?;
    let mut endpoint = reqwest::Url::parse(SEARCH).map_err(|_| unavailable())?;
    endpoint
        .query_pairs_mut()
        .append_pair("q", &q)
        .append_pair("per_page", &PAGE_SIZE.to_string())
        .append_pair("page", &page.to_string());
    let mut request = client
        .get(endpoint)
        .header("Accept", "application/vnd.github+json");
    if let Ok(token) = std::env::var("ANSER_GITHUB_TOKEN")
        && !token.trim().is_empty()
    {
        request = request.bearer_auth(token.trim());
    }
    let response = request.send().await.map_err(|_| unavailable())?;
    if matches!(
        response.status(),
        StatusCode::FORBIDDEN | StatusCode::TOO_MANY_REQUESTS
    ) {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "github_rate_limited",
            "GitHub search limit reached",
        ));
    }
    let body = anser_channel_http::response(response)
        .await
        .map_err(|_| unavailable())?;
    let result: SearchResult = serde_json::from_slice(&body).map_err(|_| unavailable())?;
    let next_cursor =
        (page < 50 && page * PAGE_SIZE < result.total_count).then(|| (page + 1).to_string());
    Ok(Json(Page {
        items: result.items,
        next_cursor,
    }))
}

fn search_query(term: &str) -> ApiResult<String> {
    if term.len() > 120
        || term
            .chars()
            .any(|ch| !(ch.is_alphanumeric() || matches!(ch, ' ' | '-' | '_' | '.')))
    {
        return Err(ApiError::bad("Search using repository names or keywords"));
    }
    let words = term
        .split_whitespace()
        .map(|word| format!("\"{word}\""))
        .collect::<Vec<_>>()
        .join(" ");
    Ok(format!(
        "topic:anser-plugin is:public archived:false {words}"
    ))
}

fn unavailable() -> ApiError {
    ApiError::new(
        StatusCode::BAD_GATEWAY,
        "github_unavailable",
        "GitHub plugin search is unavailable",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confines_search_to_public_anser_plugins() {
        assert_eq!(
            search_query("health check").unwrap(),
            "topic:anser-plugin is:public archived:false \"health\" \"check\""
        );
        assert!(search_query("topic:other").is_err());
    }
}
