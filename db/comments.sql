-- Table + column descriptions for the referral.* schema (Lakebase Postgres).
-- These surface in the Lakebase UI ("Description" column) and in `\d+` / catalog
-- tools. Idempotent: COMMENT overwrites, so this can be re-run any time.
--
-- Run:  psql "$CONN" -f db/comments.sql
-- (CONN points at the referral-copilot Lakebase production branch.)

-- ============================ Facility directory ============================
COMMENT ON TABLE  referral.facility IS
  'Master facility record — one row per health facility (~10k). What every search returns.';
COMMENT ON COLUMN referral.facility.facility_id     IS 'Primary key (stable id carried from the bronze source).';
COMMENT ON COLUMN referral.facility.facility_type   IS 'Normalized category: hospital/clinic/dentist/doctor/pharmacy/nursing_home, or NULL if unknown.';
COMMENT ON COLUMN referral.facility.operator_type   IS 'Ownership: public / private / government.';
COMMENT ON COLUMN referral.facility.geo_confidence  IS 'How coordinates were resolved: exact_spatial | unresolved.';
COMMENT ON COLUMN referral.facility.lat             IS 'Latitude (only populated when inside the India bounding box).';
COMMENT ON COLUMN referral.facility.lng             IS 'Longitude (only populated when inside the India bounding box).';
COMMENT ON COLUMN referral.facility.recency_of_update IS 'Date the source listing was last updated (freshness signal).';

COMMENT ON TABLE referral.facility_capability IS
  'Clinical capabilities per facility (e.g. "dialysis unit", "cath lab"). Feeds embeddings + pg_trgm evidence.';
COMMENT ON TABLE referral.facility_procedure IS
  'Procedures offered per facility (e.g. "CABG", "cataract surgery"). Feeds embeddings + pg_trgm evidence.';
COMMENT ON TABLE referral.facility_specialty IS
  'Medical specialties per facility (cardiology, nephrology, ...). Feeds embeddings + pg_trgm evidence.';
COMMENT ON TABLE referral.facility_phone IS
  'All known phone numbers per facility; is_official flags the listed official line.';
COMMENT ON TABLE referral.facility_source_url IS
  'Provenance: the source URL(s) each facility fact was scraped from.';

-- ========================= Geo & coordinate validation =========================
COMMENT ON TABLE  referral.facility_vec IS
  'Semantic search index: a 1024-d pgvector embedding per facility (built by embed_facilities.py). Cosine-matched at query time.';
COMMENT ON COLUMN referral.facility_vec.embedding IS 'gte-large-en embedding, 1024 dimensions (vector type).';

COMMENT ON TABLE  referral.facility_geo IS
  'Runtime geo filter. Search joins on this; geo_valid=false facilities are excluded from results and origin geocoding.';
COMMENT ON COLUMN referral.facility_geo.geo_valid IS 'Final validity flag the app trusts (mirrors facility_validated.geo_valid).';
COMMENT ON COLUMN referral.facility_geo.dist_km   IS 'Distance (km) from the facility to its city median — the internal-consistency check.';

COMMENT ON TABLE  referral.facility_validated IS
  'Silver layer behind facility_geo — the full bronze->silver coordinate-validation audit (offline only, not read by the app).';
COMMENT ON COLUMN referral.facility_validated.geo_valid_internal IS 'Stage 1: inside India and within 80 km of the city median.';
COMMENT ON COLUMN referral.facility_validated.geo_valid_osm      IS 'Stage 2: stored point within 15 km of the OpenStreetMap/Nominatim geocode.';
COMMENT ON COLUMN referral.facility_validated.geo_valid          IS 'Final flag synced into facility_geo.';

-- ============================ Registry verification ============================
COMMENT ON TABLE  referral.facility_verification IS
  'Registry matches that drive the green Verified badge. Populated by verify_facilities.py.';
COMMENT ON COLUMN referral.facility_verification.source            IS 'Registry the match came from: PMJAY / NABH / HFR.';
COMMENT ON COLUMN referral.facility_verification.verified_services IS 'Services the registry attributes to this facility (text[]).';
COMMENT ON COLUMN referral.facility_verification.match_score       IS 'Name-similarity score of the entity-resolution match (0-1).';

COMMENT ON TABLE referral.registry_stage IS
  'Transient staging for the verification ETL: raw registry rows (Haryana PMJAY CSV + seed) before entity-resolution. Rebuilt each run.';

-- ============================ Geocoding reference ============================
COMMENT ON TABLE referral.pin_geo IS
  'PIN -> district/state + centroid lookup. Largely DEPRECATED — the app no longer trusts these centroids for geocoding (many were wrong); kept for reference/fallback.';

-- ============================ Conversational agent ============================
COMMENT ON TABLE  referral.conversation IS
  'One row per chat session (ephemeral working set). Archived to Unity Catalog and purged on close / 30-min idle.';
COMMENT ON COLUMN referral.conversation.user_id IS 'Pseudonymized (salted-hash) user id — raw email is never stored.';
COMMENT ON COLUMN referral.conversation.status  IS 'active | closed.';

COMMENT ON TABLE  referral.conversation_turn IS
  'Individual chat messages within a conversation.';
COMMENT ON COLUMN referral.conversation_turn.role         IS 'user | assistant.';
COMMENT ON COLUMN referral.conversation_turn.results_json IS 'jsonb snapshot of the facilities returned for this turn.';

COMMENT ON TABLE referral.search_session IS
  'Single-shot (non-chat) search log — used for analytics and the retention sweep.';

-- ============================ Shortlists (UI removed) ============================
COMMENT ON TABLE referral.shortlist IS
  'Saved facility lists. Backs the former "My referrals" feature (removed from the UI; tables retained, dormant).';
COMMENT ON TABLE referral.shortlist_item IS
  'Facilities saved to a shortlist, with rank/distance/score/note. Dormant (UI removed).';

-- ============================ Observability ============================
COMMENT ON TABLE  referral.usage_event IS
  'Cost dashboard source of truth: one row per Model Serving call logging real token usage.';
COMMENT ON COLUMN referral.usage_event.kind     IS 'embed | llm.';
COMMENT ON COLUMN referral.usage_event.tokens   IS 'Tokens consumed by the call (for the measured cost figure).';
COMMENT ON COLUMN referral.usage_event.endpoint IS 'Serving endpoint name the call hit.';
