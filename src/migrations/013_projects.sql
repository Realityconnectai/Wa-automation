-- 013_projects.sql: Real estate project catalogue
-- Rollback: DROP TABLE IF EXISTS projects CASCADE;

CREATE TABLE IF NOT EXISTS projects (
    id               SERIAL PRIMARY KEY,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    developer        TEXT DEFAULT '',
    city             TEXT DEFAULT '',
    locality         TEXT DEFAULT '',
    address          TEXT DEFAULT '',
    map_url          TEXT DEFAULT '',
    property_type    TEXT NOT NULL DEFAULT 'residential'
                     CHECK(property_type IN ('residential','commercial','plot','rental','resale')),
    rera_number      TEXT DEFAULT '',
    rera_status      TEXT NOT NULL DEFAULT 'unverified'
                     CHECK(rera_status IN ('unverified','verified')),
    possession_date  DATE,
    description      TEXT DEFAULT '',
    listing_url      TEXT DEFAULT '',
    is_active        INTEGER NOT NULL DEFAULT 1,
    created_at       TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_projects_user       ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_user_city  ON projects(user_id, city);
CREATE INDEX IF NOT EXISTS idx_projects_user_type  ON projects(user_id, property_type);
CREATE INDEX IF NOT EXISTS idx_projects_active     ON projects(user_id, is_active);
