# Official images are no longer available from their former registries. Build
# the required MinIO component from its verified upstream release source.
FROM golang:1.27.1-bookworm AS build
RUN git clone --depth 1 --branch RELEASE.2025-09-07T16-13-09Z https://github.com/minio/minio.git /src
WORKDIR /src
RUN test "$(git rev-parse HEAD)" = "07c3a429bfed433e49018cb0f78a52145d4bedeb"
RUN CGO_ENABLED=0 go build -trimpath -o /minio .
FROM alpine:3.22
RUN addgroup -S storage && adduser -S -G storage storage && mkdir /data && chown storage:storage /data
COPY --from=build /minio /usr/local/bin/minio
USER storage
ENTRYPOINT ["minio"]
CMD ["server", "/data", "--console-address", ":9001"]
