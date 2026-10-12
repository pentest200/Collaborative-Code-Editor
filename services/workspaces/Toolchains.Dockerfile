FROM node:24-bookworm-slim AS node
FROM golang:1.27.1-bookworm AS go
FROM python:3.14.3-slim-bookworm@sha256:f21c0d5a44c56805654c15abccc1b2fd576c8d93aca0a3f74b4aba2dc92510e2
RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates git g++ cmake make openjdk-17-jdk-headless maven util-linux procps && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx && npm install -g typescript@5.9.3 --no-audit --no-fund
COPY --from=go /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin"
RUN /usr/sbin/useradd --uid 1000 --create-home developer
CMD ["sleep", "infinity"]
