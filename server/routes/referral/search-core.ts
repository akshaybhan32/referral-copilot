// Shared retrieval core: serving (embed + chat LLM), multilingual intent parsing,
// localization, geocoding, and the semantic search itself. Used by both the
// single-shot search routes and the multi-turn conversation routes.
import { Application } from 'express';

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

export interface SearchParams {
  need: string;
  lat: number;
  lng: number;
  radius: number;
  type?: string;
  operator?: string;
  limit: number;
}

// Below this cosine similarity a facility is not topically relevant to the need
// (e.g. a cleft-lip clinic surfacing for "dialysis") — drop it from results.
export const MIN_SIMILARITY = 0.4;

// Emergency intent → the right response is "call an ambulance NOW", not a search.
const EMERGENCY_EN = /\b(emergency|heart attack|cardiac arrest|chest pain|stroke|unconscious|not breathing|can'?t breathe|difficulty breathing|severe bleeding|bleeding heavily|haemorrhage|hemorrhage|accident|trauma|seizure|convulsion|overdose|poisoning|snake ?bite|choking|drowning)\b/i;
const EMERGENCY_OTHER = /(दिल का दौरा|दौरा पड़|साँस नहीं|सांस नहीं|बेहोश|खून बह|दुर्घटना|आपातकाल|হার্ট অ্যাটাক|അത്യാഹിതം|saans nahi|behosh|dil ka daura)/i;

export function isEmergency(text: string): boolean {
  return EMERGENCY_EN.test(text) || EMERGENCY_OTHER.test(text);
}

// Best-effort token-usage log (fire-and-forget; never blocks or fails the request).
function recordUsage(appkit: AppKitWithLakebase, kind: 'embed' | 'llm', endpoint: string, tokens: number): void {
  appkit.lakebase
    .query('INSERT INTO referral.usage_event (kind, endpoint, tokens) VALUES ($1,$2,$3)', [kind, endpoint, tokens])
    .catch(() => undefined);
}

// Embed query text with databricks-gte-large-en -> a pgvector literal '[..]'.
export async function embedQuery(appkit: AppKitWithLakebase, text: string): Promise<string> {
  const r = (await appkit.serving('embed').invoke({ input: text })) as ExecResult;
  if (!r.ok) throw new Error(`embed failed: ${r.message}`);
  const data = r.data as { data?: Array<{ embedding?: number[] }>; usage?: { total_tokens?: number } };
  recordUsage(appkit, 'embed', process.env.EMBED_ENDPOINT ?? 'embed', data.usage?.total_tokens ?? 0);
  const emb = data.data?.[0]?.embedding;
  if (!emb || emb.length === 0) throw new Error('embed returned no vector');
  return `[${emb.join(',')}]`;
}

type ChatMsg = { role: 'system' | 'user'; content: string };

// One chat-LLM call -> trimmed text content.
export async function chat(appkit: AppKitWithLakebase, messages: ChatMsg[], maxTokens = 200): Promise<string> {
  const r = (await appkit.serving('llm').invoke({ messages, temperature: 0, max_tokens: maxTokens })) as ExecResult;
  if (!r.ok) throw new Error(`llm failed: ${r.message}`);
  const data = r.data as { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } };
  recordUsage(appkit, 'llm', process.env.LLM_ENDPOINT ?? 'llm', data.usage?.total_tokens ?? 0);
  return data.choices?.[0]?.message?.content?.trim() ?? '';
}

// Pull the first {...} object out of an LLM response (tolerates ```json fences / prose).
function extractJson<T>(s: string): T {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON in LLM output');
  return JSON.parse(m[0]) as T;
}

const SYS_PARSE = `You convert a patient's health-facility search message (in ANY language) into JSON.
Output ONLY compact JSON: {"need":"<care need in English>","place":"<city/place name in English>","lang":"<ISO 639-1 code of the input language>"}.
Translate and transliterate place names to their common English spelling.
You may be given the PREVIOUS need/place as context — if the new message omits the need or the place (e.g. "what about Jaipur?" or "any cheaper options?"), inherit the missing value from the context.
If no place is known, use "" for place. No prose, no markdown.`;

// Translate-in + intent extraction. Pure-English "<need> near <place>" with no
// conversation context skips the LLM; follow-ups always use the LLM so references
// ("what about Jaipur?") resolve against the prior turn.
export async function parseIntent(
  appkit: AppKitWithLakebase,
  q: string,
  ctx?: { need?: string; place?: string },
): Promise<{ need: string; place: string; lang: string }> {
  const ascii = [...q].every((c) => c.charCodeAt(0) < 128);
  const m = q.match(/^\s*(.+?)\s+near\s+(.+?)\s*$/i);
  if (!ctx && ascii && m) return { need: m[1].trim(), place: m[2].trim(), lang: 'en' };
  // Only inherit a previous place that's an actual name — never a PIN/number,
  // which the model would otherwise try to "fix" into a random city.
  const ctxPlace = ctx?.place && !/^\d+$/.test(ctx.place.trim()) ? ctx.place : '';
  const ctxLine = ctx ? `Context: previous need="${ctx.need ?? ''}", previous place="${ctxPlace}".\n` : '';
  try {
    const content = await chat(appkit, [
      { role: 'system', content: SYS_PARSE },
      { role: 'user', content: `${ctxLine}Message: ${q}` },
    ], 120);
    const j = extractJson<{ need?: string; place?: string; lang?: string }>(content);
    return {
      need: String(j.need ?? '').trim().slice(0, 120),
      place: String(j.place ?? '').trim().slice(0, 80),
      lang: (String(j.lang ?? 'en').trim() || 'en').toLowerCase().slice(0, 2),
    };
  } catch {
    // Graceful degradation: if the LLM is down/rate-limited, fall back to the
    // English regex, else treat the whole text as the need (place comes from ctx).
    if (m) return { need: m[1].trim(), place: m[2].trim(), lang: 'en' };
    return { need: q.trim().slice(0, 120), place: ctxPlace, lang: 'en' };
  }
}

const SYS_LOCALIZE = `Translate the string values of the given JSON into the language given as "target=<ISO code>".
Keep proper nouns (hospital names, place names) and all numbers unchanged. Output ONLY the same JSON shape, nothing else.`;

// Localize-out: translate the summary + per-card evidence in one call. Best-effort
// (falls back to English on any failure). Facility names/phones/URLs are never sent here.
export async function localize(
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
    return {
      summary: typeof j.summary === 'string' && j.summary ? j.summary : summary,
      reasons: reasons.map((en, i) => (typeof tr[i] === 'string' && tr[i] ? String(tr[i]) : en)),
    };
  } catch {
    return { summary, reasons };
  }
}

// ISO 639-1 -> BCP-47 hint the client can hand to speech synthesis.
export const SPEECH_LOCALE: Record<string, string> = {
  hi: 'hi-IN', bn: 'bn-IN', ta: 'ta-IN', te: 'te-IN', mr: 'mr-IN',
  gu: 'gu-IN', kn: 'kn-IN', ml: 'ml-IN', pa: 'pa-IN', ur: 'ur-IN', en: 'en-IN',
};

// Evidence implausible for the facility's apparent type (a dental/eye/diagnostic
// clinic can't be doing transplants) — scraped-aggregator noise. Never cited.
// `f` = referral.facility, `txt` = the candidate evidence term.
const SUSPECT_EVIDENCE = `NOT (
  (f.name ILIKE '%dental%' OR f.name ILIKE '%eye%' OR f.name ILIKE '%ophthal%'
   OR f.name ILIKE '%diagnostic%' OR f.name ILIKE '%pathology%' OR f.name ILIKE '%physiother%')
  AND (txt ILIKE '%bypass%' OR txt ILIKE '%transplant%' OR txt ILIKE '%open heart%'
   OR txt ILIKE '%neurosurg%' OR txt ILIKE '%cardiac surg%' OR txt ILIKE '%cancer surg%'))`;

const SYS_GROUND = `You check which of a facility's listed medical services genuinely support a patient's stated need.
For each facility id, return ONLY the listed services (verbatim from the input) that clearly support the need.
Be strict: if none clearly support it, return an empty array — do not include loosely-related services.
Output ONLY compact JSON: {"<facility_id>": ["service", ...], ...}. No prose, no markdown.`;

// One semantic search: geo radius + cosine similarity (search_facilities_vec),
// then attach evidence for WHY each matched:
//   1. lexical (pg_trgm) evidence, excluding type-implausible (suspect) claims;
//   2. for facilities with no lexical match, an LLM grounds the citation against
//      the facility's listed services — or honestly says "no specific listing".
// Each result carries evidence_confidence: 'listed' (grounded) | 'weak' (no listing).
export async function semanticSearch(
  appkit: AppKitWithLakebase,
  p: SearchParams,
): Promise<Record<string, unknown>[]> {
  const vec = await embedQuery(appkit, p.need);
  // Over-fetch, then drop topically-irrelevant matches and keep the top `limit`,
  // so the relevance floor never silently shrinks a good result set.
  const fetched = await appkit.lakebase.query(
    'SELECT * FROM referral.search_facilities_vec($1::vector,$2,$3,$4,$5,$6,$7)',
    [vec, p.lat, p.lng, p.radius, p.type ?? null, p.operator ?? null, Math.min(50, p.limit * 3)],
  );
  const rows = fetched.rows
    .filter((r) => Number(r.similarity ?? 0) >= MIN_SIMILARITY)
    .slice(0, p.limit);
  if (rows.length === 0) return rows;

  const ids = rows.map((r) => r.facility_id as string);

  // 1) Lexical (trigram) evidence — implausible claims excluded at the source.
  const ev = await appkit.lakebase.query(
    `SELECT facility_id, string_agg(txt, ' • ' ORDER BY s DESC) AS reason FROM (
       SELECT facility_id, txt, s, row_number() OVER (PARTITION BY facility_id ORDER BY s DESC) rn FROM (
         SELECT u.facility_id, u.txt, u.s FROM (
           SELECT facility_id, procedure  AS txt, similarity(procedure,  $1) s FROM referral.facility_procedure  WHERE facility_id = ANY($2)
           UNION ALL
           SELECT facility_id, capability AS txt, similarity(capability, $1) s FROM referral.facility_capability WHERE facility_id = ANY($2)
           UNION ALL
           SELECT facility_id, specialty  AS txt, similarity(specialty,  $1) s FROM referral.facility_specialty  WHERE facility_id = ANY($2)
         ) u JOIN referral.facility f ON f.facility_id = u.facility_id
         WHERE u.s > 0.12 AND ${SUSPECT_EVIDENCE}
       ) q
     ) r WHERE rn <= 3 GROUP BY facility_id`,
    [p.need, ids],
  );
  const reasonOf = new Map(ev.rows.map((r) => [r.facility_id as string, r.reason as string]));

  // 2) Facilities with no lexical evidence → ground (or honestly disclaim) via LLM.
  const weakIds = ids.filter((id) => !reasonOf.has(id));
  const grounded = new Map<string, { reason: string; weak: boolean }>();
  if (weakIds.length > 0) {
    const cand = await appkit.lakebase.query(
      `SELECT facility_id, txt FROM (
         SELECT u.facility_id, u.txt, row_number() OVER (PARTITION BY u.facility_id ORDER BY length(u.txt)) rn FROM (
           SELECT DISTINCT facility_id, procedure  AS txt FROM referral.facility_procedure  WHERE facility_id = ANY($1)
           UNION SELECT DISTINCT facility_id, capability AS txt FROM referral.facility_capability WHERE facility_id = ANY($1)
           UNION SELECT DISTINCT facility_id, specialty  AS txt FROM referral.facility_specialty  WHERE facility_id = ANY($1)
         ) u JOIN referral.facility f ON f.facility_id = u.facility_id
         WHERE ${SUSPECT_EVIDENCE}
       ) r WHERE rn <= 12`,
      [weakIds],
    );
    const termsBy = new Map<string, string[]>();
    for (const c of cand.rows) {
      const id = c.facility_id as string;
      const list = termsBy.get(id) ?? [];
      list.push(String(c.txt));
      termsBy.set(id, list);
    }
    const noListing = `No specific “${p.need}” service is listed — matched on the facility's overall profile`;
    try {
      const content = await chat(
        appkit,
        [
          { role: 'system', content: SYS_GROUND },
          { role: 'user', content: `need="${p.need}"\n${JSON.stringify(Object.fromEntries(termsBy))}` },
        ],
        120 + weakIds.length * 60,
      );
      const j = extractJson<Record<string, unknown>>(content);
      for (const id of weakIds) {
        const sup = Array.isArray(j[id]) ? (j[id] as unknown[]).map((x) => String(x)).filter(Boolean) : [];
        grounded.set(id, sup.length ? { reason: sup.slice(0, 3).join(' • '), weak: false } : { reason: noListing, weak: true });
      }
    } catch {
      for (const id of weakIds) grounded.set(id, { reason: noListing, weak: true });
    }
  }

  // 3) Registry verification (PMJAY/HFR/NABH) — best-effort; the table is optional.
  let verOf = new Map<string, string>();
  try {
    const ver = await appkit.lakebase.query(
      `SELECT facility_id, source FROM referral.facility_verification WHERE facility_id = ANY($1) AND verified`,
      [ids],
    );
    verOf = new Map(ver.rows.map((r) => [r.facility_id as string, String(r.source)]));
  } catch {
    /* facility_verification not present yet — skip badges */
  }

  return rows.map((r) => {
    const id = r.facility_id as string;
    const lex = reasonOf.get(id);
    const g = grounded.get(id);
    const reason = lex ?? g?.reason ?? (typeof r.match_reason === 'string' ? r.match_reason : '');
    const confidence = lex || (g && !g.weak) ? 'listed' : 'weak';
    return {
      ...r,
      match_reason: reason,
      evidence_confidence: confidence,
      verified: verOf.has(id),
      verified_source: verOf.get(id) ?? null,
    };
  });
}

const INDIA = (lat: number, lng: number) => lat >= 6 && lat <= 37.6 && lng >= 68 && lng <= 97.6;

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = Math.PI / 180;
  const h =
    Math.sin(((bLat - aLat) * r) / 2) ** 2 +
    Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(((bLng - aLng) * r) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface Origin {
  lat: number;
  lng: number;
  label: string;
  precision: 'gps' | 'pin' | 'city';
}

// Resolve the search origin from the most precise signal available:
//   1. device GPS  (caller passed deviceLat/deviceLng) — but only when it's near
//      the named place (so "what about Jaipur?" from a Patna phone uses Jaipur),
//   2. a 6-digit PIN code in the message  -> pin_geo neighbourhood centroid,
//   3. the city centroid (geocode).
// Returns null if nothing resolves.
export async function resolveOrigin(
  appkit: AppKitWithLakebase,
  opts: { message: string; place: string; deviceLat?: number; deviceLng?: number },
): Promise<Origin | null> {
  // Place anchor: PIN (finer) beats city centroid. We geocode from our OWN
  // facilities' exact_spatial coords — the India-Post pincode directory is full
  // of bad coordinates (thousands of centroids land in the wrong state).
  let anchor: Origin | null = null;
  const pin = opts.message.match(/\b(\d{6})\b/)?.[1];
  if (pin) {
    const r = await appkit.lakebase.query(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY f.lat) lat,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY f.lng) lng, count(*) n
         FROM referral.facility f JOIN referral.facility_geo g
           ON g.facility_id=f.facility_id AND g.geo_valid
        WHERE f.pincode=$1 AND f.lat IS NOT NULL`,
      [pin],
    );
    if (Number(r.rows[0]?.n ?? 0) > 0) {
      anchor = { lat: Number(r.rows[0].lat), lng: Number(r.rows[0].lng), label: `PIN ${pin}`, precision: 'pin' };
    }
  }
  if (!anchor && opts.place) {
    const g = await geocode(appkit, opts.place);
    if (g) anchor = { lat: g.lat, lng: g.lng, label: opts.place, precision: 'city' };
  }

  // Device GPS: most precise — use it when it's within ~40 km of the anchor
  // (same city), or when there's no anchor at all ("clinics near me").
  if (opts.deviceLat != null && opts.deviceLng != null && INDIA(opts.deviceLat, opts.deviceLng)) {
    if (!anchor || haversineKm(opts.deviceLat, opts.deviceLng, anchor.lat, anchor.lng) <= 40) {
      return { lat: opts.deviceLat, lng: opts.deviceLng, label: 'your location', precision: 'gps' };
    }
  }
  return anchor;
}

// Geocode a place name from our own data: the centroid of facilities in that
// city. Resolves exactly when we have facilities to recommend, and avoids the
// unreliable India-Post pincode directory entirely.
export async function geocode(appkit: AppKitWithLakebase, place: string) {
  const c = await appkit.lakebase.query(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY f.lat) lat,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY f.lng) lng, count(*) n
       FROM referral.facility f JOIN referral.facility_geo g
         ON g.facility_id=f.facility_id AND g.geo_valid
      WHERE lower(f.city)=lower($1) AND f.lat IS NOT NULL`,
    [place],
  );
  if (Number(c.rows[0]?.n ?? 0) > 0) {
    return { lat: Number(c.rows[0].lat), lng: Number(c.rows[0].lng) };
  }
  return null;
}
