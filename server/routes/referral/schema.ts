// Referral Copilot — Lakebase schema (core tables only).
// Inlined (not read from disk) so it ships reliably in the deployed bundle.
// Idempotent: CREATE ... IF NOT EXISTS. Runs in onPluginsReady so the app
// Service Principal owns the `referral` schema (deploy-first ownership).
//
// Retrieval is SEMANTIC, not lexical: query text is embedded with
// databricks-gte-large-en and matched against referral.facility_vec via the
// referral.search_facilities_vec(...) pgvector function (built by etl/embed_facilities.py).
// The old lexical matview/trigram path is dropped here — both because the vector
// index supersedes it and to stay under the 512 MB free-trial Lakebase cap.

interface AppKitLakebase {
  lakebase: { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
}

// Drop the now-superseded lexical objects FIRST. The SP owns them (created by an
// earlier deploy), so it can DROP them; DROP frees pages without extending files,
// so it succeeds even when the database is over quota. Order matters: drop the
// function before its matview.
const CLEANUP_SQL = `
DROP FUNCTION IF EXISTS referral.search_facilities(text,double precision,double precision,numeric,text,text,int);
DROP MATERIALIZED VIEW IF EXISTS referral.facility_search CASCADE;
DROP INDEX IF EXISTS referral.ix_proc_trgm;
DROP INDEX IF EXISTS referral.ix_cap_trgm;
DROP TABLE IF EXISTS referral.facility_website CASCADE;
`;

const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS referral;

CREATE TABLE IF NOT EXISTS referral.facility (
  facility_id text PRIMARY KEY,
  name text NOT NULL,
  facility_type text,
  operator_type text,
  affiliation_types text[],
  year_established int,
  beds int,
  num_doctors int,
  city text, state text, pincode text,
  address_line1 text, address_line2 text, address_line3 text,
  lat double precision, lng double precision,
  geo_confidence text,
  official_phone text, official_website text, email text,
  description text,
  recency_of_update date,
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS referral.facility_specialty (
  facility_id text REFERENCES referral.facility(facility_id) ON DELETE CASCADE,
  specialty text NOT NULL, PRIMARY KEY (facility_id, specialty));
CREATE TABLE IF NOT EXISTS referral.facility_procedure (
  facility_id text REFERENCES referral.facility(facility_id) ON DELETE CASCADE,
  procedure text NOT NULL, PRIMARY KEY (facility_id, procedure));
CREATE TABLE IF NOT EXISTS referral.facility_capability (
  facility_id text REFERENCES referral.facility(facility_id) ON DELETE CASCADE,
  capability text NOT NULL, PRIMARY KEY (facility_id, capability));
CREATE TABLE IF NOT EXISTS referral.facility_phone (
  facility_id text REFERENCES referral.facility(facility_id) ON DELETE CASCADE,
  phone text NOT NULL, is_official boolean DEFAULT false, PRIMARY KEY (facility_id, phone));
CREATE TABLE IF NOT EXISTS referral.facility_source_url (
  facility_id text REFERENCES referral.facility(facility_id) ON DELETE CASCADE,
  source_url text NOT NULL, PRIMARY KEY (facility_id, source_url));
CREATE TABLE IF NOT EXISTS referral.pin_geo (
  pincode text PRIMARY KEY, primary_district text, primary_state text,
  is_ambiguous boolean, candidate_districts text[],
  centroid_lat double precision, centroid_lng double precision);

CREATE TABLE IF NOT EXISTS referral.search_session (
  session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text, raw_query text, parsed_care_need text, parsed_location text,
  parsed_lat double precision, parsed_lng double precision,
  radius_km numeric, result_count int, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS referral.shortlist (
  shortlist_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES referral.search_session(session_id) ON DELETE SET NULL,
  user_id text, title text, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS referral.shortlist_item (
  shortlist_id uuid REFERENCES referral.shortlist(shortlist_id) ON DELETE CASCADE,
  facility_id text REFERENCES referral.facility(facility_id),
  rank int, distance_km numeric, score numeric, match_reason text, note text,
  status text DEFAULT 'candidate', added_at timestamptz DEFAULT now(),
  PRIMARY KEY (shortlist_id, facility_id));

CREATE INDEX IF NOT EXISTS ix_facility_lat ON referral.facility (lat);
CREATE INDEX IF NOT EXISTS ix_facility_lng ON referral.facility (lng);
CREATE INDEX IF NOT EXISTS ix_facility_type ON referral.facility (facility_type);
CREATE INDEX IF NOT EXISTS ix_facility_oper ON referral.facility (operator_type);
CREATE INDEX IF NOT EXISTS ix_facility_city ON referral.facility (lower(city));
CREATE INDEX IF NOT EXISTS ix_spec_specialty ON referral.facility_specialty (specialty);
CREATE INDEX IF NOT EXISTS ix_shortlist_user ON referral.shortlist (user_id);
CREATE INDEX IF NOT EXISTS ix_session_user ON referral.search_session (user_id);
`;

export async function setupReferralSchema(appkit: AppKitLakebase): Promise<void> {
  try {
    // Free space first (idempotent drops), then ensure core tables exist.
    await appkit.lakebase.query(CLEANUP_SQL);
    await appkit.lakebase.query(SCHEMA_SQL);
    console.log('[referral] schema ready (semantic retrieval via facility_vec)');
  } catch (err) {
    console.warn('[referral] schema setup failed:', (err as Error).message);
    console.warn('[referral] deploy the app first so the SP owns the schema (deploy-first)');
  }
}
