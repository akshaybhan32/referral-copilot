#!/usr/bin/env python3
"""Facility verification layer — Lakebase-native (no SQL warehouse needed).

Turns self-reported facility claims into *verified* evidence by matching our
facilities against authoritative registries via entity resolution (fuzzy name +
city/PIN), then exposing a `verified` flag + source the app shows as a badge.

Sources (drop exports as CSVs into data/registry/, columns:
  source,registry_name,city,state,pincode,facility_type,services,accredited):
  - PMJAY / Ayushman Bharat empanelled hospitals + Health Benefit Packages
      https://hospitals.pmjay.gov.in  (state/district/specialty search; export per state)
  - ABDM Health Facility Registry (HFR)
      https://facility.abdm.gov.in/searchV2  (public search; bulk via the ABDM gateway API)
  - NABH / NABL accreditation lists (quality signal)
A small real sample ships in data/registry/sample.csv so this runs end-to-end now.

Entity resolution: for each registry row we pick the best facility match by
pg_trgm name similarity, constrained to the same PIN or city, above a threshold.

Outputs (Lakebase): referral.facility_verification — the app reads this.

Run:  python3 etl/verify_facilities.py [data/registry/*.csv ...]
Needs: databricks CLI (profile auth) + psql.
"""
import csv, glob, json, os, subprocess, sys

PROFILE = "Hack-FreeTrial"
EP = "projects/referral-copilot/branches/production/endpoints/primary"
PGUSER = "akshaybhan28@gmail.com"
PGDB = "databricks_postgres"
SP = "783b9f28-86d5-43f1-8540-fe5d3dcfd489"
PIN_THRESHOLD = 0.40    # name similarity needed when the PIN also matches (strong blocker)
CITY_THRESHOLD = 0.62   # higher bar when only the city matches (weak blocker → avoid false positives)

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

def copy_stage(rows):
    path = "/tmp/rc_registry.tsv"
    def esc(v):
        return "\\N" if v in (None, "") else str(v).replace("\\", "\\\\").replace("\t", " ").replace("\n", " ")
    with open(path, "w") as f:
        for r in rows:
            f.write("\t".join(esc(r[c]) for c in
                    ["source", "registry_name", "city", "state", "pincode", "facility_type", "services", "accredited"]) + "\n")
    r = subprocess.run(["psql", CONN, "-v", "ON_ERROR_STOP=1", "-c",
                        "\\copy referral.registry_stage(source,registry_name,city,state,pincode,facility_type,services,accredited) from '%s'" % path],
                       capture_output=True, text=True, env={**os.environ, "PGPASSWORD": TOKEN})
    if r.returncode != 0:
        raise RuntimeError(r.stderr[:800])

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS referral.registry_stage (
  source text, registry_name text, city text, state text, pincode text,
  facility_type text, services text, accredited boolean);
TRUNCATE referral.registry_stage;
CREATE TABLE IF NOT EXISTS referral.facility_verification (
  facility_id text PRIMARY KEY,
  source text, registry_name text, registry_type text,
  verified boolean DEFAULT true, accredited boolean,
  verified_services text[], match_score numeric, verified_at timestamptz DEFAULT now());
"""

# Best fuzzy match per registry row, constrained to same PIN or city, above threshold.
MATCH_SQL = f"""
TRUNCATE referral.facility_verification;
INSERT INTO referral.facility_verification
  (facility_id, source, registry_name, registry_type, accredited, verified_services, match_score)
SELECT facility_id, source, registry_name, facility_type, accredited,
       string_to_array(lower(services), ';'), round(score::numeric, 3)
FROM (
  SELECT f.facility_id, g.source, g.registry_name, g.facility_type, g.accredited, g.services,
    similarity(f.name, g.registry_name) AS score,
    row_number() OVER (PARTITION BY f.facility_id ORDER BY similarity(f.name, g.registry_name) DESC) AS rn
  FROM referral.registry_stage g
  JOIN referral.facility f
    ON ( (f.pincode = g.pincode      AND similarity(f.name, g.registry_name) >= {PIN_THRESHOLD})
      OR (lower(f.city) = lower(g.city) AND similarity(f.name, g.registry_name) >= {CITY_THRESHOLD}) )
) m
WHERE rn = 1
ON CONFLICT (facility_id) DO UPDATE SET
  source = EXCLUDED.source, registry_name = EXCLUDED.registry_name,
  registry_type = EXCLUDED.registry_type, accredited = EXCLUDED.accredited,
  verified_services = EXCLUDED.verified_services, match_score = EXCLUDED.match_score, verified_at = now();
"""

if __name__ == "__main__":
    files = sys.argv[1:] or sorted(glob.glob("data/registry/*.csv"))
    if not files:
        print("no registry CSVs found in data/registry/ — see the docstring for sources.")
        sys.exit(1)
    print(f"1/3 ensuring tables + staging {len(files)} registry file(s)...")
    psql(SCHEMA_SQL)
    rows = []
    for path in files:
        with open(path, newline="") as fh:
            rows += list(csv.DictReader(fh))
    copy_stage(rows)
    print(f"    staged {len(rows)} registry records")

    print(f"2/3 entity-resolving (name sim ≥ {PIN_THRESHOLD} when PIN matches, ≥ {CITY_THRESHOLD} for city-only)...")
    psql(MATCH_SQL)

    print("3/3 granting + summarizing...")
    psql(f'GRANT SELECT ON referral.facility_verification TO "{SP}";')
    n = psql("select count(*) from referral.facility_verification;", tuples=True)
    print(f"\ndone. verified facilities: {n}")
    print(psql("select source, count(*) from referral.facility_verification group by 1 order by 2 desc;"))
