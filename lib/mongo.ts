/**
 * lib/mongo.ts
 *
 * MongoDB client singleton for flexible document storage:
 *   - raw_channel_payloads: unprocessed webhook/API payloads, TTL-indexed (30 days)
 *   - anomaly_snapshots: full state snapshot + severity score + LLM explanation
 *
 * Uses the native `mongodb` driver (no Mongoose) for minimal overhead in
 * serverless / edge environments. Connection is cached across hot-reloads
 * via a module-level singleton (Next.js dev server restarts safely).
 */

import { MongoClient, Collection, Db, ObjectId, IndexDescription } from "mongodb";

// ---------------------------------------------------------------------------
// Type Definitions
// ---------------------------------------------------------------------------

/** Raw inbound payload from a sales channel webhook or poll cycle. */
export interface RawChannelPayload {
  _id?: ObjectId;
  channel: string;           // "shopify" | "amazon" | "ebay" etc.
  sku: string;
  raw: Record<string, unknown>; // The verbatim JSON body from the channel API
  received_at: Date;            // TTL index fires 30 days after this field
  inngest_event_id?: string;    // Correlation ID for the Inngest function run
  processed: boolean;
}

/** Anomaly snapshot written when the scoring engine exceeds the LLM trigger threshold. */
export interface AnomalySnapshot {
  _id?: ObjectId;
  product_id: string;
  channel_id: string;
  sku: string;
  channel_name: string;
  score: number;               // 0–100 deterministic severity score
  rule_breakdown: RuleBreakdown; // Which rules fired and their weights
  explanation: string;         // Plain-English LLM explanation (or fallback message)
  llm_model: string;           // Which model served the explanation
  full_state_snapshot: {
    channel_inventory: Record<string, unknown>;
    recent_sync_events: Record<string, unknown>[];
    product: Record<string, unknown>;
  };
  created_at: Date;
}

/** Result of each individual scoring rule. */
export interface RuleBreakdown {
  large_delta: { triggered: boolean; score_contribution: number; detail: string };
  negative_quantity: { triggered: boolean; score_contribution: number; detail: string };
  high_event_frequency: { triggered: boolean; score_contribution: number; detail: string };
  repeated_failures: { triggered: boolean; score_contribution: number; detail: string };
  total: number;
}

// ---------------------------------------------------------------------------
// MongoDB singleton
// ---------------------------------------------------------------------------

const MONGODB_URI = process.env.MONGODB_URI!;
const DB_NAME = process.env.MONGODB_DB_NAME ?? "ecomsync";

// Cache the promise across Next.js hot-reloads in development
// Uses global to survive module re-evaluation
declare global {
  // eslint-disable-next-line no-var
  var __mongoClientPromise: Promise<MongoClient> | undefined;
}

let clientPromise: Promise<MongoClient>;

if (!MONGODB_URI) {
  // Defer the error to runtime — allows `next build` to succeed without env vars
  clientPromise = Promise.reject(
    new Error("MONGODB_URI environment variable is not set.")
  );
} else if (process.env.NODE_ENV === "development") {
  // In development, re-use the client across HMR cycles
  if (!global.__mongoClientPromise) {
    const client = new MongoClient(MONGODB_URI);
    global.__mongoClientPromise = client.connect();
  }
  clientPromise = global.__mongoClientPromise;
} else {
  // In production, create a new client per serverless invocation lifecycle
  const client = new MongoClient(MONGODB_URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 30000,
  });
  clientPromise = client.connect();
}

export { clientPromise };

// ---------------------------------------------------------------------------
// Database & collection accessors
// ---------------------------------------------------------------------------

export async function getMongoDB(): Promise<Db> {
  const client = await clientPromise;
  return client.db(DB_NAME);
}

export async function getRawPayloadsCollection(): Promise<Collection<RawChannelPayload>> {
  const db = await getMongoDB();
  return db.collection<RawChannelPayload>("raw_channel_payloads");
}

export async function getAnomalySnapshotsCollection(): Promise<Collection<AnomalySnapshot>> {
  const db = await getMongoDB();
  return db.collection<AnomalySnapshot>("anomaly_snapshots");
}

// ---------------------------------------------------------------------------
// Index bootstrapping
// Call once at app startup or in a migration script.
// Idempotent — MongoDB's ensureIndexes is a no-op if index already exists.
// ---------------------------------------------------------------------------

/**
 * Creates all required MongoDB indexes.
 * - TTL index on raw_channel_payloads.received_at (30 days)
 * - Compound indexes for common query patterns
 */
export async function ensureMongoIndexes(): Promise<void> {
  const db = await getMongoDB();

  // raw_channel_payloads indexes
  const payloads = db.collection("raw_channel_payloads");
  const payloadIndexes: IndexDescription[] = [
    {
      // TTL: documents expire 30 days after received_at
      key: { received_at: 1 },
      name: "ttl_received_at_30d",
      expireAfterSeconds: 30 * 24 * 60 * 60, // 2_592_000
    },
    {
      key: { channel: 1, sku: 1, received_at: -1 },
      name: "channel_sku_received_at",
    },
    {
      key: { inngest_event_id: 1 },
      name: "inngest_event_id",
      sparse: true,
    },
  ];
  await payloads.createIndexes(payloadIndexes);

  // anomaly_snapshots indexes
  const anomalies = db.collection("anomaly_snapshots");
  const anomalyIndexes: IndexDescription[] = [
    {
      key: { created_at: -1 },
      name: "created_at_desc",
    },
    {
      key: { product_id: 1, created_at: -1 },
      name: "product_id_created_at",
    },
    {
      key: { score: -1 },
      name: "score_desc",
    },
  ];
  await anomalies.createIndexes(anomalyIndexes);

  console.log("[mongo] Indexes ensured for raw_channel_payloads and anomaly_snapshots");
}

// ---------------------------------------------------------------------------
// Document helpers
// ---------------------------------------------------------------------------

/**
 * Save a raw channel payload document.
 */
export async function saveRawPayload(
  payload: Omit<RawChannelPayload, "_id">
): Promise<string> {
  const col = await getRawPayloadsCollection();
  const result = await col.insertOne(payload as RawChannelPayload);
  return result.insertedId.toHexString();
}

/**
 * Save an anomaly snapshot document.
 */
export async function saveAnomalySnapshot(
  snapshot: Omit<AnomalySnapshot, "_id">
): Promise<string> {
  const col = await getAnomalySnapshotsCollection();
  const result = await col.insertOne(snapshot as AnomalySnapshot);
  return result.insertedId.toHexString();
}

/**
 * Fetch recent anomaly snapshots for the dashboard feed.
 */
export async function getRecentAnomalySnapshots(
  limit: number = 50
): Promise<AnomalySnapshot[]> {
  const col = await getAnomalySnapshotsCollection();
  return col
    .find({})
    .sort({ created_at: -1 })
    .limit(limit)
    .toArray();
}

/**
 * Fetch recent anomalies above a minimum score threshold.
 */
export async function getAnomaliesAboveThreshold(
  minScore: number,
  limit: number = 20
): Promise<AnomalySnapshot[]> {
  const col = await getAnomalySnapshotsCollection();
  return col
    .find({ score: { $gte: minScore } })
    .sort({ created_at: -1 })
    .limit(limit)
    .toArray();
}
