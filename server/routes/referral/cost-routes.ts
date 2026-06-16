// Cost dashboard API.
//
// Token costs (embeddings + chat LLM) are MEASURED from referral.usage_event,
// which logs the real token counts returned by every Model Serving call.
// Compute costs (Lakebase, Apps) are ESTIMATES — list prices vary by region/tier,
// so they're exposed as editable assumptions rather than billed figures.
//
// The authoritative billed number lives in `system.billing.usage`, which needs a
// SQL warehouse to query — out of reach while serverless is disabled here.
import type { AppKitWithLakebase } from './search-core';

// --- Pricing assumptions (USD). Override via env; clearly labelled in the UI. ---
const PRICE = {
  embedPerMTok: Number(process.env.PRICE_EMBED_PER_MTOK ?? 0.10), // gte-large-en, per 1M tokens
  llmPerMTok: Number(process.env.PRICE_LLM_PER_MTOK ?? 1.50), // llama-3.3-70b, blended per 1M tokens
  lakebaseCuHour: Number(process.env.PRICE_LAKEBASE_CU_HOUR ?? 0.50), // per CU-hour, 1 CU
  appDbuHour: Number(process.env.PRICE_APP_HOUR ?? 0.10), // app compute, per hour
};
const HOURS_PER_MONTH = 730;

export function setupCostRoutes(appkit: AppKitWithLakebase): void {
  appkit.server.extend((app) => {
    app.get('/api/cost', async (_req, res) => {
      try {
        const usage = await appkit.lakebase.query(
          `SELECT kind, count(*)::bigint AS calls, coalesce(sum(tokens),0)::bigint AS tokens,
                  min(created_at) AS first_at
             FROM referral.usage_event GROUP BY kind`,
        );
        const by = new Map(usage.rows.map((r) => [String(r.kind), r]));
        const embTok = Number(by.get('embed')?.tokens ?? 0);
        const embCalls = Number(by.get('embed')?.calls ?? 0);
        const llmTok = Number(by.get('llm')?.tokens ?? 0);
        const llmCalls = Number(by.get('llm')?.calls ?? 0);

        const embedCost = (embTok / 1e6) * PRICE.embedPerMTok;
        const llmCost = (llmTok / 1e6) * PRICE.llmPerMTok;
        const measuredTotal = embedCost + llmCost;
        const searches = embCalls; // one embedding per search
        const perSearch = searches ? measuredTotal / searches : 0;

        // Compute components: estimated monthly at this tier (auto-suspend reduces it).
        const lakebaseMonthly = PRICE.lakebaseCuHour * HOURS_PER_MONTH;
        const appMonthly = PRICE.appDbuHour * HOURS_PER_MONTH;

        const since = usage.rows
          .map((r) => r.first_at)
          .filter(Boolean)
          .sort()[0] ?? null;

        res.json({
          since,
          measured: {
            embeddings: { endpoint: 'databricks-gte-large-en', calls: embCalls, tokens: embTok, ratePerMTok: PRICE.embedPerMTok, costUsd: round4(embedCost) },
            llm: { endpoint: 'databricks-meta-llama-3-3-70b-instruct', calls: llmCalls, tokens: llmTok, ratePerMTok: PRICE.llmPerMTok, costUsd: round4(llmCost) },
            totalUsd: round4(measuredTotal),
          },
          searches,
          perSearchUsd: round4(perSearch),
          computeMonthlyEstimate: {
            lakebase: { detail: '1 CU, autoscaling', ratePerHour: PRICE.lakebaseCuHour, costUsd: round2(lakebaseMonthly) },
            app: { detail: 'Databricks App compute', ratePerHour: PRICE.appDbuHour, costUsd: round2(appMonthly) },
            totalUsd: round2(lakebaseMonthly + appMonthly),
          },
          prices: PRICE,
        });
      } catch (err) {
        console.error('[cost] failed:', err);
        res.status(503).json({ error: 'cost data unavailable' });
      }
    });
  });
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
const round2 = (n: number) => Math.round(n * 100) / 100;
