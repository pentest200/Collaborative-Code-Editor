-- Explicitly local development credentials, outside the canonical migrations.
CREATE USER cce_worker PASSWORD 'cce_worker_dev_only';
GRANT cce_collab TO cce_worker;
