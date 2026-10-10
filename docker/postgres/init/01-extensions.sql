-- Executed by the postgres image only when the data volume is first created.
-- For an existing database, run this once manually (requires owner/superuser).
CREATE EXTENSION IF NOT EXISTS vector;
