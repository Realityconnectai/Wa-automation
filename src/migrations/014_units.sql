-- 014_units.sql: Unit-level inventory with status state machine
-- Rollback: DROP TABLE IF EXISTS unit_status_history CASCADE;
--           DROP TABLE IF EXISTS units CASCADE;

CREATE TABLE IF NOT EXISTS units (
    id               SERIAL PRIMARY KEY,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tower            TEXT NOT NULL DEFAULT '',
    unit_number      TEXT NOT NULL,
    bhk              TEXT NOT NULL DEFAULT '',    -- '1BHK','2BHK','3BHK','Plot','Studio',etc.
    area             NUMERIC NOT NULL DEFAULT 0,
    area_unit        TEXT NOT NULL DEFAULT 'sqft' CHECK(area_unit IN ('sqft','sqm','sqyd')),
    price            NUMERIC NOT NULL DEFAULT 0,
    floor            INTEGER,
    status           TEXT NOT NULL DEFAULT 'VACANT'
                     CHECK(status IN ('VACANT','ON_HOLD','BOOKED','SOLD')),
    hold_expires_at  TIMESTAMPTZ,                -- NULL when not on hold
    hold_by          TEXT DEFAULT '',            -- contact phone or name who placed hold
    booking_ref      TEXT DEFAULT '',            -- reference number for booked/sold units
    is_active        INTEGER NOT NULL DEFAULT 1,
    created_at       TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_units_tower_number UNIQUE(user_id, project_id, tower, unit_number)
);

CREATE INDEX IF NOT EXISTS idx_units_user         ON units(user_id);
CREATE INDEX IF NOT EXISTS idx_units_project      ON units(project_id);
CREATE INDEX IF NOT EXISTS idx_units_user_status  ON units(user_id, status);
CREATE INDEX IF NOT EXISTS idx_units_user_bhk     ON units(user_id, bhk);
CREATE INDEX IF NOT EXISTS idx_units_hold_expiry  ON units(status, hold_expires_at)
    WHERE status = 'ON_HOLD' AND hold_expires_at IS NOT NULL;

-- Unit status audit trail
CREATE TABLE IF NOT EXISTS unit_status_history (
    id           SERIAL PRIMARY KEY,
    unit_id      INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    old_status   TEXT NOT NULL,
    new_status   TEXT NOT NULL,
    changed_by   TEXT DEFAULT '',   -- phone or user identifier who triggered the change
    reason       TEXT DEFAULT '',
    changed_at   TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_unit_history_unit ON unit_status_history(unit_id);
CREATE INDEX IF NOT EXISTS idx_unit_history_user ON unit_status_history(user_id, changed_at);
