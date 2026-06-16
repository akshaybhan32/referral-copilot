#!/usr/bin/env python3
"""Coordinate-validation pipeline: bronze -> silver.

Many facility coordinates in the bronze source are wrong (≈7-8% land >100 km
from their own city — e.g. a "Noida" hospital plotted in Agartala). This pipeline
validates every facility's coordinates and writes a trustworthy silver table; the
app only shows facilities whose coordinates pass.

Two validation stages:
  1. INTERNAL CONSISTENCY (always, free): coordinate must be inside India and
     within 80 km of the robust (median) centre of its own city. Catches the
     gross errors instantly, no external calls.
  2. EXTERNAL GEOCODER (optional, authoritative): geocode each facility's address
     and require the stored point to be within 15 km of the geocoder's result.
     Default geocoder is OpenStreetMap / Nominatim (free, no key).

Outputs:
  - dais_hackathon.silver.facility_geo_validated  (the silver table)
  - referral.facility_geo in Lakebase              (geo_valid flag the app reads)

Run:
  python3 etl/validate_coordinates.py                 # stage 1 only
  GEOCODER=nominatim python3 etl/validate_coordinates.py   # + stage 2 (OSM, free)
  GEOCODER=google GOOGLE_MAPS_API_KEY=... python3 ...      # + stage 2 (Google)
  GEO_MAX=500 GEOCODER=nominatim python3 ...               # cap calls (testing)

Needs: databricks CLI (profile auth) + psql + a running SQL warehouse.
Note: Nominatim policy is ~1 req/sec, so ~10k facilities ≈ 3 h. Results are
MERGEd into silver every 500 rows, so a partial/interrupted run still persists.
"""
import json, math, os, subprocess, tempfile, time, urllib.parse, urllib.request

PROFILE = "Hack-FreeTrial"
WAREHOUSE = "c86afd7fafc4940f"
EP = "projects/referral-copilot/branches/production/endpoints/primary"
PGUSER = "akshaybhan28@gmail.com"
PGDB = "databricks_postgres"
SP = "783b9f28-86d5-43f1-8540-fe5d3dcfd489"
B = "dais_hackathon.bronze.bronze_facilities"
SILVER = "dais_hackathon.silver.facility_geo_validated"
CITY_KM = 80          # stage 1: max distance from the city's median centre
GEOCODER_KM = 15      # stage 2: max distance from the geocoder's result
GEOCODER = os.environ.get("GEOCODER", "none").lower()   # none | nominatim | google
GEO_MAX = int(os.environ.get("GEO_MAX", "0"))           # 0 = all
GKEY = os.environ.get("GOOGLE_MAPS_API_KEY")

# ---------- Databricks SQL (warehouse) ----------
def _api(method, path, body=None):
    args = ["databricks", "api", method, path, "--profile", PROFILE]
    if body is not None:
        f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False); json.dump(body, f); f.close()
        args += ["--json", f"@{f.name}"]
    r = subprocess.run(args, capture_output=True, text=True)
    if body is not None: os.unlink(f.name)
    if r.returncode != 0: raise RuntimeError(f"{path}: {r.stderr[:600]}")
    return json.loads(r.stdout)

def dbsql(stmt):
    res = _api("post", "/api/2.0/sql/statements",
               {"warehouse_id": WAREHOUSE, "wait_timeout": "50s", "disposition": "INLINE",
                "format": "JSON_ARRAY", "statement": stmt})
    sid = res["statement_id"]
    while res["status"]["state"] in ("PENDING", "RUNNING"):
        time.sleep(2); res = _api("get", f"/api/2.0/sql/statements/{sid}")
    if res["status"]["state"] != "SUCCEEDED":
        raise RuntimeError(json.dumps(res["status"])[:600])
    total = res.get("manifest", {}).get("total_chunk_count", 1)
    rows = list(res.get("result", {}).get("data_array", []) or [])
    for n in range(1, total):
        rows += _api("get", f"/api/2.0/sql/statements/{sid}/result/chunks/{n}").get("data_array", []) or []
    return rows

# ---------- Lakebase (write geo_valid the app reads) ----------
HOST = json.loads(subprocess.run(["databricks", "postgres", "get-endpoint", EP, "--profile", PROFILE, "-o", "json"],
                                 capture_output=True, text=True).stdout)["status"]["hosts"]["host"]
TOKEN = json.loads(subprocess.run(["databricks", "postgres", "generate-database-credential", EP, "--profile", PROFILE, "-o", "json"],
                                  capture_output=True, text=True).stdout)["token"]
CONN = f"host={HOST} user={PGUSER} dbname={PGDB} sslmode=require"

def psql(sql):
    r = subprocess.run(["psql", CONN, "-v", "ON_ERROR_STOP=1", "-c", sql],
                       capture_output=True, text=True, env={**os.environ, "PGPASSWORD": TOKEN})
    if r.returncode != 0: raise RuntimeError(r.stderr[:800])
    return r.stdout.strip()

def copy_geo(rows):
    path = "/tmp/rc_geo.tsv"
    with open(path, "w") as f:
        for fid, valid, dist in rows:
            f.write("%s\t%s\t%s\n" % (fid, "t" if valid else "f", "\\N" if dist is None else dist))
    r = subprocess.run(["psql", CONN, "-v", "ON_ERROR_STOP=1", "-c",
                        "\\copy referral.facility_geo(facility_id, geo_valid, dist_km) from '/tmp/rc_geo.tsv'"],
                       capture_output=True, text=True, env={**os.environ, "PGPASSWORD": TOKEN})
    if r.returncode != 0: raise RuntimeError(r.stderr[:800])

# ---------- external geocoders (stage 2) ----------
def nominatim_geocode(address):
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
        {"q": address, "format": "json", "countrycodes": "in", "limit": 1})
    req = urllib.request.Request(url, headers={"User-Agent": "referral-copilot/1.0 (hackathon; coord-validation)"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        d = json.loads(resp.read())
    return (float(d[0]["lat"]), float(d[0]["lon"])) if d else None

def google_geocode(address):
    url = "https://maps.googleapis.com/maps/api/geocode/json?" + urllib.parse.urlencode(
        {"address": address, "region": "in", "key": GKEY})
    with urllib.request.urlopen(url, timeout=15) as resp:
        d = json.loads(resp.read())
    if d.get("status") == "OK" and d["results"]:
        loc = d["results"][0]["geometry"]["location"]
        return loc["lat"], loc["lng"]
    return None

def geocode_one(address):
    if GEOCODER == "google":
        return google_geocode(address)
    return nominatim_geocode(address)

GEO_DELAY = 0.05 if GEOCODER == "google" else 1.1   # Nominatim policy: ≤1 req/sec

def hav(a, b, c, d):
    r = math.pi / 180
    h = math.sin((c - a) * r / 2) ** 2 + math.cos(a * r) * math.cos(c * r) * math.sin((d - b) * r / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))

def merge_google(updates):
    vals = ",".join(
        "('%s',%s,%s,%s,%s)" % (fid, a, b, dist, str(v).lower()) for fid, a, b, dist, v in updates)
    dbsql(f"""MERGE INTO {SILVER} t USING (
      SELECT * FROM VALUES {vals} AS x(facility_id, glat, glng, gdist, gvalid)) s
      ON t.facility_id = s.facility_id
      WHEN MATCHED THEN UPDATE SET google_lat=s.glat, google_lng=s.glng,
        google_dist_km=s.gdist, geo_valid_google=s.gvalid""")

# ---------- pipeline ----------
SILVER_SQL = f"""
CREATE SCHEMA IF NOT EXISTS dais_hackathon.silver;
CREATE OR REPLACE TABLE {SILVER} AS
WITH base AS (
  SELECT unique_id AS facility_id, name,
    concat_ws(', ', name, address_city, initcap(trim(address_stateOrRegion)), 'India') AS address,
    address_city AS city, initcap(trim(address_stateOrRegion)) AS state,
    CASE WHEN latitude BETWEEN 6 AND 37.6 AND longitude BETWEEN 68 AND 97.6 THEN latitude END AS lat,
    CASE WHEN latitude BETWEEN 6 AND 37.6 AND longitude BETWEEN 68 AND 97.6 THEN longitude END AS lng
  FROM {B} WHERE unique_id IS NOT NULL AND name IS NOT NULL
  QUALIFY row_number() OVER (PARTITION BY unique_id ORDER BY recency_of_page_update DESC NULLS LAST) = 1),
cc AS (
  SELECT lower(city) c, lower(coalesce(state,'')) s,
    percentile(lat,0.5) mlat, percentile(lng,0.5) mlng, count(*) n
  FROM base WHERE lat IS NOT NULL GROUP BY 1,2),
d AS (
  SELECT b.*, cc.n,
    CASE WHEN cc.mlat IS NULL THEN NULL ELSE
      6371*acos(least(1,greatest(-1, sin(radians(cc.mlat))*sin(radians(b.lat))
        +cos(radians(cc.mlat))*cos(radians(b.lat))*cos(radians(b.lng-cc.mlng))))) END dist_from_city_km
  FROM base b LEFT JOIN cc ON lower(b.city)=cc.c AND lower(coalesce(b.state,''))=cc.s)
SELECT facility_id, name, address, city, state, lat, lng,
  round(dist_from_city_km,1) AS dist_from_city_km, n AS city_facility_count,
  (lat IS NOT NULL AND (n < 5 OR dist_from_city_km IS NULL OR dist_from_city_km <= {CITY_KM})) AS geo_valid_internal,
  CAST(NULL AS double) AS google_lat, CAST(NULL AS double) AS google_lng,
  CAST(NULL AS double) AS google_dist_km, CAST(NULL AS boolean) AS geo_valid_google,
  current_timestamp() AS validated_at
FROM d
"""

if __name__ == "__main__":
    print(f"1/4 building {SILVER} (stage 1: internal consistency, within {CITY_KM}km of city median)...")
    dbsql(SILVER_SQL)
    n_total = int(dbsql(f"SELECT count(*) FROM {SILVER}")[0][0])
    n_int = int(dbsql(f"SELECT count(*) FROM {SILVER} WHERE geo_valid_internal")[0][0])
    print(f"    {n_int}/{n_total} pass internal consistency ({n_total - n_int} flagged)")

    if GEOCODER in ("nominatim", "google"):
        rows = dbsql(f"SELECT facility_id, address, lat, lng FROM {SILVER} WHERE lat IS NOT NULL")
        if GEO_MAX:
            rows = rows[:GEO_MAX]
        eta_h = len(rows) * GEO_DELAY / 3600
        print(f"2/4 stage 2: {GEOCODER} geocoding {len(rows)} facilities (within {GEOCODER_KM}km, ~{eta_h:.1f}h)...")
        batch, done = [], 0
        for fid, addr, lat, lng in rows:
            try:
                g = geocode_one(addr)
            except Exception:
                g = None
            if g:
                dist = hav(float(lat), float(lng), g[0], g[1])
                batch.append((fid, round(g[0], 6), round(g[1], 6), round(dist, 1), dist <= GEOCODER_KM))
            done += 1
            if len(batch) >= 500:
                merge_google(batch); batch = []
                print(f"    geocoded {done}/{len(rows)} (persisted)")
            time.sleep(GEO_DELAY)
        if batch:
            merge_google(batch)
        print(f"    {GEOCODER} validation complete")
    else:
        print("2/4 stage 2 skipped (set GEOCODER=nominatim or GEOCODER=google to enable)")

    print("3/4 final geo_valid = internal AND (geocoder passes OR geocoder not run)...")
    valid_rows = dbsql(f"""
      SELECT facility_id,
        geo_valid_internal AND (geo_valid_google IS NULL OR geo_valid_google) AS geo_valid,
        coalesce(google_dist_km, dist_from_city_km)
      FROM {SILVER} WHERE lat IS NOT NULL""")

    print("4/4 pushing geo_valid -> Lakebase referral.facility_geo (the app reads this)...")
    psql("CREATE TABLE IF NOT EXISTS referral.facility_geo (facility_id text PRIMARY KEY, geo_valid boolean, dist_km numeric);")
    psql("TRUNCATE referral.facility_geo;")
    copy_geo([(r[0], r[1] in (True, "true", "t", "True"), r[2]) for r in valid_rows])
    psql(f'GRANT SELECT ON referral.facility_geo TO "{SP}";')
    print(f"\ndone. silver: {SILVER}  | valid in Lakebase:",
          psql("select count(*) filter (where geo_valid) from referral.facility_geo;"))
