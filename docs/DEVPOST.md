# Jevan Rekha — Lifeline

> Ask in your own language — type or speak _"पटना के पास डायलिसिस"_ — and get an evidence-attached, distance-ranked shortlist of verified health facilities, answered back in the same language.

![Runtime dataflow and safety checks](dataflow.svg)

---

## 💡 Inspiration

In India, the hardest part of getting care often isn't the treatment — it's **finding the right place to get it**. A family in rural Bihar whose relative needs **dialysis**, **cancer surgery**, or a **NICU bed** has no reliable way to know which nearby facility actually offers that service, whether it's public or private, whether it's covered under **PMJAY**, or how far it really is. The information is scattered across thousands of facility listings, much of it stale, mislabeled, or plotted at the wrong coordinates.

The result is **wrong referrals**: patients travel hours to a hospital that can't help them, lose precious time in an emergency, or get steered to an expensive private clinic when a free public one is closer. For a kidney patient who needs dialysis twice a week, a wrong turn isn't an inconvenience — it can be fatal.

We also knew that **language** is a wall. Most digital health tools assume English. A grandmother who speaks only Bhojpuri or Tamil can't use them. We wanted a tool that meets people **where they are** — in their language, by voice if needed — and gives them an answer they can act on and trust.

So we built **Jevan Rekha — Lifeline** (_jeevan rekha_ = "lifeline"): a multilingual, conversational AI agent that turns "I need X care near me" into a trustworthy, explainable shortlist of real facilities.

## 🩺 What it does

- **🗣️ Conversational, multi-turn** — chat with follow-ups ("what about Jaipur?", "only public ones?"); each turn keeps context.
- **🌐 Any Indian language, in and out** — type or **speak** in Hindi, Bengali, Tamil, Marathi, Telugu, romanized, or code-mixed; results come back in the **same language**. Facility names, phones, and links stay literal.
- **🎯 Semantic match, not keyword match** — _"renal replacement therapy"_ finds a hospital whose page says _"dialysis unit"_; _"open heart bypass"_ surfaces _"CABG"_.
- **📍 Precise "near me"** — device **GPS → 6-digit PIN → city**, with distances from _your_ spot, not a city centroid.
- **✅ Evidence on every card** — each result cites _why_ it matched (the specific procedure/capability), so a recommendation is never a black box.
- **🛡️ Healthcare guardrails** — emergency escalation (**112 / 108**), a relevance floor, a medical disclaimer, and graceful degradation.
- **🏥 Registry verification** — an entity-resolution pipeline matches facilities to **PMJAY / HFR / NABH** registries and shows a **Verified** badge. It ingests real official data — all 22 districts of the Govt. of Haryana AB-PMJAY portal (**1,329 hospitals**) plus a Patna/Jaipur seed — verifying **89 facilities** today, and scales state-by-state from there.
- **🔒 Privacy by design** — pseudonymized identity, 90-day retention, consent notice.
- **💰 Live cost dashboard** — measured from real Model Serving token usage.

## 🏗️ How we built it

The whole thing runs on **Databricks** — no external infrastructure, no extra API keys.

- **Databricks Apps (AppKit / TypeScript)** — a single React + Node app, deployed as a Databricks Asset Bundle.
- **Lakebase (Autoscaling Postgres 17 + `pgvector`)** — the OLTP store *and* the vector index, in one place.
- **Databricks Model Serving** — two foundation models: `databricks-gte-large-en` for **embeddings** and `databricks-meta-llama-3-3-70b-instruct` for **translation and intent extraction**.
- **Unity Catalog** — the bronze lakehouse source (~10k real facilities) and the long-term conversation archive.
- **Browser Web Speech API** — voice in/out, entirely client-side (zero serving cost).

**The retrieval core stays English; multilingual support wraps it** — *translate in → search in English → translate out*. This keeps a single English vector space (no re-embedding, no extra storage) and adds at most two LLM round-trips, only when the input isn't English.

The runtime pipeline (see diagram), with a **safety/data-quality check gating each stage**:

1. **Translate-in + extract intent** (Llama 3.3 70B) → `{ need, place, lang }`. ⟶ 🚨 *Emergency intent surfaces 112/108 first.*
2. **Resolve origin** — GPS → PIN → city, geocoded from the **median of validated facilities**. ⟶ 📍 *Coordinate-validation filter.*
3. **Embed the need** — `gte-large-en`, 1024-d.
4. **Semantic + geo search** — `pgvector` cosine distance blended with a Haversine radius in one SQL function. ⟶ 📉 *Relevance floor.*
5. **Rank, attach evidence, verify** — score blend + `pg_trgm` query-relevant evidence. ⟶ 🔍 *Evidence grounding* + 🏥 *Registry verification.*
6. **Localize-out** (Llama 3.3 70B) — summary and evidence translated back; names stay literal.

Scoring blends meaning, proximity, and capacity:

$$ \text{score} = 0.60\cdot\text{sim} + 0.25\cdot\text{proximity} + 0.10\cdot\text{beds} + 0.05\cdot\text{doctors} $$

where similarity is cosine over the embeddings, \\( \text{sim} = 1 - \cos\_\text{dist} \\).

Offline, a **Databricks ETL** (`load_from_uc → embed_facilities → validate_coordinates`) builds the `referral.*` tables and `facility_vec` from Unity Catalog bronze.

## 🧗 Challenges we ran into

- **Wrong coordinates.** ~8% of source facilities were plotted in the wrong place — a "Noida" hospital landing 500 km away, a Patna site showing "3.9 km" when it was nowhere near. We built a **bronze → silver coordinate-validation pipeline**: stage 1 checks each point is inside India and within 80 km of the robust median of its own city; stage 2 (optional) geocodes the address via OpenStreetMap and requires a ≤15 km match. The `geo_valid` flag is what search filters on — bad points never appear, and they're excluded from origin geocoding too.
- **The pincode directory lied.** The India-Post PIN directory had thousands of centroids in the wrong state (PIN 201301 → "Agartala"). We **dropped it entirely** and geocode from the median of *validated* facilities instead.
- **Suspicious evidence.** An early trigram fallback once cited "cleft lip repairs" as evidence for a dialysis query. We added a **suspect-evidence filter** (dental/eye/diagnostic clinics can't claim transplants) and **LLM-grounding** for weak matches, with honest `listed` vs `weak` confidence labels.
- **A 512 MB free-tier Lakebase cap.** We kept the schema lean — dropping the old lexical full-text matview and trigram indexes on every deploy — and skipped an HNSW index (a sequential cosine scan over ~10k vectors is still sub-100 ms). Current footprint ≈ 336 MB.
- **Serverless warehouse disabled.** The workspace had serverless SQL turned off, so we re-engineered every ETL step to be **Lakebase-native** (median/percentile SQL, no warehouse dependency).
- **Multilingual without exploding storage.** Re-embedding per language would have multiplied the vector DB. The *translate-in / search-English / translate-out* wrapper avoided that completely.

## 📚 What we learned

- **A vector index belongs next to your OLTP, not in a separate service.** Putting `pgvector` *inside* Lakebase meant geo-filtering, semantic ranking, and evidence all happened in a single SQL round-trip — simpler and faster than a dedicated vector DB.
- **For health data, trust is a feature, not a footnote.** Evidence citations, registry verification, coordinate validation, and emergency escalation did more for credibility than any accuracy bump.
- **Translation as a thin wrapper** around an English core is a surprisingly powerful pattern — it gave us six-plus languages for the cost of two LLM calls and zero extra storage.
- **Wrong data hurts more than missing data.** Showing a confidently-wrong "3.9 km" was worse than showing nothing; the validation layer became the most important part of the system.

## 🚀 What's next

- Full OpenStreetMap validation sweep across all 10k facilities.
- Bulk **PMJAY/HFR** ingestion and procedure-level verification (cross-check the *cited service* against the registry's verified services).
- **MLflow tracing** for span-level LLM observability, plus rate limiting and cost caps.
- Outbound **WhatsApp** referral hand-off for community health workers.

---

## 🛠️ Built with

`databricks` · `databricks-apps` · `appkit` · `typescript` · `react` · `vite` · `node.js` · `express` · `lakebase` · `postgresql` · `pgvector` · `pg_trgm` · `databricks-model-serving` · `gte-large-en` · `llama-3.3-70b` · `unity-catalog` · `web-speech-api` · `leaflet` · `openstreetmap` · `zod` · `databricks-asset-bundles`

## 🔗 Try it out

- **Live app:** https://referral-copilot-2662815623088807.aws.databricksapps.com
- **Code:** https://github.com/akshaybhan32/referral-copilot
