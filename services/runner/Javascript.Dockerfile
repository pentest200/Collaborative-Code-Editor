FROM golang:1.27.1-bookworm AS build
WORKDIR /src
COPY services/runner ./
RUN CGO_ENABLED=0 go build -trimpath -o /supervise ./supervisor
FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8
COPY --from=build /supervise /supervise
USER 65532:65532
ENTRYPOINT ["/supervise"]
