#!/usr/bin/env python3
"""Ingest Haryana's official AB-PMJAY empanelled-hospital lists into our registry CSV.

Source (official Govt. of Haryana portal — district-wise PDFs):
    https://ayushmanbharat.haryana.gov.in/pm-jay/

The page links one PDF per district ("List of Empanelled Hospitals of District
<X> (Haryana) under AB-PMJAY"). Each PDF is a table:
    S.no | Hospital ID | Hospital Name | Hospital Type | Email | Nodal Officer | Contact

We pull the page, discover the per-district PDF links, download + parse each,
and write a single CSV in the schema etl/verify_facilities.py expects:
    source,registry_name,city,state,pincode,facility_type,services,accredited

Then:  python3 etl/verify_facilities.py   (entity-resolves these to our facilities)

Deps:  pypdf   (pip install pypdf)
Run:   python3 etl/ingest_pmjay_haryana.py --out data/registry
Polite: single-threaded with a delay between downloads from a .gov source.
"""
from __future__ import annotations
import argparse, csv, html, os, re, sys, time, urllib.request

PAGE_URL = "https://ayushmanbharat.haryana.gov.in/pm-jay/"
STATE = "Haryana"
DELAY_S = 1.0
TIMEOUT_S = 60
UA = "Mozilla/5.0 (compatible; referral-copilot/1.0; +open-data ingest)"
CSV_COLUMNS = ["source", "registry_name", "city", "state",
               "pincode", "facility_type", "services", "accredited"]


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
        return r.read()


def discover_district_pdfs(page_html: str) -> list[tuple[str, str]]:
    """Return [(district, pdf_url)] from the listing page.
    Anchor text looks like 'Gurugram (PDF 169 KB)'."""
    out: list[tuple[str, str]] = []
    for m in re.finditer(r'<a[^>]+href="(https://cdnbbsr[^"]+\.pdf)"[^>]*>(.*?)</a>',
                          page_html, re.I | re.S):
        url = m.group(1)
        label = html.unescape(re.sub(r"<[^>]+>", "", m.group(2)))
        label = re.sub(r"\s+", " ", label).strip()
        # keep only "<District> (PDF ...)" entries; skip manuals/other docs
        dm = re.match(r"^([A-Za-z][A-Za-z .]+?)\s*\(PDF", label)
        if dm:
            out.append((dm.group(1).strip(), url))
    return out


def parse_pdf(pdf_bytes: bytes) -> tuple[str, list[tuple[str, str]]]:
    """Return (district, [(name, type)]) parsed from one district PDF."""
    import pypdf, io
    reader = pypdf.PdfReader(io.BytesIO(pdf_bytes))
    text = "\n".join(p.extract_text() or "" for p in reader.pages)
    dm = re.search(r"District\s+([\w][\w ]*?)\s*\(Haryana\)", text)
    district = dm.group(1).strip() if dm else ""
    rows: list[tuple[str, str]] = []
    # name sits between the Hospital ID and the Public/Private type token;
    # names may wrap across lines, so collapse whitespace.
    for name, typ in re.findall(r"HOSP\w+\s+(.+?)\s+(Public|Private)\b", text, re.S):
        name = re.sub(r"\s+", " ", name).strip()
        if name:
            rows.append((name, typ))
    return district, rows


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default="data/registry", help="output directory")
    ap.add_argument("--page", default=PAGE_URL, help="override source page URL")
    args = ap.parse_args()

    print(f"Fetching listing page {args.page}", file=sys.stderr)
    districts = discover_district_pdfs(fetch(args.page).decode("utf-8", "ignore"))
    print(f"  found {len(districts)} district PDFs", file=sys.stderr)
    if not districts:
        print("No district PDFs found — page structure may have changed.", file=sys.stderr)
        return 1

    all_rows: list[dict] = []
    for label, url in districts:
        try:
            district, hospitals = parse_pdf(fetch(url))
        except Exception as e:  # noqa: BLE001 — keep going on a bad PDF
            print(f"  ! {label}: {e}", file=sys.stderr)
            time.sleep(DELAY_S)
            continue
        city = district or label
        for name, typ in hospitals:
            all_rows.append({
                "source": "PMJAY",
                "registry_name": name,
                "city": city,
                "state": STATE,
                "pincode": "",          # not in the source PDFs
                "facility_type": typ,   # Public / Private
                "services": "",         # not in the source PDFs
                "accredited": "false",
            })
        print(f"  {city}: {len(hospitals)} hospitals", file=sys.stderr)
        time.sleep(DELAY_S)

    # de-dupe on (name, city)
    seen: set[tuple[str, str]] = set()
    deduped = []
    for r in all_rows:
        key = (r["registry_name"].lower(), r["city"].lower())
        if key not in seen:
            seen.add(key)
            deduped.append(r)

    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, "pmjay_haryana.csv")
    with open(path, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=CSV_COLUMNS)
        w.writeheader()
        w.writerows(deduped)
    print(f"\nWrote {len(deduped)} hospitals ({len(districts)} districts) -> {path}",
          file=sys.stderr)
    print("Next: python3 etl/verify_facilities.py", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
