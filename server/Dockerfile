# Multi-stage: build the release binary, then a slim runtime. The dep-cache layer (build a
# dummy main first) keeps rebuilds fast when only src changes.
FROM rust:1-slim AS build
WORKDIR /app
# openssl-sys (pulled transitively by yup-oauth2/fcm_v1) needs native OpenSSL + pkg-config.
RUN apt-get update && apt-get install -y --no-install-recommends libssl-dev pkg-config && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock* ./
RUN mkdir src && echo 'fn main(){}' > src/main.rs && cargo build --release && rm -rf src
COPY src ./src
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim AS runtime
# openssl runtime lib + CA certs (the FCM send is HTTPS to fcm.googleapis.com).
RUN apt-get update && apt-get install -y --no-install-recommends libssl3 ca-certificates && rm -rf /var/lib/apt/lists/*
# uid 1000 == host user `hasan`, so trigger files dropped into the bind-mounted /triggers are
# owned by hasan and the host drain reads/deletes them cleanly. This is the whole bridge.
RUN useradd -u 1000 -m hasan
COPY --from=build /app/target/release/deck-backend /usr/local/bin/deck-backend
USER 1000
ENTRYPOINT ["/usr/local/bin/deck-backend"]
