-- Preserve existing automatic observations while allowing explicitly labeled
-- interactive-browser baselines whose underlying source feed was not captured.
CREATE TABLE snapshots_with_method (
  scheduled_at TEXT PRIMARY KEY,
  observed_at TEXT NOT NULL,
  people_screened INTEGER NOT NULL CHECK(people_screened > 0),
  bags_screened INTEGER NOT NULL CHECK(bags_screened > 0),
  people_anchor INTEGER CHECK(people_anchor > 0),
  bags_anchor INTEGER CHECK(bags_anchor > 0),
  people_anchor_at TEXT,
  bags_anchor_at TEXT,
  source_url TEXT NOT NULL,
  collection_method TEXT NOT NULL DEFAULT 'cloudflare_browser'
    CHECK(collection_method IN ('cloudflare_browser', 'interactive_browser')),
  CHECK((people_anchor IS NULL) = (people_anchor_at IS NULL)),
  CHECK((bags_anchor IS NULL) = (bags_anchor_at IS NULL)),
  CHECK(collection_method = 'interactive_browser' OR
    (people_anchor IS NOT NULL AND bags_anchor IS NOT NULL
     AND people_anchor_at IS NOT NULL AND bags_anchor_at IS NOT NULL))
) STRICT;

INSERT INTO snapshots_with_method
  (scheduled_at, observed_at, people_screened, bags_screened, people_anchor,
   bags_anchor, people_anchor_at, bags_anchor_at, source_url, collection_method)
SELECT scheduled_at, observed_at, people_screened, bags_screened, people_anchor,
       bags_anchor, people_anchor_at, bags_anchor_at, source_url, 'cloudflare_browser'
FROM snapshots;

DROP TABLE snapshots;
ALTER TABLE snapshots_with_method RENAME TO snapshots;
