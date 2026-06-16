import { createApp, lakebase, serving, server } from '@databricks/appkit';
import { setupReferralRoutes } from './routes/referral/referral-routes';
import { setupConversationRoutes } from './routes/referral/conversation-routes';
import { setupCostRoutes } from './routes/referral/cost-routes';

createApp({
  plugins: [
    lakebase(),
    // `embed` -> databricks-gte-large-en (1024-d query embeddings).
    // `llm`   -> a chat model for translate-in / localize-out (multilingual).
    // Endpoint names are injected via EMBED_ENDPOINT / LLM_ENDPOINT (app.yaml
    // valueFrom the serving_endpoint resources). DATABRICKS_SERVING_ENDPOINT_NAME
    // is also set to satisfy the serving plugin's required default-endpoint check.
    serving({ endpoints: { embed: { env: 'EMBED_ENDPOINT' }, llm: { env: 'LLM_ENDPOINT' } } }),
    server(),
  ],
  async onPluginsReady(appkit) {
    await setupReferralRoutes(appkit);
    setupConversationRoutes(appkit);
    setupCostRoutes(appkit);
  },
}).catch(console.error);
