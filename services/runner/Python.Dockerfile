FROM golang:1.27.1-bookworm AS build
WORKDIR /src
COPY services/runner ./
RUN CGO_ENABLED=0 go build -trimpath -o /supervise ./supervisor
FROM python:3.14.3-slim-bookworm@sha256:f21c0d5a44c56805654c15abccc1b2fd576c8d93aca0a3f74b4aba2dc92510e2
COPY --from=build /supervise /supervise
USER 65532:65532
ENTRYPOINT ["/supervise"]
