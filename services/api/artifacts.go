package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/url"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

type artifactStore interface {
	Put(context.Context, string, []byte) error
	Get(context.Context, string, int64) ([]byte, error)
}

type s3Artifacts struct {
	client *minio.Client
	bucket string
}

func newArtifacts(cfg Config) (*s3Artifacts, error) {
	u, err := url.Parse(cfg.ArtifactEndpoint)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || cfg.ArtifactAccessKey == "" || cfg.ArtifactSecretKey == "" || cfg.ArtifactBucket == "" {
		return nil, errors.New("invalid private artifact configuration")
	}
	client, err := minio.New(u.Host, &minio.Options{Creds: credentials.NewStaticV4(cfg.ArtifactAccessKey, cfg.ArtifactSecretKey, ""), Secure: u.Scheme == "https", Region: "us-east-1"})
	if err != nil {
		return nil, err
	}
	return &s3Artifacts{client, cfg.ArtifactBucket}, nil
}

func (s *s3Artifacts) ensureBucket(ctx context.Context) error {
	exists, err := s.client.BucketExists(ctx, s.bucket)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	err = s.client.MakeBucket(ctx, s.bucket, minio.MakeBucketOptions{Region: "us-east-1"})
	if err != nil {
		exists, e := s.client.BucketExists(ctx, s.bucket)
		if e == nil && exists {
			return nil
		}
	}
	return err
}
func (s *s3Artifacts) Put(ctx context.Context, key string, data []byte) error {
	_, err := s.client.PutObject(ctx, s.bucket, key, bytes.NewReader(data), int64(len(data)), minio.PutObjectOptions{ContentType: "application/octet-stream", DisableMultipart: true})
	return err
}
func (s *s3Artifacts) Get(ctx context.Context, key string, limit int64) ([]byte, error) {
	object, err := s.client.GetObject(ctx, s.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	defer object.Close()
	data, err := io.ReadAll(io.LimitReader(object, limit+1))
	if err == nil && int64(len(data)) > limit {
		err = errors.New("artifact exceeds limit")
	}
	return data, err
}
