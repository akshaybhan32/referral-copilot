import { z } from 'zod';
import { setupReferralSchema } from './schema';
import {
  type AppKitWithLakebase,
  parseIntent,
  localize,
  semanticSearch,
  resolveOrigin,
  isEmergency,
  SPEECH_LOCALE,
} from './search-core';
import { userId } from './user';

export type { AppKitWithLakebase };


const SearchQuery = z.object({
  need: z.string().min(1),
  lat: z.coerce.number(),
  lng: z.coerce.number(),
  radius: z.coerce.number().min(1).max(500).default(50),
  type: z.string().optional(),
  operator: z.string().optional(),
  limit: z.coerce.number().min(1).max(50).default(20),
});

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
            [userId(req), `${need} near (${lat},${lng})`, need, lat, lng, radius, rows.length],
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
          lat: z.coerce.number().min(-90).max(90).optional(),
          lng: z.coerce.number().min(-180).max(180).optional(),
        })
        .safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'q required' });
        return;
      }
      const { q, radius, type, operator, limit, lat: devLat, lng: devLng } = parsed.data;
      const hasDevice = devLat != null && devLng != null;
      try {
        // 1. Translate-in + intent extraction (any language -> English need/place).
        const { need, place, lang } = await parseIntent(appkit, q);
        const speechLocale = SPEECH_LOCALE[lang] ?? `${lang}-IN`;
        if (!need || (!place && !hasDevice)) {
          res.status(400).json({
            error: "Tell me a care need and a place, e.g. 'dialysis near Patna' / 'पटना के पास डायलिसिस'.",
            need, place, lang,
          });
          return;
        }
        // 2. Resolve the most precise origin (device GPS > PIN > city), then search.
        const origin = await resolveOrigin(appkit, { message: q, place, deviceLat: devLat, deviceLng: devLng });
        if (!origin) {
          res.status(404).json({ error: `Couldn't find "${place}". Try a nearby city or a PIN code.`, need, place, lang });
          return;
        }
        const rows = await semanticSearch(appkit, { need, lat: origin.lat, lng: origin.lng, radius, type, operator, limit });

        // 3. Localize-out: translate the summary + per-card evidence into the input language.
        const summaryEn = rows.length
          ? `${rows.length} ${rows.length === 1 ? 'facility' : 'facilities'} found for ${need} near ${origin.label}.`
          : `No facilities found for ${need} near ${origin.label}.`;
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
            [userId(req), q, need, origin.label, origin.lat, origin.lng, radius, rows.length],
          )
          .catch(() => undefined);

        res.json({
          need, place: origin.label, lang, speechLocale, emergency: isEmergency(q),
          interpretation: `${need} near ${origin.label}`,
          origin: { label: origin.label, precision: origin.precision },
          summary: localized.summary,
          lat: origin.lat, lng: origin.lng,
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
          [userId(req), body.data.title],
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
          [userId(req)],
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
