// Multi-turn agent conversations.
//
// Lifecycle: a conversation lives in Lakebase (fast OLTP) while it's active, then
// on close (explicit or idle-timeout) it's archived to a UC Delta table and purged
// from Lakebase — so Lakebase stays lean and history lands in the lakehouse.
import { z } from 'zod';
import { getExecutionContext } from '@databricks/appkit';
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

// Map low-level DB failures to an honest, actionable message instead of a 500.
function friendlyError(err: unknown): string {
  const m = (err as Error)?.message ?? '';
  if (/ENOTFOUND|ECONNREFUSED|disabled|endpoint|timeout|terminating/i.test(m)) {
    return 'The database is waking up — please try again in a few seconds.';
  }
  return 'Something went wrong. Please try again.';
}


const WAREHOUSE_ID = process.env.DATABRICKS_WAREHOUSE_ID ?? '';
const ARCHIVE_TABLE = process.env.CONVERSATION_ARCHIVE_TABLE ?? 'dais_hackathon.bronze.rc_conversations';
const IDLE_MINUTES = 30;
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 90); // hard-delete health-query data after this

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Safe coercion of an unknown DB value to text (pg returns timestamptz as Date).
function asText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

interface SqlParam { name: string; value: string }

// Run a statement on the SQL warehouse via the Statement Execution API. Polls
// past the serverless cold-start. Auth follows the app (local profile / deployed SP).
async function warehouseExec(statement: string, parameters: SqlParam[]): Promise<void> {
  if (!WAREHOUSE_ID) throw new Error('DATABRICKS_WAREHOUSE_ID not set');
  const client = getExecutionContext().client;
  let resp = await client.statementExecution.executeStatement({
    warehouse_id: WAREHOUSE_ID,
    statement,
    parameters,
    wait_timeout: '30s',
    on_wait_timeout: 'CONTINUE',
  });
  let state = resp.status?.state;
  const id = resp.statement_id ?? '';
  for (let i = 0; (state === 'PENDING' || state === 'RUNNING') && i < 30; i++) {
    await sleep(2000);
    resp = await client.statementExecution.getStatement({ statement_id: id });
    state = resp.status?.state;
  }
  if (state !== 'SUCCEEDED') {
    throw new Error(`warehouse exec ${state ?? 'UNKNOWN'}: ${JSON.stringify(resp.status?.error)}`);
  }
}

// Archive one conversation to the UC Delta table, then delete it from Lakebase.
async function archiveConversation(appkit: AppKitWithLakebase, conversationId: string): Promise<void> {
  const conv = await appkit.lakebase.query(
    `SELECT conversation_id, user_id, lang, started_at FROM referral.conversation WHERE conversation_id=$1`,
    [conversationId],
  );
  if (conv.rows.length === 0) return;
  const c = conv.rows[0];
  const turns = await appkit.lakebase.query(
    `SELECT turn_no, role, content, parsed_need, parsed_place, lat, lng, result_count, results_json, created_at
       FROM referral.conversation_turn WHERE conversation_id=$1 ORDER BY turn_no`,
    [conversationId],
  );

  await warehouseExec(
    `INSERT INTO ${ARCHIVE_TABLE}
     SELECT :cid, :uid, :lang, CAST(:started AS TIMESTAMP), current_timestamp(),
            CAST(:tcount AS INT), :turns, current_timestamp()`,
    [
      { name: 'cid', value: asText(c.conversation_id) },
      { name: 'uid', value: asText(c.user_id) },
      { name: 'lang', value: asText(c.lang) },
      { name: 'started', value: asText(c.started_at) },
      { name: 'tcount', value: String(turns.rows.length) },
      { name: 'turns', value: JSON.stringify(turns.rows) },
    ],
  );

  // Purge from Lakebase (cascades to conversation_turn).
  await appkit.lakebase.query(`DELETE FROM referral.conversation WHERE conversation_id=$1`, [conversationId]);
}

const Message = z.object({
  text: z.string().min(1),
  radius: z.coerce.number().min(1).max(500).default(50),
  limit: z.coerce.number().min(1).max(50).default(10),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  operator: z.enum(['public', 'private']).optional(),
});

export function setupConversationRoutes(appkit: AppKitWithLakebase): void {
  appkit.server.extend((app) => {
    // Start a conversation.
    app.post('/api/conversation', async (req, res) => {
      try {
        const { rows } = await appkit.lakebase.query(
          `INSERT INTO referral.conversation (user_id) VALUES ($1) RETURNING conversation_id`,
          [userId(req)],
        );
        res.status(201).json({ conversation_id: rows[0].conversation_id });
      } catch (err) {
        console.error('[conversation] create failed:', err);
        res.status(500).json({ error: 'could not start conversation' });
      }
    });

    // One agent turn: parse (with prior-turn context) -> search -> localize -> log.
    app.post('/api/conversation/:id/message', async (req, res) => {
      const id = req.params.id;
      const parsed = Message.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'text required' });
        return;
      }
      const { text, radius, limit, lat: devLat, lng: devLng, operator } = parsed.data;
      const hasDevice = devLat != null && devLng != null;
      const emergency = isEmergency(text);
      try {
        const conv = await appkit.lakebase.query(
          `SELECT status FROM referral.conversation WHERE conversation_id=$1`,
          [id],
        );
        if (conv.rows.length === 0) {
          res.status(404).json({ error: 'conversation not found' });
          return;
        }
        // Context = last assistant turn's resolved need/place (for follow-ups).
        const last = await appkit.lakebase.query(
          `SELECT parsed_need, parsed_place FROM referral.conversation_turn
            WHERE conversation_id=$1 AND parsed_need IS NOT NULL ORDER BY turn_no DESC LIMIT 1`,
          [id],
        );
        const ctx = last.rows.length
          ? { need: asText(last.rows[0].parsed_need), place: asText(last.rows[0].parsed_place) }
          : undefined;

        const { need, place, lang } = await parseIntent(appkit, text, ctx);
        const speechLocale = SPEECH_LOCALE[lang] ?? `${lang}-IN`;

        const nextNo = await appkit.lakebase.query(
          `SELECT coalesce(max(turn_no),0) AS n FROM referral.conversation_turn WHERE conversation_id=$1`,
          [id],
        );
        const userNo = Number(nextNo.rows[0].n) + 1;
        await appkit.lakebase.query(
          `INSERT INTO referral.conversation_turn (conversation_id, turn_no, role, content) VALUES ($1,$2,'user',$3)`,
          [id, userNo, text],
        );

        // Need a care need, and either a place or the device location.
        if (!need || (!place && !hasDevice)) {
          const ask = 'Which care need and where? e.g. "dialysis near Patna", a 6-digit PIN, or tap 📍 to use your location.';
          await appkit.lakebase.query(
            `INSERT INTO referral.conversation_turn (conversation_id, turn_no, role, content, parsed_need, parsed_place, result_count)
             VALUES ($1,$2,'assistant',$3,$4,$5,0)`,
            [id, userNo + 1, ask, need || null, place || null],
          );
          await appkit.lakebase.query(
            `UPDATE referral.conversation SET last_activity_at=now(), lang=$2 WHERE conversation_id=$1`,
            [id, lang],
          );
          res.json({ lang, speechLocale, emergency, interpretation: `${need} ${place}`.trim(), summary: ask, count: 0, results: [] });
          return;
        }

        // Resolve the most precise origin: device GPS > PIN > city centroid.
        const origin = await resolveOrigin(appkit, { message: text, place, deviceLat: devLat, deviceLng: devLng });
        if (!origin) {
          const msg = `I couldn't find "${place}". Try a nearby city, a PIN code, or share your location.`;
          await appkit.lakebase.query(
            `INSERT INTO referral.conversation_turn (conversation_id, turn_no, role, content, parsed_need, parsed_place, result_count)
             VALUES ($1,$2,'assistant',$3,$4,$5,0)`,
            [id, userNo + 1, msg, need, place],
          );
          res.json({ lang, speechLocale, emergency, interpretation: `${need} near ${place}`, summary: msg, count: 0, results: [] });
          return;
        }

        const rows = await semanticSearch(appkit, { need, lat: origin.lat, lng: origin.lng, radius, limit, operator });
        const summaryEn = rows.length
          ? `${rows.length} ${rows.length === 1 ? 'facility' : 'facilities'} found for ${need} near ${origin.label}.`
          : `No facilities found for ${need} near ${origin.label}.`;
        const reasonsEn = rows.map((r) => (typeof r.match_reason === 'string' ? r.match_reason : ''));
        const localized = await localize(appkit, summaryEn, reasonsEn, lang);
        const results = rows.map((r, i) => ({ ...r, match_reason: localized.reasons[i] ?? r.match_reason, match_reason_en: r.match_reason }));

        // Compact results for the archive (keep Lakebase small).
        const compact = rows.map((r) => ({
          facility_id: r.facility_id, name: r.name, distance_km: r.distance_km,
          score: r.score, match_reason_en: r.match_reason, city: r.city,
        }));
        await appkit.lakebase.query(
          `INSERT INTO referral.conversation_turn
             (conversation_id, turn_no, role, content, parsed_need, parsed_place, lat, lng, result_count, results_json)
           VALUES ($1,$2,'assistant',$3,$4,$5,$6,$7,$8,$9)`,
          [id, userNo + 1, summaryEn, need, place, origin.lat, origin.lng, results.length, JSON.stringify(compact)],
        );
        await appkit.lakebase.query(
          `UPDATE referral.conversation SET last_activity_at=now(), lang=$2 WHERE conversation_id=$1`,
          [id, lang],
        );

        res.json({
          lang, speechLocale, emergency,
          interpretation: `${need} near ${origin.label}`,
          origin: { label: origin.label, precision: origin.precision },
          summary: localized.summary,
          count: results.length, results,
        });
      } catch (err) {
        console.error('[conversation] message failed:', err);
        res.status(503).json({ error: friendlyError(err), emergency });
      }
    });

    // Close: archive to UC Delta, then purge from Lakebase.
    app.post('/api/conversation/:id/close', async (req, res) => {
      const id = req.params.id;
      try {
        await appkit.lakebase.query(
          `UPDATE referral.conversation SET status='closing' WHERE conversation_id=$1`,
          [id],
        );
        await archiveConversation(appkit, id);
        res.json({ ok: true, archived_to: ARCHIVE_TABLE });
      } catch (err) {
        console.error('[conversation] close/archive failed:', err);
        res.status(500).json({ error: 'archive failed', detail: (err as Error).message });
      }
    });
  });

  // Idle sweeper: archive + purge conversations with no activity for IDLE_MINUTES.
  setInterval(() => {
    void (async () => {
      try {
        const { rows } = await appkit.lakebase.query(
          `SELECT conversation_id FROM referral.conversation
            WHERE status='active' AND last_activity_at < now() - ($1 || ' minutes')::interval`,
          [String(IDLE_MINUTES)],
        );
        for (const r of rows) {
          try {
            await archiveConversation(appkit, asText(r.conversation_id));
            console.log('[conversation] idle-archived', r.conversation_id);
          } catch (e) {
            console.warn('[conversation] idle archive failed:', (e as Error).message);
          }
        }
        // Retention: hard-delete health-query data past the retention window.
        const days = String(RETENTION_DAYS);
        await appkit.lakebase.query(
          `DELETE FROM referral.conversation WHERE started_at < now() - ($1 || ' days')::interval`, [days],
        ).catch(() => undefined);
        await appkit.lakebase.query(
          `DELETE FROM referral.search_session WHERE created_at < now() - ($1 || ' days')::interval`, [days],
        ).catch(() => undefined);
      } catch {
        /* sweeper is best-effort */
      }
    })();
  }, 5 * 60 * 1000).unref();
}
