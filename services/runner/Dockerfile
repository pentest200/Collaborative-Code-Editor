FROM golang:1.27.1-bookworm AS build
WORKDIR /src
COPY services/runner ./
RUN CGO_ENABLED=0 go build -trimpath -o /runner .
FROM docker:29.7.2-cli@sha256:3f4743208d2338c934d7b8bcfbe1bb54c0b2355c510ad5e0f31c0c4a54bd704e
COPY --from=build /runner /usr/local/bin/cce-runner
ENTRYPOINT ["/usr/local/bin/cce-runner"]
