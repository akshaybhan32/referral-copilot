#!/usr/bin/env python3
"""Load referral.* in Lakebase from the real UC bronze tables (replaces the seed).

Reads dais_hackathon.bronze.{bronze_facilities, bronze_india_post_pincode_directory,
bronze_nfhs_5_district_health_indicators} via the Serverless SQL warehouse, does the
normalization in Spark SQL (India-bbox coord guard, explode JSON-string arrays,
PIN de-fan-out), and bulk-loads into Lakebase via psql \\copy.

Run:  python3 etl/load_from_uc.py
Needs: databricks CLI (profile auth) + psql on PATH. No pip installs.
"""
import json, os, re, subprocess, tempfile, time

PROFILE = "Hack-FreeTrial"
WAREHOUSE = "c86afd7fafc4940f"
EP = "projects/referral-copilot/branches/production/endpoints/primary"
PGUSER = "akshaybhan28@gmail.com"
PGDB = "databricks_postgres"

# ---------- Databricks SQL (read bronze) ----------
def _api(method, path, body=None):
    args = ["databricks", "api", method, path, "--profile", PROFILE]
    if body is not None:
        f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(body, f); f.close()
        args += ["--json", f"@{f.name}"]
    r = subprocess.run(args, capture_output=True, text=True)
    if body is not None:
        os.unlink(f.name)
    if r.returncode != 0:
        raise RuntimeError(f"{path}: {r.stderr[:600]}")
    return json.loads(r.stdout)

def dbsql(stmt):
    res = _api("post", "/api/2.0/sql/statements",
               {"warehouse_id": WAREHOUSE, "wait_timeout": "50s",
                "disposition": "INLINE", "format": "JSON_ARRAY", "statement": stmt})
    sid = res["statement_id"]
    while res["status"]["state"] in ("PENDING", "RUNNING"):
        time.sleep(2)
        res = _api("get", f"/api/2.0/sql/statements/{sid}")
    if res["status"]["state"] != "SUCCEEDED":
        raise RuntimeError(json.dumps(res["status"])[:600])
    total = res.get("manifest", {}).get("total_chunk_count", 1)
    rows = list(res.get("result", {}).get("data_array", []) or [])
    for n in range(1, total):
        rows += _api("get", f"/api/2.0/sql/statements/{sid}/result/chunks/{n}").get("data_array", []) or []
    return rows

# ---------- Lakebase (write) ----------
HOST = _api_host = json.loads(subprocess.run(
    ["databricks", "postgres", "get-endpoint", EP, "--profile", PROFILE, "-o", "json"],
    capture_output=True, text=True).stdout)["status"]["hosts"]["host"]
TOKEN = json.loads(subprocess.run(
    ["databricks", "postgres", "generate-database-credential", EP, "--profile", PROFILE, "-o", "json"],
    capture_output=True, text=True).stdout)["token"]
CONN = f"host={HOST} user={PGUSER} dbname={PGDB} sslmode=require"

def psql(sql):
    r = subprocess.run(["psql", CONN, "-v", "ON_ERROR_STOP=1", "-c", sql],
                       capture_output=True, text=True, env={**os.environ, "PGPASSWORD": TOKEN})
    if r.returncode != 0:
        raise RuntimeError(r.stderr[:800])
    return r.stdout.strip()

def copy_in(table, cols, rows):
    # Postgres TEXT format: tab-delimited, \N = null. Text fields already have
    # tabs/newlines stripped server-side, so we only escape backslashes.
    path = f"/tmp/rc_{table.split('.')[-1]}.tsv"
    def esc(v):
        # replace ALL control chars (NUL, tab, CR, LF, etc.) with space; escape backslash
        if v is None:
            return "\\N"
        return re.sub(r"[\x00-\x1f\x7f]", " ", str(v)).replace("\\", "\\\\")
    with open(path, "w") as f:
        for row in rows:
            f.write("\t".join(esc(v) for v in row) + "\n")
    cmd = f"\\copy {table}({cols}) from '{path}'"
    r = subprocess.run(["psql", CONN, "-v", "ON_ERROR_STOP=1", "-c", cmd],
                       capture_output=True, text=True, env={**os.environ, "PGPASSWORD": TOKEN})
    if r.returncode != 0:
        raise RuntimeError(f"{table}: {r.stderr[:800]}")
    print(f"  loaded {len(rows):>6} -> {table}")

# ---------- transforms (Spark SQL) ----------
B = "dais_hackathon.bronze"
INDIA = "latitude between 6.0 and 37.6 and longitude between 68.0 and 97.6"
# strip CR/LF/TAB so a single CSV row stays a single row
def SAN(c):
    return f"translate(coalesce({c},''), concat(chr(10),chr(13),chr(9)), '   ')"

# Valid facility-type vocabulary. Some upstream bronze rows are column-shifted
# (a description's commas/newlines split the source CSV before it reached bronze),
# leaking prose / coordinates / JSON / hash ids into facilityTypeId. We (a) normalize
# the 'null' string + the 'farmacy' typo, and (b) DROP rows whose type isn't a known
# category, which is a reliable tell that the whole row is misaligned garbage.
TYPE_VOCAB = "('hospital','clinic','dentist','doctor','pharmacy','farmacy','nursing_home')"
TYPE_NORM = (
    "CASE WHEN lower(trim(facilityTypeId)) IN ('null','') THEN NULL "
    "WHEN lower(trim(facilityTypeId)) = 'farmacy' THEN 'pharmacy' "
    "ELSE lower(trim(facilityTypeId)) END")

FACILITY = f"""
SELECT unique_id, {SAN('name')}, {TYPE_NORM}, lower(operatorTypeId),
  try_cast(yearEstablished as int), try_cast(capacity as int), try_cast(numberDoctors as int),
  {SAN('address_city')}, initcap(trim(address_stateOrRegion)),
  CASE WHEN regexp_replace(coalesce(address_zipOrPostcode,''),'\\\\s','') rlike '^[0-9]{{6}}$'
       THEN regexp_replace(address_zipOrPostcode,'\\\\s','') END,
  CASE WHEN {INDIA} THEN latitude END,
  CASE WHEN {INDIA} THEN longitude END,
  CASE WHEN {INDIA} THEN 'exact_spatial' ELSE 'unresolved' END,
  officialPhone, officialWebsite, email, {SAN('description')}, try_cast(recency_of_page_update as date)
FROM {B}.bronze_facilities
WHERE unique_id IS NOT NULL AND name IS NOT NULL
  -- drop column-shifted garbage: type must be empty/null or a known category
  AND (facilityTypeId IS NULL
       OR lower(trim(facilityTypeId)) IN ('null','')
       OR lower(trim(facilityTypeId)) IN {TYPE_VOCAB})
QUALIFY row_number() OVER (PARTITION BY unique_id ORDER BY recency_of_page_update DESC NULLS LAST) = 1"""

def explode_q(col):
    # neutral, table-qualified alias t.val to avoid colliding with the source column name
    return f"""SELECT DISTINCT unique_id, {SAN('trim(t.val)')} FROM {B}.bronze_facilities
      LATERAL VIEW explode(from_json({col},'array<string>')) t AS val
      WHERE t.val IS NOT NULL AND trim(t.val) <> ''"""

PHONE = f"""SELECT unique_id, ph, max(ph = officialPhone) FROM {B}.bronze_facilities
  LATERAL VIEW explode(from_json(phone_numbers,'array<string>')) t AS ph
  WHERE ph IS NOT NULL AND trim(ph) <> '' GROUP BY unique_id, ph"""
SOURCE = f"""SELECT DISTINCT unique_id, u FROM {B}.bronze_facilities
  LATERAL VIEW explode(from_json(source_urls,'array<string>')) t AS u
  WHERE u IS NOT NULL AND trim(u) <> ''"""

PIN = f"""
SELECT pincode,
  element_at(array_distinct(collect_list(d)),1),
  element_at(array_distinct(collect_list(s)),1),
  count(distinct d) > 1, avg(latc), avg(lngc)
FROM (
  SELECT cast(pincode as string) pincode, initcap(trim(district)) d, initcap(trim(statename)) s,
    CASE WHEN try_cast(latitude as double) between 6 and 37.6
          AND try_cast(longitude as double) between 68 and 97.6 THEN try_cast(latitude as double) END latc,
    CASE WHEN try_cast(latitude as double) between 6 and 37.6
          AND try_cast(longitude as double) between 68 and 97.6 THEN try_cast(longitude as double) END lngc
  FROM {B}.bronze_india_post_pincode_directory
  WHERE cast(pincode as string) rlike '^[0-9]{{6}}$'
) GROUP BY pincode"""

# ---------- run ----------
if __name__ == "__main__":
    print("truncating referral.* (replacing seed)...")
    # facility_website dropped (redundant with facility.official_website; freed for the 512MB cap)
    psql("TRUNCATE referral.facility, referral.facility_specialty, referral.facility_procedure, "
         "referral.facility_capability, referral.facility_phone, "
         "referral.facility_source_url, referral.pin_geo RESTART IDENTITY CASCADE;")

    print("facility core...");      copy_in("referral.facility",
        "facility_id,name,facility_type,operator_type,year_established,beds,num_doctors,city,state,"
        "pincode,lat,lng,geo_confidence,official_phone,official_website,email,description,recency_of_update",
        dbsql(FACILITY))
    print("specialties...");        copy_in("referral.facility_specialty", "facility_id,specialty", dbsql(explode_q("specialties")))
    print("procedures...");         copy_in("referral.facility_procedure", "facility_id,procedure", dbsql(explode_q("procedure")))
    print("capabilities...");       copy_in("referral.facility_capability", "facility_id,capability", dbsql(explode_q("capability")))
    print("phones...");             copy_in("referral.facility_phone", "facility_id,phone,is_official", dbsql(PHONE))
    print("source urls...");        copy_in("referral.facility_source_url", "facility_id,source_url", dbsql(SOURCE))
    print("pin geo...");            copy_in("referral.pin_geo", "pincode,primary_district,primary_state,is_ambiguous,centroid_lat,centroid_lng", dbsql(PIN))

    print("\n=== counts ===")
    print(psql("select 'facilities='||count(*) from referral.facility "
               "union all select 'with_coords='||count(*) from referral.facility where lat is not null "
               "union all select 'specialties='||count(*) from referral.facility_specialty "
               "union all select 'procedures='||count(*) from referral.facility_procedure "
               "union all select 'capabilities='||count(*) from referral.facility_capability "
               "union all select 'pins='||count(*) from referral.pin_geo;"))
    print("\nNext: python3 etl/embed_facilities.py  (builds the vector index)")
