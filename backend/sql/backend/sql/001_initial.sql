-- ============================================================
-- QH VisionX Response
-- Initial PostgreSQL + PostGIS Database Schema
-- ============================================================

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- USERS
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    username VARCHAR(80) NOT NULL UNIQUE,

    password_hash TEXT NOT NULL,

    full_name VARCHAR(160) NOT NULL,

    role VARCHAR(30) NOT NULL DEFAULT 'responder',

    active BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT users_role_check
        CHECK (
            role IN (
                'admin',
                'manager',
                'dispatcher',
                'responder',
                'viewer'
            )
        )
);

CREATE INDEX IF NOT EXISTS idx_users_role
ON users(role);

CREATE INDEX IF NOT EXISTS idx_users_active
ON users(active);


-- ============================================================
-- TEAMS
-- ============================================================

CREATE TABLE IF NOT EXISTS teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    name VARCHAR(120) NOT NULL UNIQUE,

    status VARCHAR(30) NOT NULL DEFAULT 'available',

    description TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT teams_status_check
        CHECK (
            status IN (
                'available',
                'busy',
                'offline',
                'standby'
            )
        )
);

CREATE INDEX IF NOT EXISTS idx_teams_status
ON teams(status);


-- ============================================================
-- INCIDENTS
-- ============================================================

CREATE TABLE IF NOT EXISTS incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    title VARCHAR(200) NOT NULL,

    description TEXT,

    severity VARCHAR(20) NOT NULL DEFAULT 'medium',

    status VARCHAR(30) NOT NULL DEFAULT 'open',

    latitude DOUBLE PRECISION,

    longitude DOUBLE PRECISION,

    location GEOGRAPHY(POINT, 4326),

    created_by UUID REFERENCES users(id) ON DELETE SET NULL,

    assigned_team UUID REFERENCES teams(id) ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT incidents_severity_check
        CHECK (
            severity IN (
                'low',
                'medium',
                'high',
                'critical'
            )
        ),

    CONSTRAINT incidents_status_check
        CHECK (
            status IN (
                'open',
                'acknowledged',
                'in_progress',
                'resolved',
                'closed'
            )
        )
);

CREATE INDEX IF NOT EXISTS idx_incidents_status
ON incidents(status);

CREATE INDEX IF NOT EXISTS idx_incidents_severity
ON incidents(severity);

CREATE INDEX IF NOT EXISTS idx_incidents_created_at
ON incidents(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_incidents_location
ON incidents
USING GIST(location);


-- ============================================================
-- LOCATIONS / LIVE GPS
-- ============================================================

CREATE TABLE IF NOT EXISTS locations (
    id BIGSERIAL PRIMARY KEY,

    user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    latitude DOUBLE PRECISION NOT NULL,

    longitude DOUBLE PRECISION NOT NULL,

    accuracy DOUBLE PRECISION,

    altitude DOUBLE PRECISION,

    speed DOUBLE PRECISION,

    heading DOUBLE PRECISION,

    location GEOGRAPHY(POINT, 4326),

    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT locations_latitude_check
        CHECK (
            latitude >= -90
            AND latitude <= 90
        ),

    CONSTRAINT locations_longitude_check
        CHECK (
            longitude >= -180
            AND longitude <= 180
        )
);

CREATE INDEX IF NOT EXISTS idx_locations_user
ON locations(user_id);

CREATE INDEX IF NOT EXISTS idx_locations_recorded_at
ON locations(recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_locations_location
ON locations
USING GIST(location);


-- ============================================================
-- REPORTS
-- ============================================================

CREATE TABLE IF NOT EXISTS reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    incident_id UUID
        REFERENCES incidents(id)
        ON DELETE SET NULL,

    created_by UUID
        REFERENCES users(id)
        ON DELETE SET NULL,

    title VARCHAR(200) NOT NULL,

    content TEXT NOT NULL,

    report_type VARCHAR(50) DEFAULT 'general',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reports_incident
ON reports(incident_id);

CREATE INDEX IF NOT EXISTS idx_reports_created_by
ON reports(created_by);

CREATE INDEX IF NOT EXISTS idx_reports_created_at
ON reports(created_at DESC);


-- ============================================================
-- AUDIT LOGS
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGSERIAL PRIMARY KEY,

    user_id UUID
        REFERENCES users(id)
        ON DELETE SET NULL,

    action VARCHAR(120) NOT NULL,

    details JSONB,

    ip_address INET,

    user_agent TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user
ON audit_logs(user_id);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action
ON audit_logs(action);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
ON audit_logs(created_at DESC);


-- ============================================================
-- TRIGGER FUNCTION: updated_at
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


-- ============================================================
-- UPDATED_AT TRIGGERS
-- ============================================================

DROP TRIGGER IF EXISTS users_updated_at
ON users;

CREATE TRIGGER users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


DROP TRIGGER IF EXISTS teams_updated_at
ON teams;

CREATE TRIGGER teams_updated_at
BEFORE UPDATE ON teams
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


DROP TRIGGER IF EXISTS incidents_updated_at
ON incidents;

CREATE TRIGGER incidents_updated_at
BEFORE UPDATE ON incidents
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


DROP TRIGGER IF EXISTS reports_updated_at
ON reports;

CREATE TRIGGER reports_updated_at
BEFORE UPDATE ON reports
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- FUNCTION: SET INCIDENT LOCATION
-- ============================================================

CREATE OR REPLACE FUNCTION update_incident_location()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.latitude IS NOT NULL
       AND NEW.longitude IS NOT NULL THEN

        NEW.location =
            ST_SetSRID(
                ST_MakePoint(
                    NEW.longitude,
                    NEW.latitude
                ),
                4326
            )::geography;

    ELSE
        NEW.location = NULL;
    END IF;

    RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS incidents_location_trigger
ON incidents;

CREATE TRIGGER incidents_location_trigger
BEFORE INSERT OR UPDATE OF latitude, longitude
ON incidents
FOR EACH ROW
EXECUTE FUNCTION update_incident_location();


-- ============================================================
-- FUNCTION: SET GPS LOCATION
-- ============================================================

CREATE OR REPLACE FUNCTION update_gps_location()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.location =
        ST_SetSRID(
            ST_MakePoint(
                NEW.longitude,
                NEW.latitude
            ),
            4326
        )::geography;

    RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS locations_location_trigger
ON locations;

CREATE TRIGGER locations_location_trigger
BEFORE INSERT OR UPDATE OF latitude, longitude
ON locations
FOR EACH ROW
EXECUTE FUNCTION update_gps_location();


-- ============================================================
-- INITIAL TEAM
-- ============================================================

INSERT INTO teams (
    name,
    status,
    description
)
VALUES (
    'QH VisionX Response Team',
    'standby',
    'Default response coordination team'
)
ON CONFLICT (name) DO NOTHING;


-- ============================================================
-- DATABASE READY
-- ============================================================

SELECT
    'QH VisionX Response database initialized successfully'
    AS status;
