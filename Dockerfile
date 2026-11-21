FROM node:24-bookworm-slim AS web
WORKDIR /src/clients/web
COPY clients/web/package.json clients/web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY clients/web ./
RUN npm run build

FROM rust:1.94.0-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY anser-plugins ./anser-plugins
COPY --from=web /src/clients/web/dist ./clients/web/dist
ENV ANSER_REQUIRE_WEB=1
RUN cargo build --locked --release -p anser-server

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /data \
    && chown 10001:10001 /data
COPY --from=build /src/target/release/anser /usr/local/bin/anser
USER 10001:10001
WORKDIR /data
ENV ANSER_BIND=0.0.0.0:8080 ANSER_DATABASE=/data/anser.sqlite3
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/anser"]
CMD ["serve"]
