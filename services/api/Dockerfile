FROM golang:1.27.1-bookworm AS build
WORKDIR /src
COPY services/api ./
RUN CGO_ENABLED=0 go build -trimpath -o /api .

FROM alpine:3.22
RUN addgroup -S app && adduser -S -G app app
COPY --from=build /api /usr/local/bin/api
USER app
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/api"]
