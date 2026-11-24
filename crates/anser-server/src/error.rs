use axum::extract::FromRequest;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Json, extract::Request};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: &'static str,
    pub details: Value,
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: &'static str) -> Self {
        Self {
            status,
            code,
            message,
            details: Value::Null,
        }
    }

    pub fn bad(message: &'static str) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_request", message)
    }

    pub fn auth() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "authentication_required",
            "Valid credentials are required",
        )
    }

    pub fn forbidden() -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", "Permission denied")
    }

    pub fn internal() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "The operation could not be completed",
        )
    }

    pub fn limited() -> Self {
        Self::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "Too many requests",
        )
    }

    pub fn channel(error: anser_host::HostError) -> Self {
        match error {
            anser_host::HostError::Send(error) => {
                let mut response = Self::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "channel_error",
                    "The channel rejected the request",
                );
                response.details = json!({"provider_code": error.code, "message": error.message, "retryable": error.retryable, "retry_after_ms": error.retry_after_ms});
                response
            }
            _ => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "channel_unavailable",
                "Channel is unavailable",
            ),
        }
    }
}

impl From<anser_store::DataError> for ApiError {
    fn from(error: anser_store::DataError) -> Self {
        use anser_store::DataError::*;
        match error {
            Missing => Self::new(StatusCode::NOT_FOUND, "not_found", "Resource not found"),
            Conflict => Self::new(
                StatusCode::CONFLICT,
                "conflict",
                "Resource conflicts with existing data",
            ),
            ProxyInUse => Self::new(
                StatusCode::CONFLICT,
                "proxy_in_use",
                "The proxy profile is assigned to an account",
            ),
            NoTargets => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "no_available_targets",
                "No available destinations for this message",
            ),
            QueueFull => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "queue_full",
                "Delivery queue is full",
            ),
            Forbidden => Self::forbidden(),
            TemplateMissing => Self::new(
                StatusCode::NOT_FOUND,
                "template_not_found",
                "Notification template not found",
            ),
            Template(error) => {
                use anser_core::template::Error;
                let code = match error {
                    Error::Definition => "invalid_template",
                    Error::Variables => "invalid_template_variables",
                    Error::Content => "invalid_rendered_notification",
                };
                Self::new(
                    StatusCode::BAD_REQUEST,
                    code,
                    match error {
                        Error::Definition => "Invalid template name, content length or placeholder",
                        Error::Variables => {
                            "Template variables must match the placeholders in the template"
                        }
                        Error::Content => {
                            "Rendered title and body must fit the message limits and cannot both be blank"
                        }
                    },
                )
            }

            InvalidInteractionReply => Self::bad("The reply does not match an available control"),
            InvalidFactor => Self::auth(),
            Sql(_) | Json(_) | Batch => {
                // Never print database bind values or provider error bodies.
                tracing::error!(%error, "storage request failed");
                Self::internal()
            }
        }
    }
}

impl From<anser_queue::CipherError> for ApiError {
    fn from(_: anser_queue::CipherError) -> Self {
        Self::internal()
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = (
            self.status,
            Json(json!({
                "code": self.code,
                "message": self.message,
                "details": self.details,
            })),
        )
            .into_response();
        if self.status == StatusCode::UNAUTHORIZED {
            response
                .headers_mut()
                .insert(header::WWW_AUTHENTICATE, "Bearer".parse().unwrap());
        } else if matches!(
            self.status,
            StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE
        ) {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, "1".parse().unwrap());
        }
        response
    }
}

pub struct ApiJson<T>(pub T);

impl<T: DeserializeOwned, S: Sync + Send> FromRequest<S> for ApiJson<T> {
    type Rejection = ApiError;

    async fn from_request(request: Request, state: &S) -> ApiResult<Self> {
        Json::<T>::from_request(request, state)
            .await
            .map(|Json(value)| Self(value))
            .map_err(|error| {
                ApiError::new(
                    error.status(),
                    "invalid_json",
                    "Request body does not match the expected JSON format",
                )
            })
    }
}

pub struct ApiQuery<T>(pub T);

impl<T: DeserializeOwned, S: Sync + Send> axum::extract::FromRequestParts<S> for ApiQuery<T> {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        state: &S,
    ) -> ApiResult<Self> {
        axum::extract::Query::<T>::from_request_parts(parts, state)
            .await
            .map(|axum::extract::Query(value)| Self(value))
            .map_err(|_| ApiError::bad("Invalid query parameters"))
    }
}

pub struct ApiPath<T>(pub T);

impl<T: DeserializeOwned + Send, S: Sync + Send> axum::extract::FromRequestParts<S> for ApiPath<T> {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        state: &S,
    ) -> ApiResult<Self> {
        axum::extract::Path::<T>::from_request_parts(parts, state)
            .await
            .map(|axum::extract::Path(value)| Self(value))
            .map_err(|_| ApiError::bad("Invalid resource identifier"))
    }
}
