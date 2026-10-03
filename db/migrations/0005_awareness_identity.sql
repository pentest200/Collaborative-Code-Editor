-- Authenticated awareness reads public display metadata, never credentials.
BEGIN;
GRANT SELECT(id,display_name) ON users TO cce_collab;
INSERT INTO schema_migrations(version) VALUES('0005_awareness_identity');
COMMIT;
