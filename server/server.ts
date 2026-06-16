import { createApp, lakebase, serving, server } from '@databricks/appkit';
import { setupReferralRoutes } from './routes/referral/referral-routes';

createApp({
  plugins: [
    lakebase(),
    // Default endpoint -> databricks-gte-large-en (1024-d query embeddings).
    // Name is injected via DATABRICKS_SERVING_ENDPOINT_NAME (app.yaml valueFrom
    // the `embed` serving_endpoint resource).
    serving(),
    server(),
  ],
  async onPluginsReady(appkit) {
    await setupReferralRoutes(appkit);
  },
}).catch(console.error);
