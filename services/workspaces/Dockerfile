FROM golang:1.27.1-bookworm AS build
WORKDIR /src
COPY services/api/go.mod services/api/go.sum ./
RUN go mod download
COPY services/api ./
RUN CGO_ENABLED=0 go build -trimpath -o /workspace-agent ./workspaceagent
FROM docker:29.7.2-cli@sha256:3f4743208d2338c934d7b8bcfbe1bb54c0b2355c510ad5e0f31c0c4a54bd704e
COPY --from=build /workspace-agent /usr/local/bin/cce-workspace-agent
ENTRYPOINT ["/usr/local/bin/cce-workspace-agent"]
