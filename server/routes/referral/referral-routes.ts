import { z } from 'zod';
import { Application, Request } from 'express';
import { setupReferralSchema } from './schema';

// AppKit's serving invoke() is typed as returning the unwrapped response, but at
// runtime it returns an ExecutionResult ({ ok, data }). We type serving loosely
// (Promise<unknown>, method syntax) so the real appkit is structurally assignable
// without a cast, and narrow each result to ExecResult at the call site.
type ExecResult = { ok: true; data: unknown } | { ok: false; status: number; message: string };

export interface AppKitWithLakebase {
  lakebase: { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
  serving(alias: string): { invoke(body: Record<string, unknown>): Promise<unknown> };
  server: { extend(fn: (app: Application) => void): void };
}

const userOf = (req: Request) => req.header('x-forwarded-email') ?? 'local-dev';

const SearchQuery = z.object({
  need: z.string().min(1),
  lat: z.coerce.number(),
  lng: z.coerce.number(),
  radius: z.coerce.number().min(1).max(500).default(50),
  type: z.string().optional(),
  operator: z.string().optional(),
  limit: z.coerce.number().min(1).max(50).default(20),
});

interface SearchParams {
  need: string;
  lat: number;
  lng: number;
  radius: number;
  type?: string;
  operator?: string;
  limit: number;
}

// Embed query text with databricks-gte-large-en -> a pgvector literal '[..]'.
async function embedQuery(appkit: AppKitWithLakebase, text: string): Promise<string> {
  const r = (await appkit.serving('embed').invoke({ input: text })) as ExecResult;
  if (!r.ok) throw new Error(`embed failed: ${r.message}`);
  const data = r.data as { data?: Array<{ embedding?: number[] }> };
  const emb = data.data?.[0]?.embedding;
  if (!emb || emb.length === 0) throw new Error('embed returned no vector');
  return `[${emb.join(',')}]`;
}

type ChatMsg = { role: 'system' | 'user'; content: string };

// One chat-LLM call -> trimmed text content.
async function chat(appkit: AppKitWithLakebase, messages: ChatMsg[], maxTokens = 200): Promise<string> {
  const r = (await appkit.serving('llm').invoke({ messages, temperature: 0, max_tokens: maxTokens })) as ExecResult;
  if (!r.ok) throw new Error(`llm failed: ${r.message}`);
  const data = r.data as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content?.trim() ?? '';
}

// Pull the first {...} object out of an LLM response (tolerates ```json fences / prose).
function extractJson<T>(s: string): T {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON in LLM output');
  return JSON.parse(m[0]) as T;
}

const SYS_PARSE = `You convert a patient's health-facility search query (in ANY language) into JSON.
Output ONLY compact JSON: {"need":"<care need in English>","place":"<city/place name in English>","lang":"<ISO 639-1 code of the input language>"}.
Translate and transliterate place names to their common English spelling. If no place is mentioned, use "" for place. No prose, no markdown.`;

// Translate-in + intent extraction. English "<need> near <place>" skips the LLM.
async function parseIntent(
  appkit: AppKitWithLakebase,
  q: string,
): Promise<{ need: string; place: string; lang: string }> {
  const ascii = [...q].every((c) => c.charCodeAt(0) < 128);
  const m = q.match(/^\s*(.+?)\s+near\s+(.+?)\s*$/i);
  if (ascii && m) return { need: m[1].trim(), place: m[2].trim(), lang: 'en' };
  const content = await chat(appkit, [
    { role: 'system', content: SYS_PARSE },
    { role: 'user', content: q },
  ], 120);
  const j = extractJson<{ need?: string; place?: string; lang?: string }>(content);
  return {
    need: String(j.need ?? '').trim(),
    place: String(j.place ?? '').trim(),
    lang: (String(j.lang ?? 'en').trim() || 'en').toLowerCase().slice(0, 2),
  };
}

const SYS_LOCALIZE = `Translate the string values of the given JSON into the language given as "target=<ISO code>".
Keep proper nouns (hospital names, place names) and all numbers unchanged. Output ONLY the same JSON shape, nothing else.`;

// Localize-out: translate the summary + per-card evidence in one call. Best-effort
// (falls back to English on any failure). Facility names/phones/URLs are never sent here.
async function localize(
  appkit: AppKitWithLakebase,
  summary: string,
  reasons: string[],
  lang: string,
): Promise<{ summary: string; reasons: string[] }> {
  if (lang === 'en' || (!summary && reasons.length === 0)) return { summary, reasons };
  try {
    const content = await chat(
      appkit,
      [
        { role: 'system', content: SYS_LOCALIZE },
        { role: 'user', content: `target=${lang}  ${JSON.stringify({ summary, reasons })}` },
      ],
      300 + reasons.length * 80, // Devanagari is token-heavy; budget per reason so JSON isn't truncated
    );
    const j = extractJson<{ summary?: string; reasons?: unknown[] }>(content);
    const tr = Array.isArray(j.reasons) ? j.reasons : [];
    // Index-wise with per-item fallback (don't lose everything if one is missing/truncated).
    return {
      summary: typeof j.summary === 'string' && j.summary ? j.summary : summary,
      reasons: reasons.map((en, i) => (typeof tr[i] === 'string' && tr[i] ? String(tr[i]) : en)),
    };
  } catch {
    return { summary, reasons };
  }
}

// ISO 639-1 -> BCP-47 hint the client can hand to speech synthesis.
const SPEECH_LOCALE: Record<string, string> = {
  hi: 'hi-IN', bn: 'bn-IN', ta: 'ta-IN', te: 'te-IN', mr: 'mr-IN',
  gu: 'gu-IN', kn: 'kn-IN', ml: 'ml-IN', pa: 'pa-IN', ur: 'ur-IN', en: 'en-IN',
};

// One semantic search: geo radius + cosine similarity (search_facilities_vec),
// then attach query-RELEVANT evidence (procedures/capabilities/specialties most
// similar to the care need via pg_trgm) so each card cites why it matched.
async function semanticSearch(appkit: AppKitWithLakebase, p: SearchParams) {
  const vec = await embedQuery(appkit, p.need);
  const { rows } = await appkit.lakebase.query(
    'SELECT * FROM referral.search_facilities_vec($1::vector,$2,$3,$4,$5,$6,$7)',
    [vec, p.lat, p.lng, p.radius, p.type ?? null, p.operator ?? null, p.limit],
  );
  if (rows.length === 0) return rows;

  const ids = rows.map((r) => r.facility_id as string);
  const ev = await appkit.lakebase.query(
    `SELECT facility_id, string_agg(txt, ' • ' ORDER BY s DESC) AS reason FROM (
       SELECT facility_id, txt, s,
              row_number() OVER (PARTITION BY facility_id ORDER BY s DESC) rn FROM (
         SELECT facility_id, procedure  AS txt, similarity(procedure,  $1) s FROM referral.facility_procedure  WHERE facility_id = ANY($2)
         UNION ALL
         SELECT facility_id, capability AS txt, similarity(capability, $1) s FROM referral.facility_capability WHERE facility_id = ANY($2)
         UNION ALL
         SELECT facility_id, specialty  AS txt, similarity(specialty,  $1) s FROM referral.facility_specialty  WHERE facility_id = ANY($2)
       ) u WHERE s > 0.12
     ) r WHERE rn <= 3 GROUP BY facility_id`,
    [p.need, ids],
  );
  const reasonOf = new Map(ev.rows.map((r) => [r.facility_id as string, r.reason as string]));
  // Prefer query-relevant evidence; fall back to the function's generic reason.
  return rows.map((r) => ({ ...r, match_reason: reasonOf.get(r.facility_id as string) ?? r.match_reason }));
}

// Geocode a place name from our own data: average the coords of facilities in
// that city (robust — resolves exactly when we have facilities to recommend),
// falling back to the PIN district centroid.
async function geocode(appkit: AppKitWithLakebase, place: string) {
  const c = await appkit.lakebase.query(
    `SELECT avg(lat) lat, avg(lng) lng, count(*) n
       FROM referral.facility WHERE lower(city)=lower($1) AND lat IS NOT NULL`,
    [place],
  );
  if (Number(c.rows[0]?.n ?? 0) > 0) {
    return { lat: Number(c.rows[0].lat), lng: Number(c.rows[0].lng) };
  }
  const d = await appkit.lakebase.query(
    `SELECT centroid_lat lat, centroid_lng lng FROM referral.pin_geo
      WHERE lower(primary_district)=lower($1) AND centroid_lat IS NOT NULL LIMIT 1`,
    [place],
  );
  if (d.rows.length) return { lat: Number(d.rows[0].lat), lng: Number(d.rows[0].lng) };
  return null;
}

export async function setupReferralRoutes(appkit: AppKitWithLakebase): Promise<void> {
  await setupReferralSchema(appkit);

  appkit.server.extend((app) => {
    // --- Core retrieval: care-need + location -> evidence-attached shortlist ---
    app.get('/api/referral/search', async (req, res) => {
      const parsed = SearchQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'need, lat, lng required', detail: parsed.error.flatten() });
        return;
      }
      const { need, lat, lng, radius, type, operator, limit } = parsed.data;
      try {
        const rows = await semanticSearch(appkit, { need, lat, lng, radius, type, operator, limit });
        // best-effort session log (does not block results)
        appkit.lakebase
          .query(
            `INSERT INTO referral.search_session
               (user_id, raw_query, parsed_care_need, parsed_lat, parsed_lng, radius_km, result_count)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [userOf(req), `${need} near (${lat},${lng})`, need, lat, lng, radius, rows.length],
          )
          .catch(() => undefined);
        res.json({ count: rows.length, results: rows });
      } catch (err) {
        console.error('[referral] search failed:', err);
        res.status(500).json({ error: 'search failed' });
      }
    });

    // --- Natural-language entry point: "dialysis near Patna" ---
    // Splits "<care need> near <place>", geocodes the place from our data, then
    // runs the same semantic search. This is the box the UI talks to.
    app.get('/api/referral/ask', async (req, res) => {
      const parsed = z
        .object({
          q: z.string().min(1),
          radius: z.coerce.number().min(1).max(500).default(50),
          type: z.string().optional(),
          operator: z.string().optional(),
          limit: z.coerce.number().min(1).max(50).default(20),
        })
        .safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'q required' });
        return;
      }
      const { q, radius, type, operator, limit } = parsed.data;
      try {
        // 1. Translate-in + intent extraction (any language -> English need/place).
        const { need, place, lang } = await parseIntent(appkit, q);
        const speechLocale = SPEECH_LOCALE[lang] ?? `${lang}-IN`;
        if (!need || !place) {
          res.status(400).json({
            error: "Tell me a care need and a place, e.g. 'dialysis near Patna' / 'पटना के पास डायलिसिस'.",
            need, place, lang,
          });
          return;
        }
        // 2. Geocode (English place) + semantic search (existing English pipeline).
        const loc = await geocode(appkit, place);
        if (!loc) {
          res.status(404).json({ error: `Couldn't find "${place}". Try a nearby city.`, need, place, lang });
          return;
        }
        const rows = await semanticSearch(appkit, { need, lat: loc.lat, lng: loc.lng, radius, type, operator, limit });

        // 3. Localize-out: translate the summary + per-card evidence into the input language.
        const summaryEn = rows.length
          ? `${rows.length} ${rows.length === 1 ? 'facility' : 'facilities'} found for ${need} near ${place}.`
          : `No facilities found for ${need} near ${place}.`;
        const reasonsEn = rows.map((r) => (typeof r.match_reason === 'string' ? r.match_reason : ''));
        const localized = await localize(appkit, summaryEn, reasonsEn, lang);
        const results = rows.map((r, i) => ({
          ...r,
          match_reason: localized.reasons[i] ?? r.match_reason,
          match_reason_en: r.match_reason,
        }));

        appkit.lakebase
          .query(
            `INSERT INTO referral.search_session
               (user_id, raw_query, parsed_care_need, parsed_location, parsed_lat, parsed_lng, radius_km, result_count)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [userOf(req), q, need, place, loc.lat, loc.lng, radius, rows.length],
          )
          .catch(() => undefined);

        res.json({
          need, place, lang, speechLocale,
          interpretation: `${need} near ${place}`,
          summary: localized.summary,
          lat: loc.lat, lng: loc.lng,
          count: results.length, results,
        });
      } catch (err) {
        console.error('[referral] ask failed:', err);
        res.status(500).json({ error: 'search failed' });
      }
    });

    // --- Full evidence for one facility (cards "expand") ---
    app.get('/api/referral/facility/:id', async (req, res) => {
      const id = req.params.id;
      try {
        const [fac, spec, proc, cap, src, phone] = await Promise.all([
          appkit.lakebase.query('SELECT * FROM referral.facility WHERE facility_id=$1', [id]),
          appkit.lakebase.query('SELECT specialty FROM referral.facility_specialty WHERE facility_id=$1', [id]),
          appkit.lakebase.query('SELECT procedure FROM referral.facility_procedure WHERE facility_id=$1', [id]),
          appkit.lakebase.query('SELECT capability FROM referral.facility_capability WHERE facility_id=$1', [id]),
          appkit.lakebase.query('SELECT source_url FROM referral.facility_source_url WHERE facility_id=$1', [id]),
          appkit.lakebase.query('SELECT phone, is_official FROM referral.facility_phone WHERE facility_id=$1', [id]),
        ]);
        if (fac.rows.length === 0) {
          res.status(404).json({ error: 'facility not found' });
          return;
        }
        res.json({
          ...fac.rows[0],
          specialties: spec.rows.map((r) => r.specialty),
          procedures: proc.rows.map((r) => r.procedure),
          capabilities: cap.rows.map((r) => r.capability),
          source_urls: src.rows.map((r) => r.source_url),
          phones: phone.rows,
        });
      } catch (err) {
        console.error('[referral] facility detail failed:', err);
        res.status(500).json({ error: 'facility detail failed' });
      }
    });

    // --- Shortlists (the OLTP write path) ---
    app.post('/api/referral/shortlists', async (req, res) => {
      const body = z.object({ title: z.string().min(1) }).safeParse(req.body);
      if (!body.success) { res.status(400).json({ error: 'title required' }); return; }
      try {
        const { rows } = await appkit.lakebase.query(
          'INSERT INTO referral.shortlist (user_id, title) VALUES ($1,$2) RETURNING *',
          [userOf(req), body.data.title],
        );
        res.status(201).json(rows[0]);
      } catch (err) {
        console.error('[referral] create shortlist failed:', err);
        res.status(500).json({ error: 'create shortlist failed' });
      }
    });

    app.get('/api/referral/shortlists', async (req, res) => {
      try {
        const { rows } = await appkit.lakebase.query(
          'SELECT * FROM referral.shortlist WHERE user_id=$1 ORDER BY created_at DESC',
          [userOf(req)],
        );
        res.json(rows);
      } catch (err) {
        console.error('[referral] list shortlists failed:', err);
        res.status(500).json({ error: 'list shortlists failed' });
      }
    });

    app.post('/api/referral/shortlists/:id/items', async (req, res) => {
      const body = z.object({
        facility_id: z.string().min(1),
        rank: z.number().optional(),
        distance_km: z.number().optional(),
        score: z.number().optional(),
        match_reason: z.string().optional(),
      }).safeParse(req.body);
      if (!body.success) { res.status(400).json({ error: 'facility_id required' }); return; }
      const b = body.data;
      try {
        const { rows } = await appkit.lakebase.query(
          `INSERT INTO referral.shortlist_item (shortlist_id, facility_id, rank, distance_km, score, match_reason)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (shortlist_id, facility_id) DO UPDATE SET rank=EXCLUDED.rank
           RETURNING *`,
          [req.params.id, b.facility_id, b.rank ?? null, b.distance_km ?? null, b.score ?? null, b.match_reason ?? null],
        );
        res.status(201).json(rows[0]);
      } catch (err) {
        console.error('[referral] add item failed:', err);
        res.status(500).json({ error: 'add item failed' });
      }
    });

    app.get('/api/referral/shortlists/:id/items', async (req, res) => {
      try {
        const { rows } = await appkit.lakebase.query(
          `SELECT i.*, f.name, f.city, f.state, f.official_phone
             FROM referral.shortlist_item i
             JOIN referral.facility f ON f.facility_id = i.facility_id
            WHERE i.shortlist_id=$1 ORDER BY i.rank NULLS LAST, i.added_at`,
          [req.params.id],
        );
        res.json(rows);
      } catch (err) {
        console.error('[referral] list items failed:', err);
        res.status(500).json({ error: 'list items failed' });
      }
    });

    app.patch('/api/referral/shortlists/:id/items/:facilityId', async (req, res) => {
      const body = z.object({
        status: z.enum(['candidate', 'contacted', 'referred', 'rejected']).optional(),
        note: z.string().optional(),
      }).safeParse(req.body);
      if (!body.success) { res.status(400).json({ error: 'invalid update' }); return; }
      try {
        const { rows } = await appkit.lakebase.query(
          `UPDATE referral.shortlist_item
              SET status = COALESCE($3, status), note = COALESCE($4, note)
            WHERE shortlist_id=$1 AND facility_id=$2 RETURNING *`,
          [req.params.id, req.params.facilityId, body.data.status ?? null, body.data.note ?? null],
        );
        if (rows.length === 0) { res.status(404).json({ error: 'item not found' }); return; }
        res.json(rows[0]);
      } catch (err) {
        console.error('[referral] update item failed:', err);
        res.status(500).json({ error: 'update item failed' });
      }
    });
  });
}
