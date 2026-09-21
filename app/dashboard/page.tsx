/**
 * app/dashboard/page.tsx
 *
 * EcomSync Live Dashboard
 * Real-time multi-channel inventory management UI
 */

"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Pusher from "pusher-js";
import { useChat } from "@ai-sdk/react";

import styles from "./dashboard.module.css";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InventoryItem {
  product_id: string;
  sku: string;
  name: string;
  base_quantity: number;
  channel_id: string;
  channel_name: string;
  channel_quantity: number;
  last_synced_at: string;
  version: number;
}

interface AnomalyItem {
  snapshotId: string;
  sku: string;
  productName: string;
  channelName: string;
  score: number;
  explanation: string;
  llmModel: string;
  detectedAt: string;
}

interface LiveUpdate {
  sku: string;
  productName: string;
  channelName: string;
  quantity: number;
  delta: number;
  syncedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scoreColor(score: number): string {
  if (score >= 80) return "#ff4444";
  if (score >= 60) return "#ff8c00";
  if (score >= 40) return "#ffd700";
  return "#4ade80";
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "—";
  }
}

function groupByProduct(items: InventoryItem[]): Map<string, InventoryItem[]> {
  const map = new Map<string, InventoryItem[]>();
  for (const item of items) {
    const existing = map.get(item.product_id) ?? [];
    existing.push(item);
    map.set(item.product_id, existing);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Channel badge
// ---------------------------------------------------------------------------

const CHANNEL_COLORS: Record<string, string> = {
  shopify:  "#96bf48",
  amazon:   "#ff9900",
  ebay:     "#e53238",
  walmart:  "#0071ce",
  etsy:     "#f56400",
};

function ChannelBadge({ name }: { name: string }) {
  const color = CHANNEL_COLORS[name] ?? "#888";
  return (
    <span className={styles.channelBadge} style={{ backgroundColor: color + "22", color, borderColor: color + "44" }}>
      {name}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Score ring
// ---------------------------------------------------------------------------

function ScoreRing({ score }: { score: number }) {
  const color = scoreColor(score);
  const r = 20;
  const circumference = 2 * Math.PI * r;
  const progress = (score / 100) * circumference;

  return (
    <div className={styles.scoreRing}>
      <svg width="52" height="52" viewBox="0 0 52 52">
        <circle cx="26" cy="26" r={r} fill="none" stroke="#ffffff10" strokeWidth="4" />
        <circle
          cx="26" cy="26" r={r}
          fill="none"
          stroke={color}
          strokeWidth="4"
          strokeDasharray={`${progress} ${circumference}`}
          strokeLinecap="round"
          transform="rotate(-90 26 26)"
          style={{ transition: "stroke-dasharray 0.5s ease" }}
        />
      </svg>
      <span className={styles.scoreValue} style={{ color }}>{score}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Dashboard
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [anomalies, setAnomalies] = useState<AnomalyItem[]>([]);
  const [liveUpdates, setLiveUpdates] = useState<LiveUpdate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"inventory" | "anomalies" | "chat">("inventory");
  const [pusherConnected, setPusherConnected] = useState(false);
  const [flashedSkus, setFlashedSkus] = useState<Set<string>>(new Set());
  const chatRef = useRef<HTMLDivElement>(null);

  // ── Vercel AI SDK v7 chat ─────────────────────────────────────────────────
  // v7 removed input/handleInputChange/handleSubmit — manage input manually
  const { messages, sendMessage, status } = (useChat as any)({
    api: "/api/chat",
    maxSteps: 5,
  });
  const chatLoading = status === "streaming" || status === "submitted";
  const [chatInput, setChatInput] = useState("");

  const submitChat = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      const text = chatInput.trim();
      if (!text || chatLoading) return;
      (sendMessage as any)({ role: "user", content: text });
      setChatInput("");
    },
    [chatInput, chatLoading, sendMessage]
  );

  // Scroll chat to bottom on new messages
  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [messages]);

  const [isSeeding, setIsSeeding] = useState(false);

  // ── Fetch inventory helper ────────────────────────────────────────────────
  const loadInventory = useCallback(() => {
    setIsLoading(true);
    fetch("/api/inventory")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setInventory(data);
        setIsLoading(false);
      })
      .catch(() => setIsLoading(false));
  }, []);

  // ── 1-Click Seed Handler ─────────────────────────────────────────────────
  const handleSeed = async () => {
    try {
      setIsSeeding(true);
      const res = await fetch("/api/seed", { method: "POST" });
      if (!res.ok) throw new Error("Seed request failed");
      loadInventory();
    } catch (err) {
      console.error("[Seed] Failed to seed database:", err);
    } finally {
      setIsSeeding(false);
    }
  };

  useEffect(() => {
    loadInventory();
  }, [loadInventory]);

  // ── Pusher real-time subscription ────────────────────────────────────────
  useEffect(() => {
    const pusherKey     = process.env.NEXT_PUBLIC_PUSHER_KEY;
    const pusherCluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER ?? "us2";

    if (!pusherKey) {
      console.warn("[Pusher] NEXT_PUBLIC_PUSHER_KEY not set — real-time updates disabled");
      return;
    }

    const pusher = new Pusher(pusherKey, { cluster: pusherCluster });

    pusher.connection.bind("connected",    () => setPusherConnected(true));
    pusher.connection.bind("disconnected", () => setPusherConnected(false));

    // ── inventory-updates channel ──────────────────────────────────────────
    const inventoryChannel = pusher.subscribe("inventory-updates");
    inventoryChannel.bind("inventory:updated", (data: {
      sku: string; productName: string; channelName: string;
      channelId: string; productId: string; quantity: number; delta: number; syncedAt: string;
    }) => {
      // Flash animation for updated row
      setFlashedSkus((prev) => new Set([...prev, data.sku]));
      setTimeout(() => {
        setFlashedSkus((prev) => {
          const next = new Set(prev);
          next.delete(data.sku);
          return next;
        });
      }, 1500);

      // Update inventory in-place
      setInventory((prev) =>
        prev.map((item) =>
          item.sku === data.sku && item.channel_name === data.channelName
            ? { ...item, channel_quantity: data.quantity, last_synced_at: data.syncedAt, version: data.version ?? item.version }
            : item
        )
      );

      // Prepend to live feed
      setLiveUpdates((prev) => [
        { sku: data.sku, productName: data.productName, channelName: data.channelName,
          quantity: data.quantity, delta: data.delta, syncedAt: data.syncedAt },
        ...prev.slice(0, 49),
      ]);
    });

    // ── anomaly-alerts channel ─────────────────────────────────────────────
    const anomalyChannel = pusher.subscribe("anomaly-alerts");
    anomalyChannel.bind("anomaly:detected", (data: {
      snapshotId: string; sku: string; productName: string; channelName: string;
      score: number; explanation: string; llmModel: string; detectedAt: string;
    }) => {
      setAnomalies((prev) => [
        { snapshotId: data.snapshotId, sku: data.sku, productName: data.productName,
          channelName: data.channelName, score: data.score, explanation: data.explanation,
          llmModel: data.llmModel, detectedAt: data.detectedAt },
        ...prev.slice(0, 99),
      ]);
    });

    return () => {
      pusher.unsubscribe("inventory-updates");
      pusher.unsubscribe("anomaly-alerts");
      pusher.disconnect();
    };
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  const grouped = groupByProduct(inventory);
  const allChannels = [...new Set(inventory.map((i) => i.channel_name))].sort();

  return (
    <div className={styles.root}>
      {/* ── Header ── */}
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.logo}>
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
              <rect width="28" height="28" rx="8" fill="url(#logoGrad)" />
              <path d="M7 14h5l3-7 3 14 3-7h1" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <defs>
                <linearGradient id="logoGrad" x1="0" y1="0" x2="28" y2="28">
                  <stop offset="0%" stopColor="#6366f1" />
                  <stop offset="100%" stopColor="#8b5cf6" />
                </linearGradient>
              </defs>
            </svg>
            <span className={styles.logoText}>EcomSync</span>
          </div>
          <span className={styles.subtitle}>Distributed Inventory Engine</span>
        </div>
        <div className={styles.headerRight}>
          <div className={`${styles.connectionDot} ${pusherConnected ? styles.connected : styles.disconnected}`} />
          <span className={styles.connectionLabel}>
            {pusherConnected ? "Live" : "Connecting…"}
          </span>
          <div className={styles.statsChip}>{inventory.length > 0 ? `${grouped.size} Products` : "Loading…"}</div>
          <div className={styles.statsChip}>{allChannels.length} Channels</div>
          {anomalies.length > 0 && (
            <div className={`${styles.statsChip} ${styles.alertChip}`}>⚠ {anomalies.length} Alerts</div>
          )}
        </div>
      </header>

      {/* ── Tabs ── */}
      <nav className={styles.tabs}>
        <button className={`${styles.tab} ${activeTab === "inventory" ? styles.activeTab : ""}`} onClick={() => setActiveTab("inventory")}>
          📦 Inventory
        </button>
        <button className={`${styles.tab} ${activeTab === "anomalies" ? styles.activeTab : ""}`} onClick={() => setActiveTab("anomalies")}>
          ⚠ Anomalies {anomalies.length > 0 && <span className={styles.badge}>{anomalies.length}</span>}
        </button>
        <button className={`${styles.tab} ${activeTab === "chat" ? styles.activeTab : ""}`} onClick={() => setActiveTab("chat")}>
          🤖 AI Chat
        </button>
      </nav>

      <main className={styles.main}>
        {/* ── Live Feed Sidebar ── */}
        <aside className={styles.sidebar}>
          <h3 className={styles.sidebarTitle}>Live Updates</h3>
          {liveUpdates.length === 0 ? (
            <div className={styles.emptyFeed}>
              <div className={styles.pulsingDot} />
              <p>Waiting for sync events…</p>
              <p className={styles.hint}>Trigger a webhook to see live updates here</p>
            </div>
          ) : (
            <div className={styles.feedList}>
              {liveUpdates.map((u, i) => (
                <div key={i} className={styles.feedItem}>
                  <div className={styles.feedHeader}>
                    <span className={styles.feedSku}>{u.sku}</span>
                    <span className={`${styles.feedDelta} ${u.delta < 0 ? styles.negative : styles.positive}`}>
                      {u.delta > 0 ? "+" : ""}{u.delta}
                    </span>
                  </div>
                  <div className={styles.feedMeta}>
                    <ChannelBadge name={u.channelName} />
                    <span className={styles.feedTime}>{formatTime(u.syncedAt)}</span>
                  </div>
                  <div className={styles.feedQty}>→ {u.quantity} units</div>
                </div>
              ))}
            </div>
          )}
        </aside>

        {/* ── Main Content ── */}
        <div className={styles.content}>
          {/* ── INVENTORY TAB ── */}
          {activeTab === "inventory" && (
            <div className={styles.inventoryPanel}>
              {isLoading ? (
                <div className={styles.loadingState}>
                  <div className={styles.spinner} />
                  <p>Loading inventory…</p>
                </div>
              ) : grouped.size === 0 ? (
                <div className={styles.emptyState}>
                  <p style={{ fontWeight: 600, fontSize: "16px", marginBottom: "8px" }}>
                    No inventory data found in Supabase.
                  </p>
                  <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "20px" }}>
                    Seed the database with sample products across Shopify, Amazon, and eBay.
                  </p>
                  <button
                    onClick={handleSeed}
                    disabled={isSeeding}
                    style={{
                      padding: "10px 22px",
                      background: "linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)",
                      color: "#fff",
                      border: "none",
                      borderRadius: "8px",
                      fontWeight: 600,
                      fontSize: "14px",
                      cursor: isSeeding ? "not-allowed" : "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "8px",
                      marginBottom: "16px",
                      boxShadow: "0 0 16px rgba(99, 102, 241, 0.4)",
                    }}
                  >
                    {isSeeding ? "🌱 Seeding Database..." : "🌱 Seed Demo Inventory (1-Click)"}
                  </button>
                  <p style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "8px" }}>
                    Or seed via terminal:
                  </p>
                  <code>npx tsx scripts/seed.ts</code>
                </div>
              ) : (
                <div className={styles.inventoryGrid}>
                  {[...grouped.entries()].map(([productId, channels]) => {
                    const product = channels[0];
                    const isFlashed = flashedSkus.has(product.sku);
                    const totalQty = channels.reduce((s, c) => s + c.channel_quantity, 0);
                    return (
                      <div
                        key={productId}
                        className={`${styles.productCard} ${isFlashed ? styles.flashCard : ""}`}
                      >
                        <div className={styles.productHeader}>
                          <div>
                            <div className={styles.productSku}>{product.sku}</div>
                            <div className={styles.productName}>{product.name}</div>
                          </div>
                          <div className={styles.baseQtyBadge}>
                            Base: <strong>{product.base_quantity}</strong>
                          </div>
                        </div>
                        <div className={styles.channelList}>
                          {channels.map((ch) => {
                            const pct = Math.min(100, (ch.channel_quantity / Math.max(product.base_quantity, 1)) * 100);
                            const barColor = pct < 20 ? "#ff4444" : pct < 50 ? "#ffd700" : "#4ade80";
                            return (
                              <div key={ch.channel_id} className={styles.channelRow}>
                                <ChannelBadge name={ch.channel_name} />
                                <div className={styles.quantityArea}>
                                  <div className={styles.quantityBar}>
                                    <div
                                      className={styles.quantityFill}
                                      style={{ width: `${pct}%`, backgroundColor: barColor }}
                                    />
                                  </div>
                                  <span className={styles.quantityLabel}>{ch.channel_quantity}</span>
                                </div>
                                <span className={styles.syncTime}>{formatTime(ch.last_synced_at)}</span>
                              </div>
                            );
                          })}
                        </div>
                        <div className={styles.productFooter}>
                          <span>Total across channels: <strong>{totalQty}</strong></span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ── ANOMALIES TAB ── */}
          {activeTab === "anomalies" && (
            <div className={styles.anomaliesPanel}>
              {anomalies.length === 0 ? (
                <div className={styles.emptyState}>
                  <div className={styles.allClearIcon}>✓</div>
                  <p>No anomalies detected.</p>
                  <p className={styles.hint}>The anomaly scanner runs every 5 minutes.</p>
                </div>
              ) : (
                <div className={styles.anomalyList}>
                  {anomalies.map((a) => (
                    <div key={a.snapshotId} className={styles.anomalyCard}>
                      <div className={styles.anomalyLeft}>
                        <ScoreRing score={a.score} />
                      </div>
                      <div className={styles.anomalyContent}>
                        <div className={styles.anomalyHeader}>
                          <span className={styles.anomalySku}>{a.sku}</span>
                          <ChannelBadge name={a.channelName} />
                          <span className={styles.anomalyTime}>{formatTime(a.detectedAt)}</span>
                        </div>
                        <p className={styles.anomalyExplanation}>{a.explanation}</p>
                        <div className={styles.anomalyFooter}>
                          <span className={styles.modelTag}>🤖 {a.llmModel}</span>
                          <span className={styles.scoreTag} style={{ color: scoreColor(a.score) }}>
                            Score: {a.score}/100
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── CHAT TAB ── */}
          {activeTab === "chat" && (
            <div className={styles.chatPanel}>
              <div className={styles.chatMessages} ref={chatRef}>
                {messages.length === 0 && (
                  <div className={styles.chatWelcome}>
                    <div className={styles.chatWelcomeIcon}>🤖</div>
                    <h3>EcomSync AI</h3>
                    <p>Ask me about inventory levels, anomalies, or channel health.</p>
                    <div className={styles.chatSuggestions}>
                      {[
                        "What's the inventory for SKU-001?",
                        "Are there any recent anomalies above score 60?",
                        "How is the shopify channel doing?",
                        "Show me products with low stock",
                      ].map((s) => (
                        <button
                          key={s}
                          type="button"
                          className={styles.suggestion}
                          onClick={() => setChatInput(s)}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {messages.map((m) => (
                  <div key={m.id} className={`${styles.chatMessage} ${m.role === "user" ? styles.userMessage : styles.assistantMessage}`}>
                    <div className={styles.messageRole}>{m.role === "user" ? "You" : "EcomSync AI"}</div>
                    <div className={styles.messageContent}>
                      {(m as any).content && <span>{(m as any).content}</span>}
                      {m.parts?.map((p: any, i: number) => {
                        if (p.type === "text") return <span key={i}>{p.text}</span>;
                        if (typeof p.type === "string" && p.type.startsWith("tool-")) {
                          // Extract tool name by removing "tool-" prefix
                          const toolName = p.type.replace("tool-", "");
                          return (
                            <div key={i} className={styles.toolBadge}>
                              ⚙️ {p.state === "output-available" ? "Fetched" : "Fetching"} data from {toolName}...
                            </div>
                          );
                        }
                        return null;
                      })}
                    </div>
                  </div>
                ))}
                {chatLoading && (
                  <div className={`${styles.chatMessage} ${styles.assistantMessage}`}>
                    <div className={styles.messageRole}>EcomSync AI</div>
                    <div className={styles.typingIndicator}>
                      <span /><span /><span />
                    </div>
                  </div>
                )}
              </div>
              <form onSubmit={submitChat} className={styles.chatInput}>
                <input
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) submitChat(); }}
                  placeholder="Ask about inventory, anomalies, channel health…"
                  className={styles.chatInputField}
                  disabled={chatLoading}
                />
                <button type="submit" className={styles.chatSendBtn} disabled={chatLoading || !chatInput.trim()}>
                  {chatLoading ? "…" : "↑"}
                </button>
              </form>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
