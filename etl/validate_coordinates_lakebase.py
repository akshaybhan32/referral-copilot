#!/usr/bin/env python3
"""Coordinate-validation pipeline — Lakebase-native (no SQL warehouse needed).

Same goal as validate_coordinates.py, but reads facilities from and writes the
validated "silver" layer straight into Lakebase, so it works even when serverless
SQL is disabled at the workspace level. The Lakebase `referral` schema is itself
registered in Unity Catalog, so this silver table is queryable from the lakehouse.

Stages:
  1. INTERNAL CONSISTENCY (free, instant): inside India and within 80 km of the
     robust (median) centre of its own city.
  2. OPENSTREETMAP / NOMINATIM (free, optional): geocode each facility's address;
     the stored point must be within 15 km of the result.

Outputs (both in Lakebase):
  - referral.facility_validated   the silver table (full validation detail)
  - referral.facility_geo         the geo_valid flag the app's search filters on

Run:
  python3 etl/validate_coordinates_lakebase.py                 # stage 1 only (instant)
  GEOCODER=nominatim python3 etl/validate_coordinates_lakebase.py   # + stage 2 (OSM, ~3h for 10k)
  GEO_MAX=300 GEOCODER=nominatim python3 ...                        # trial slice

Needs: databricks CLI (profile auth) + psql. No warehouse, no API key.
"""
import json, math, os, subprocess, time, urllib.parse, urllib.request

PROFILE = "Hack-FreeTrial"
EP = "projects/referral-copilot/branches/production/endpoints/primary"
PGUSER = "akshaybhan28@gmail.com"
PGDB = "databricks_postgres"
SP = "783b9f28-86d5-43f1-8540-fe5d3dcfd489"
CITY_KM = 80
GEOCODER_KM = 15
GEOCODER = os.environ.get("GEOCODER", "none").lower()
GEO_MAX = int(os.environ.get("GEO_MAX", "0"))

HOST = json.loads(subprocess.run(["databricks", "postgres", "get-endpoint", EP, "--profile", PROFILE, "-o", "json"],
                                 capture_output=True, text=True).stdout)["status"]["hosts"]["host"]
TOKEN = json.loads(subprocess.run(["databricks", "postgres", "generate-database-credential", EP, "--profile", PROFILE, "-o", "json"],
                                  capture_output=True, text=True).stdout)["token"]
CONN = f"host={HOST} user={PGUSER} dbname={PGDB} sslmode=require"

def psql(sql, tuples=False):
    args = ["psql", CONN, "-v", "ON_ERROR_STOP=1", "-c", sql]
    if tuples:
        args[1:1] = ["-tA", "-F", "\t"]
    r = subprocess.run(args, capture_output=True, text=True, env={**os.environ, "PGPASSWORD": TOKEN})
    if r.returncode != 0:
        raise RuntimeError(r.stderr[:800])
    return r.stdout.strip()

# Stage 1: (re)build the silver table from referral.facility — pure SQL, instant.
SILVER_SQL = f"""
CREATE TABLE IF NOT EXISTS referral.facility_validated (
  facility_id text PRIMARY KEY, name text, city text, state text,
  lat double precision, lng double precision,
  dist_from_city_km numeric, geo_valid_internal boolean,
  osm_lat double precision, osm_lng double precision,
  osm_dist_km numeric, geo_valid_osm boolean,
  geo_valid boolean, validated_at timestamptz DEFAULT now());
TRUNCATE referral.facility_validated;
WITH cc AS (
  SELECT lower(city) c, lower(coalesce(state,'')) s,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY lat) mlat,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY lng) mlng, count(*) n
  FROM referral.facility WHERE lat IS NOT NULL GROUP BY 1,2)
INSERT INTO referral.facility_validated
  (facility_id,name,city,state,lat,lng,dist_from_city_km,geo_valid_internal,geo_valid)
SELECT f.facility_id, f.name, f.city, f.state, f.lat, f.lng,
  round(dist.d::numeric,1),
  v.ok, v.ok
FROM referral.facility f
LEFT JOIN cc ON lower(f.city)=cc.c AND lower(coalesce(f.state,''))=cc.s
CROSS JOIN LATERAL (SELECT CASE WHEN cc.mlat IS NULL OR f.lat IS NULL THEN NULL ELSE
  6371*acos(least(1,greatest(-1, sin(radians(cc.mlat))*sin(radians(f.lat))
    +cos(radians(cc.mlat))*cos(radians(f.lat))*cos(radians(f.lng-cc.mlng))))) END d) dist
CROSS JOIN LATERAL (SELECT (f.lat BETWEEN 6 AND 37.6 AND f.lng BETWEEN 68 AND 97.6
  AND (cc.n < 5 OR dist.d IS NULL OR dist.d <= {CITY_KM})) ok) v
WHERE f.lat IS NOT NULL;
"""

SYNC_GEO_SQL = """
CREATE TABLE IF NOT EXISTS referral.facility_geo (facility_id text PRIMARY KEY, geo_valid boolean, dist_km numeric);
TRUNCATE referral.facility_geo;
INSERT INTO referral.facility_geo (facility_id, geo_valid, dist_km)
SELECT facility_id, geo_valid, coalesce(osm_dist_km, dist_from_city_km) FROM referral.facility_validated;
"""

def nominatim_geocode(address):
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
        {"q": address, "format": "json", "countrycodes": "in", "limit": 1})
    req = urllib.request.Request(url, headers={"User-Agent": "referral-copilot/1.0 (hackathon; coord-validation)"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        d = json.loads(resp.read())
    return (float(d[0]["lat"]), float(d[0]["lon"])) if d else None

def hav(a, b, c, d):
    r = math.pi / 180
    h = math.sin((c - a) * r / 2) ** 2 + math.cos(a * r) * math.cos(c * r) * math.sin((d - b) * r / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))

def esc(s):
    return s.replace("'", "''")

if __name__ == "__main__":
    print(f"1/3 building referral.facility_validated (stage 1: within {CITY_KM}km of city median)...")
    psql(SILVER_SQL)
    n = int(psql("select count(*) from referral.facility_validated;", tuples=True))
    bad = int(psql("select count(*) from referral.facility_validated where not geo_valid_internal;", tuples=True))
    print(f"    {n} facilities, {bad} flagged by internal consistency")

    if GEOCODER == "nominatim":
        rows = psql("select facility_id, concat_ws(', ', name, city, state, 'India') "
                    "from referral.facility_validated where lat is not null;", tuples=True).split("\n")
        rows = [r.split("\t", 1) for r in rows if r]
        if GEO_MAX:
            rows = rows[:GEO_MAX]
        print(f"2/3 stage 2: OpenStreetMap geocoding {len(rows)} facilities (~{len(rows)*1.1/3600:.1f}h, persists as it goes)...")
        done = 0
        for fid, addr in rows:
            cur = psql(f"select lat, lng from referral.facility_validated where facility_id='{esc(fid)}';", tuples=True)
            if not cur:
                continue
            slat, slng = (float(x) for x in cur.split("\t"))
            try:
                g = nominatim_geocode(addr)
            except Exception:
                g = None
            if g:
                dist = hav(slat, slng, g[0], g[1])
                ok = dist <= GEOCODER_KM
                psql(f"""update referral.facility_validated set osm_lat={g[0]}, osm_lng={g[1]},
                  osm_dist_km={round(dist,1)}, geo_valid_osm={'true' if ok else 'false'},
                  geo_valid = geo_valid_internal and {'true' if ok else 'false'}
                  where facility_id='{esc(fid)}';""")
            done += 1
            if done % 200 == 0:
                print(f"    geocoded {done}/{len(rows)} (persisted)")
            time.sleep(1.1)  # Nominatim usage policy
        print("    OpenStreetMap validation complete")
    else:
        print("2/3 stage 2 skipped (set GEOCODER=nominatim to enable OpenStreetMap validation)")

    print("3/3 syncing referral.facility_geo (the app's search filter)...")
    psql(SYNC_GEO_SQL)
    psql(f'GRANT SELECT ON referral.facility_validated, referral.facility_geo TO "{SP}";')
    print("\ndone. valid:", psql("select count(*) filter (where geo_valid) from referral.facility_geo;", tuples=True),
          "/ total:", psql("select count(*) from referral.facility_geo;", tuples=True))
