# Referral Copilot

**Ask in your own language — type or speak _"पटना के पास डायलिसिस"_ — and get an evidence-attached shortlist of candidate health facilities, answered back in the same language.**

A Databricks hackathon app for social good: helping clinicians and patients in India find the right facility for a specific need, fast — in whatever language they speak. Built on **Databricks Apps** (AppKit / TypeScript), **Lakebase** (Postgres + pgvector), and **Databricks Model Serving** (foundation-model embeddings + a chat LLM for translation), over ~10k real facilities from the Unity Catalog lakehouse.

🔗 **Live app:** https://referral-copilot-2662815623088807.aws.databricksapps.com

---

## Why it works

Lexical search misses the way care needs are actually phrased. Someone searching _"renal replacement therapy"_ should still find a hospital whose page says _"dialysis unit"_; _"open heart bypass"_ should surface _"CABG"_. Referral Copilot embeds the query and every facility with a foundation model and matches on **meaning**, then re-ranks by **proximity** and capacity, and attaches **evidence** — the specific procedures/capabilities that matched — so every recommendation is explainable.

```
"dialysis near Patna"
  → Patna Dialysis Centre · 0.9 km · sim 0.682 · "Performs dialysis treatment"
  → IGIMS                · 3.9 km · sim 0.472 · "Dialysis is provided at the IGIMS Dialysis Unit"

"open heart bypass surgery near New Delhi"
  → Delhi Heart & Lungs Institute · 5.0 km · "Cardiac surgery • Open-heart surgeries"
  → SSB Heart & Multispeciality   · 14.9 km · "Complex bypass surgery (CABG) • Coronary bypass"
```

## Architecture

```
 Browser                Databricks App (AppKit / Node + React)            Databricks platform
┌─────────┐   /ask     ┌───────────────────────────────────────┐
│🎤 / type │──────────► │ 1. translate-in + extract intent ─────┼──► chat LLM (Llama 3.3 70B)
│ any lang │            │ 2. geocode place ─────────────────────┼──► Lakebase (Postgres)
│         │            │ 3. embed need ────────────────────────┼──► Model Serving (gte-large-en)
│ results │ ◄───────── │ 4. search_facilities_vec(geo+cosine) ─┼──► Lakebase pgvector
│🔊 cards  │            │ 5. attach evidence (trgm)             │
│ in lang  │            │ 6. localize-out summary + evidence ───┼──► chat LLM
└─────────┘            └───────────────────────────────────────┘
                                                  ▲
 Unity Catalog bronze ──(ETL: etl/*.py)──► referral.* tables + facility_vec
```

### Multilingual — talk in your language

The retrieval core stays English; multilingual support wraps it: **translate in, search in English, translate out.**

1. **Translate-in + intent extraction** (one chat-LLM call): any language → `{ need, place, lang }` in English. Handles Devanagari (**डायलिसिस**), other Indian scripts, romanized ("Patna ke paas dialysis"), and code-mixed input. Pure-English `"<need> near <place>"` skips the LLM (fast path).
2. The **English pipeline runs unchanged** (geocode → embed → vector search → evidence).
3. **Localize-out** (one chat-LLM call): the summary and per-card evidence are translated back into the user's language; **facility names, phones, and URLs stay literal**. The detected English interpretation is echoed for confirmation ("understood as …").
4. **Voice** is browser-side (Web Speech API): mic for speech-to-text, read-aloud for text-to-speech — no serving endpoint, no cost.

This keeps a single English vector space (no re-embedding, no extra storage) and adds at most two LLM round-trips, only when the input isn't English.

- **Retrieval** is semantic: the query is embedded with `databricks-gte-large-en` (1024-d), matched against `referral.facility_vec` via pgvector cosine distance combined with a Haversine geo radius in a single SQL function (`referral.search_facilities_vec`). Results are scored `0.60·similarity + 0.25·proximity + 0.10·beds + 0.05·doctors`.
- **Evidence** is query-relevant: after ranking, the route picks the procedures/capabilities/specialties most similar to the need (via `pg_trgm`) so each card cites _why_ it matched.
- **Geocoding** uses our own data — the centroid of facilities in the named city (falling back to the India Post PIN district centroid), so a place resolves exactly when we have something to recommend there.

## Tech stack

| Layer | Tech |
|---|---|
| App | Databricks Apps, AppKit (`@databricks/appkit`), React + Vite, Express, Zod |
| OLTP + vectors | Lakebase Autoscaling Postgres 17, `pgvector`, `pg_trgm` |
| Embeddings | Databricks Model Serving — `databricks-gte-large-en` |
| Translation / localization | Databricks Model Serving — `databricks-meta-llama-3-3-70b-instruct` |
| Voice | Browser Web Speech API (STT + TTS), client-side |
| Data | Unity Catalog bronze tables, Serverless SQL warehouse, `psql \copy` ETL |
| Bundle | Databricks Asset Bundle (`databricks.yml`) |

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/referral/ask?q=&radius=` | Natural-language entry: `"<need> near <place>"` → parse, geocode, semantic search |
| `GET /api/referral/search?need=&lat=&lng=&radius=` | Semantic search with explicit coordinates |
| `GET /api/referral/facility/:id` | Full evidence for one facility (specialties, procedures, capabilities, sources) |
| `POST/GET /api/referral/shortlists`, `…/items`, `PATCH …/items/:id` | Save and triage candidate facilities |

## Project structure

```
client/                 React UI (NL search box, evidence cards, shortlist)
server/
  server.ts             AppKit app: lakebase() + serving() + server() plugins
  routes/referral/
    referral-routes.ts  /ask, /search, facility detail, shortlist CRUD
    schema.ts           Lakebase DDL (runs in onPluginsReady; SP owns the schema)
etl/
  load_from_uc.py       UC bronze → referral.* (psql \copy, TEXT format)
  embed_facilities.py   embed via ai_query → facility_vec + search_facilities_vec
databricks.yml          Asset Bundle: app + Lakebase + serving_endpoint resources
app.yaml                Runtime command + env injection (valueFrom resources)
```

## Local development

Prereqs: Node 20+, the [Databricks CLI](https://docs.databricks.com/dev-tools/cli/), `psql`, and a workspace profile (`databricks auth login --profile <name>`).

```bash
cp .env.example .env          # fill in host, Lakebase endpoint/host, serving endpoint
npm install
npm run dev                   # http://localhost:8000 (tsx watch)
# or run the production build:
npm run build && npm run start
```

Auth uses your CLI profile. If the app's SDK init can't pick up the profile token, start with an explicit token:

```bash
DATABRICKS_TOKEN=$(databricks auth token --profile <name> | python3 -c "import json,sys;print(json.load(sys.stdin)['access_token'])") npm run start
```

## Build the data (one time)

```bash
python3 etl/load_from_uc.py        # UC bronze → referral.* (~10k facilities)
python3 etl/embed_facilities.py    # embeddings → facility_vec + search function
```

## Deploy

```bash
databricks apps deploy --auto-approve   # build + typecheck + lint, deploy, run
```

The Service Principal owns the `referral` schema (deploy-first ownership), so `server/routes/referral/schema.ts` runs the DDL on startup. The bundle grants the SP `CAN_QUERY` on the serving endpoint and `CAN_CONNECT_AND_CREATE` on Lakebase.

## Data sources

Unity Catalog bronze (`dais_hackathon.bronze`):
- `bronze_facilities` — facility directory (name, type, capacity, specialties/procedures/capabilities, contact, coordinates)
- `bronze_india_post_pincode_directory` — PIN → district/state + centroids (geocoding fallback)
- `bronze_nfhs_5_district_health_indicators` — district health indicators (context)

## Implementation notes

- **512 MB free-trial Lakebase cap.** The schema is kept lean to fit: redundant tables and the older lexical full-text matview/trigram indexes are dropped on deploy (the Service Principal drops its own objects in `onPluginsReady`). Current footprint ≈ 336 MB.
- **No HNSW index** on the vectors — it didn't fit the cap, and a sequential cosine scan over ~10k vectors is sub-100 ms. Re-add `USING hnsw (embedding vector_cosine_ops)` on a larger tier for scale.
- **Two serving endpoints.** `embed` (`EMBED_ENDPOINT`) for query embeddings and `llm` (`LLM_ENDPOINT`) for translation, both injected from `serving_endpoint` bundle resources. `DATABRICKS_SERVING_ENDPOINT_NAME` is also set (to the embed endpoint) to satisfy the serving plugin's required default-endpoint check.
- **Translate-in / search-English / translate-out.** Multilingual support wraps the English retrieval core rather than replacing the embeddings, so the vector DB and ETL are unchanged.

---

Built with [Databricks AppKit](https://databricks.github.io/appkit/).
