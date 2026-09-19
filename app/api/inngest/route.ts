/**
 * app/api/inngest/route.ts
 *
 * Inngest serves all registered functions through this single route.
 * The Inngest cloud/dev server POSTs events here to invoke functions.
 */

import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { syncChannelUpdate } from "@/inngest/functions/sync-channel-update";
import { anomalyScanCron, anomalyScanOnDemand } from "@/inngest/functions/anomaly-scan";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    syncChannelUpdate,
    anomalyScanCron,
    anomalyScanOnDemand,
  ],
});
