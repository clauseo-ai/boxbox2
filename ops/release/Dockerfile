# syntax=docker/dockerfile:1.7
#
# the release build (docs/deploy.md, releases): one static linux binary for
# the platform the build runs on, packaged with its unit and the example
# config. musl links everything in, so the binary runs on any distribution
# whatever its glibc (a binary built against a newer glibc dies on an older
# one: v1 lost its model proxy for minutes that way). each architecture is
# built natively, never cross-compiled: `docker buildx build --platform
# linux/arm64` or `linux/amd64`, driven by ops/release/build.sh.
#
# the context is an allowlist (Dockerfile.dockerignore beside this file):
# the server, the vendored contract, the telemetry dictionary and the
# built app, nothing else.

FROM rust:1.92.0-alpine3.22 AS build
# musl-dev for the static libc; clang, cmake and perl build the c inside
# aws-lc (rustls' crypto) and sqlite (rusqlite, bundled)
RUN apk add --no-cache musl-dev clang cmake make perl
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml clippy.toml rustfmt.toml ./
COPY server server
COPY vendor/cmx2 vendor/cmx2
COPY vendor/openclaw vendor/openclaw
COPY openclaw.pin openclaw.pin
COPY telemetry/schema.json telemetry/schema.json
COPY app/dist app/dist
# `boxbox service install` on linux installs the unit the tarball carries,
# read into the binary at build time
COPY ops/boxbox.service ops/boxbox.service
ARG TARGETARCH
# the repo `boxbox upgrade` fetches releases from, stamped into the binary
ARG BOXBOX_REPO=""
ENV BOXBOX_REPO=${BOXBOX_REPO}
RUN --mount=type=cache,id=boxbox-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=boxbox-target-${TARGETARCH},target=/src/target \
    cargo build --release --locked -p boxbox \
 && mkdir -p /out \
 && cp target/release/boxbox /out/boxbox \
 && /out/boxbox --version

FROM alpine:3.22 AS package
RUN apk add --no-cache tar gzip file
ARG TARGETARCH
ARG VERSION
# the commit's time, so the same source packs the same bytes
ARG SOURCE_DATE_EPOCH=0
COPY --from=build /out/boxbox /stage/boxbox
COPY ops/boxbox.service boxbox.example.toml LICENSE /stage/
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) arch=x86_64 ;; \
      arm64) arch=aarch64 ;; \
      *) echo "no release for $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    # "statically linked" on aarch64, "static-pie linked" on x86_64
    file /stage/boxbox | grep -Eq 'statically linked|static-pie linked' \
      || { echo "the binary is not static:" >&2; file /stage/boxbox >&2; exit 1; }; \
    name="boxbox-${VERSION}-${arch}-linux"; \
    mkdir -p /dist "/pack/$name"; \
    cp -p /stage/* "/pack/$name/"; \
    chmod 0755 "/pack/$name/boxbox"; \
    chmod 0644 "/pack/$name/boxbox.service" "/pack/$name/boxbox.example.toml" "/pack/$name/LICENSE"; \
    tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@${SOURCE_DATE_EPOCH}" \
        -C /pack -cf - "$name" | gzip -n -9 > "/dist/$name.tar.gz"

FROM scratch
COPY --from=package /dist/ /
