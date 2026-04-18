-- RSI Companion backend schema — v3 initial tables.

CREATE TABLE IF NOT EXISTS roadmap_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id INTEGER NOT NULL,
    snapshot_ts INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL,
    payload TEXT NOT NULL,
    UNIQUE (board_id, snapshot_ts)
);

CREATE INDEX IF NOT EXISTS idx_roadmap_board_ts
    ON roadmap_snapshots (board_id, snapshot_ts DESC);

CREATE TABLE IF NOT EXISTS ship_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    display_name TEXT NOT NULL,
    ship_id TEXT NOT NULL,
    UNIQUE (display_name)
);

CREATE TABLE IF NOT EXISTS loaners (
    ship_id TEXT NOT NULL,
    loaner_id TEXT NOT NULL,
    PRIMARY KEY (ship_id, loaner_id)
);

CREATE TABLE IF NOT EXISTS ships_not_found (
    display_name TEXT PRIMARY KEY,
    hit_count INTEGER NOT NULL DEFAULT 0,
    last_reported_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS release_notes (
    version TEXT PRIMARY KEY,
    released_at TEXT NOT NULL,
    notes TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    bucket_key TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    hit_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (bucket_key, window_start)
);
