DROP TABLE IF EXISTS entries;
--> statement-breakpoint
CREATE TABLE timings_cache (
  key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
