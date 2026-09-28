CREATE TABLE IF NOT EXISTS snapshots (
  scheduled_at TEXT PRIMARY KEY,
  observed_at TEXT NOT NULL,
  people_screened INTEGER NOT NULL CHECK(people_screened > 0),
  bags_screened INTEGER NOT NULL CHECK(bags_screened > 0),
  people_anchor INTEGER NOT NULL CHECK(people_anchor > 0),
  bags_anchor INTEGER NOT NULL CHECK(bags_anchor > 0),
  people_anchor_at TEXT NOT NULL,
  bags_anchor_at TEXT NOT NULL,
  source_url TEXT NOT NULL
) STRICT;
