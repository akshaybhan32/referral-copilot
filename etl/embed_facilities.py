#!/usr/bin/env python3
"""Build the vector index: embed every facility with databricks-gte-large-en (1024-d),
store in Lakebase pgvector, and create a hybrid (geo + semantic) search function.

Why: lexical match misses paraphrases ("renal replacement therapy" vs "dialysis").
Embeddings give semantic recall across 10k facilities; geo radius + cosine similarity
run together in one Postgres query.

Run:  python3 etl/embed_facilities.py     (after load_from_uc.py)
"""
import json, os, re, subprocess, tempfile, time

PROFILE = "Hack-FreeTrial"
WAREHOUSE = "c86afd7fafc4940f"
EMB_ENDPOINT = "databricks-gte-large-en"
DIM = 1024
EP = "projects/referral-copilot/branches/production/endpoints/primary"
PGUSER = "akshaybhan28@gmail.com"
PGDB = "databricks_postgres"
EMB_TABLE = "dais_hackathon.bronze.rc_facility_emb"   # materialized embeddings in UC
B = "dais_hackathon.bronze.bronze_facilities"

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
        time.sleep(3); res = _api("get", f"/api/2.0/sql/statements/{sid}")
    if res["status"]["state"] != "SUCCEEDED":
        raise RuntimeError(json.dumps(res["status"])[:600])
    total = res.get("manifest", {}).get("total_chunk_count", 1)
    rows = list(res.get("result", {}).get("data_array", []) or [])
    for n in range(1, total):
        rows += _api("get", f"/api/2.0/sql/statements/{sid}/result/chunks/{n}").get("data_array", []) or []
    return rows

HOST = json.loads(subprocess.run(["databricks", "postgres", "get-endpoint", EP, "--profile", PROFILE, "-o", "json"],
                                 capture_output=True, text=True).stdout)["status"]["hosts"]["host"]
TOKEN = json.loads(subprocess.run(["databricks", "postgres", "generate-database-credential", EP, "--profile", PROFILE, "-o", "json"],
                                  capture_output=True, text=True).stdout)["token"]
CONN = f"host={HOST} user={PGUSER} dbname={PGDB} sslmode=require"

def psql(sql, copy_from=None):
    cmd = ["psql", CONN, "-v", "ON_ERROR_STOP=1", "-c", sql]
    r = subprocess.run(cmd, capture_output=True, text=True, env={**os.environ, "PGPASSWORD": TOKEN})
    if r.returncode != 0: raise RuntimeError(r.stderr[:800])
    return r.stdout.strip()

def copy_vec(path):
    cmd = f"\\copy referral.facility_vec(facility_id, embedding) from '{path}'"
    r = subprocess.run(["psql", CONN, "-v", "ON_ERROR_STOP=1", "-c", cmd],
                       capture_output=True, text=True, env={**os.environ, "PGPASSWORD": TOKEN})
    if r.returncode != 0: raise RuntimeError(r.stderr[:800])

DOC = f"""concat_ws(' ', name,
  coalesce(array_join(from_json(specialties,'array<string>'),' '),''),
  coalesce(array_join(from_json(procedure,'array<string>'),' '),''),
  coalesce(array_join(from_json(capability,'array<string>'),' '),''),
  coalesce(description,''))"""

if __name__ == "__main__":
    try:
        n = int(dbsql(f"SELECT count(*) FROM {EMB_TABLE}")[0][0])
        print(f"1/5 reusing existing embeddings in {EMB_TABLE} ({n} rows)")
    except Exception:
        n = 0
    if n == 0:
        print(f"1/5 materializing embeddings in UC ({EMB_TABLE}) via {EMB_ENDPOINT} ...")
        dbsql(f"""CREATE OR REPLACE TABLE {EMB_TABLE} AS
          SELECT unique_id AS facility_id, ai_query('{EMB_ENDPOINT}', {DOC}) AS emb
          FROM {B} WHERE unique_id IS NOT NULL AND name IS NOT NULL
          QUALIFY row_number() OVER (PARTITION BY unique_id ORDER BY recency_of_page_update DESC NULLS LAST) = 1""")
        n = int(dbsql(f"SELECT count(*) FROM {EMB_TABLE}")[0][0])
        print(f"    embedded {n} facilities")

    print("2/5 enabling pgvector + facility_vec table ...")
    psql(f"""CREATE EXTENSION IF NOT EXISTS vector;
      DROP TABLE IF EXISTS referral.facility_vec;
      CREATE TABLE referral.facility_vec (
        facility_id text PRIMARY KEY REFERENCES referral.facility(facility_id) ON DELETE CASCADE,
        embedding vector({DIM}));""")

    print("3/5 loading vectors into Lakebase (batched) ...")
    BATCH = 1000
    for off in range(0, n, BATCH):
        rows = dbsql(f"""SELECT facility_id, concat('[', array_join(emb, ','), ']')
          FROM (SELECT facility_id, emb, row_number() OVER (ORDER BY facility_id) rn FROM {EMB_TABLE})
          WHERE rn > {off} AND rn <= {off + BATCH}""")
        path = "/tmp/rc_vec.tsv"
        with open(path, "w") as f:
            for fid, vec in rows:
                f.write(f"{fid}\t{vec}\n")
        copy_vec(path)
        print(f"    loaded {off + len(rows)}/{n}")

    # NOTE: no HNSW index — the 512MB free-trial Lakebase cap can't fit it, and a
    # sequential cosine scan over ~10k vectors is sub-100ms. Re-add when on a larger
    # tier: CREATE INDEX ix_facility_vec ON referral.facility_vec USING hnsw (embedding vector_cosine_ops);
    print("4/4 creating hybrid search function search_facilities_vec ...")
    psql(f"""
CREATE OR REPLACE FUNCTION referral.search_facilities_vec(
  q_emb vector, p_lat double precision, p_lng double precision,
  p_radius_km numeric DEFAULT 50, p_facility_type text DEFAULT NULL,
  p_operator_type text DEFAULT NULL, p_limit int DEFAULT 20)
RETURNS TABLE (facility_id text, name text, facility_type text, operator_type text,
  distance_km numeric, similarity numeric, score numeric, match_reason text,
  beds int, num_doctors int, official_phone text, official_website text, city text, state text)
LANGUAGE sql STABLE AS $fn$
WITH near AS (
  SELECT f.*, v.embedding,
    6371*acos(least(1,greatest(-1,
      sin(radians(p_lat))*sin(radians(f.lat))+
      cos(radians(p_lat))*cos(radians(f.lat))*cos(radians(f.lng-p_lng))))) dist_km
  FROM referral.facility f JOIN referral.facility_vec v ON v.facility_id=f.facility_id
  WHERE f.lat BETWEEN p_lat-(p_radius_km/111.0) AND p_lat+(p_radius_km/111.0)
    AND f.lng BETWEEN p_lng-(p_radius_km/(111.0*cos(radians(p_lat))))
                  AND p_lng+(p_radius_km/(111.0*cos(radians(p_lat))))
    AND (p_facility_type IS NULL OR f.facility_type=p_facility_type)
    AND (p_operator_type IS NULL OR f.operator_type=p_operator_type)),
within AS (SELECT *, (1-(embedding <=> q_emb)) sim FROM near WHERE dist_km <= p_radius_km)
SELECT w.facility_id, w.name, w.facility_type, w.operator_type,
  round(w.dist_km::numeric,1), round(w.sim::numeric,3),
  round((0.60*w.sim + 0.25*(1-(w.dist_km/p_radius_km))
       + 0.10*least(1.0,coalesce(w.beds,0)::numeric/200)
       + 0.05*least(1.0,coalesce(w.num_doctors,0)::numeric/30))::numeric,4),
  coalesce(left((SELECT string_agg(p.procedure,' • ')
                 FROM (SELECT procedure FROM referral.facility_procedure
                       WHERE facility_id=w.facility_id LIMIT 3) p), 220), w.name),
  w.beds, w.num_doctors, w.official_phone, w.official_website, w.city, w.state
FROM within w
ORDER BY 7 DESC, 5 ASC LIMIT p_limit;
$fn$;""")
    # let the app SP use it
    SP = "783b9f28-86d5-43f1-8540-fe5d3dcfd489"
    psql(f'GRANT SELECT ON referral.facility_vec TO "{SP}";')
    psql(f'GRANT EXECUTE ON FUNCTION referral.search_facilities_vec(vector,double precision,double precision,numeric,text,text,int) TO "{SP}";')
    print("\ndone. vectors:", psql("select count(*) from referral.facility_vec;"))
