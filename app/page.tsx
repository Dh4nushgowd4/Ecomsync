"use client";

import { useState } from "react";
import Link from "next/link";
import styles from "./page.module.css";

export default function LandingPage() {
  // Interactive Simulator State for Demonstration
  const [stock, setStock] = useState({
    shopify: 48,
    amazon: 48,
    ebay: 48,
    base: 48,
    version: 14,
  });
  const [isSimulating, setIsSimulating] = useState(false);
  const [auditLog, setAuditLog] = useState<string>(
    "System idle. OCC Version 14 active. Mutex lock released."
  );

  const handleSimulatePurchase = (channel: "shopify" | "amazon" | "ebay") => {
    if (isSimulating || stock.base <= 0) return;
    setIsSimulating(true);
    setAuditLog(`[1/3] Ingested webhook from ${channel.toUpperCase()}... Acquiring Redis lock: lock:SKU-AUD-001`);

    setTimeout(() => {
      setAuditLog(`[2/3] Lock acquired (8ms). Atomic decrement base stock -> ${stock.base - 1}. Bumping OCC v${stock.version + 1}.`);
      setStock((prev) => {
        const nextQty = Math.max(0, prev.base - 1);
        return {
          shopify: nextQty,
          amazon: nextQty,
          ebay: nextQty,
          base: nextQty,
          version: prev.version + 1,
        };
      });

      setTimeout(() => {
        setAuditLog(`[3/3] Pusher WebSocket broadcasted to all channels. Lock released. Zero oversell verified.`);
        setIsSimulating(false);
      }, 700);
    }, 600);
  };

  const handleResetStock = () => {
    setStock({
      shopify: 48,
      amazon: 48,
      ebay: 48,
      base: 48,
      version: 14,
    });
    setAuditLog("Inventory reset to base qty 48 across all connected channels.");
  };

  return (
    <div className={styles.pageWrapper}>
      {/* Background Glows */}
      <div className={styles.glowAmbientOne} aria-hidden="true" />
      <div className={styles.glowAmbientTwo} aria-hidden="true" />
      <div className={styles.glowAmbientThree} aria-hidden="true" />

      {/* Navigation Bar */}
      <nav className={styles.navHeader} aria-label="Main Navigation">
        <div className={styles.brandGroup}>
          <div className={styles.logoIconWrapper}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
              <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
              <line x1="12" y1="22.08" x2="12" y2="12"></line>
            </svg>
          </div>
          <span className={styles.logoTitle}>EcomSync</span>
          <span className={styles.brandTag}>v2.4 Live</span>
        </div>

        <div className={styles.navLinks}>
          <a href="#features" className={styles.navLink}>Features</a>
          <a href="#simulator" className={styles.navLink}>Interactive Demo</a>
          <a href="#architecture" className={styles.navLink}>Architecture</a>
        </div>

        <div className={styles.navActionGroup}>
          <div className={styles.statusIndicator}>
            <span className={styles.pulsingDot} />
            <span>Redis Mutex Active</span>
          </div>

          <Link href="/dashboard" className={styles.btnPrimaryNav} id="nav-launch-dashboard-btn">
            <span>Launch Dashboard</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12"></line>
              <polyline points="12 5 19 12 12 19"></polyline>
            </svg>
          </Link>
        </div>
      </nav>

      {/* Main Content Area */}
      <main className={styles.mainContent}>
        {/* Hero Section */}
        <section className={styles.heroSection} aria-labelledby="hero-heading">
          <div className={styles.heroBadge}>
            <span className={styles.pulsingDot} />
            <span>Zero-Oversell Multi-Channel Inventory Engine</span>
          </div>

          <h1 id="hero-heading" className={styles.heroTitle}>
            Real-Time Inventory Sync <br />
            <span className={styles.gradientText}>Powered by AI Anomaly Intelligence</span>
          </h1>

          <p className={styles.heroSubtitle}>
            Synchronize stock across Shopify, Amazon, and eBay with sub-second latency.
            Guaranteed race-condition prevention via Upstash Redis distributed locks,
            Optimistic Concurrency Control, and autonomous Inngest background AI scans.
          </p>

          <div className={styles.heroActions}>
            <Link href="/dashboard" className={styles.btnCtaHero} id="hero-launch-dashboard-btn">
              <span>Open Live Dashboard</span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="5" y1="12" x2="19" y2="12"></line>
                <polyline points="12 5 19 12 12 19"></polyline>
              </svg>
            </Link>

            <a href="#simulator" className={styles.btnSecondaryHero}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="5 3 19 12 5 21 5 3"></polygon>
              </svg>
              <span>Test Interactive Concurrency</span>
            </a>
          </div>
        </section>

        {/* Interactive Simulator Section */}
        <section id="simulator" className={styles.simulatorBox} aria-label="Interactive Simulator">
          <div className={styles.simulatorHeader}>
            <div className={styles.simHeaderTitle}>
              <div className={styles.terminalDots}>
                <span className={styles.dotRed} />
                <span className={styles.dotYellow} />
                <span className={styles.dotGreen} />
              </div>
              <span style={{ fontWeight: 700, fontSize: "14px", color: "#cbd5e1" }}>
                Live Inventory Distributed State: SKU-AUD-001 (Sony WH-1000XM5)
              </span>
            </div>

            <div className={styles.simBadgeLock}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
              </svg>
              <span>OCC v{stock.version} • Lock Latency: &lt;8ms</span>
            </div>
          </div>

          <div className={styles.channelCardsRow}>
            {/* Shopify */}
            <div className={styles.channelCard}>
              <div className={styles.channelCardTop}>
                <span className={styles.channelTag} style={{ backgroundColor: "rgba(150, 191, 72, 0.15)", color: "#96bf48", border: "1px solid rgba(150, 191, 72, 0.3)" }}>
                  Shopify Store
                </span>
                <span style={{ fontSize: "11px", color: "#94a3b8" }}>US-East</span>
              </div>
              <div className={styles.channelStockValue}>{stock.shopify}</div>
              <div className={styles.channelMeta}>
                <span>Available Units</span>
                <span style={{ color: "#96bf48" }}>Synced</span>
              </div>
            </div>

            {/* Amazon */}
            <div className={styles.channelCard}>
              <div className={styles.channelCardTop}>
                <span className={styles.channelTag} style={{ backgroundColor: "rgba(255, 153, 0, 0.15)", color: "#ff9900", border: "1px solid rgba(255, 153, 0, 0.3)" }}>
                  Amazon FBA
                </span>
                <span style={{ fontSize: "11px", color: "#94a3b8" }}>Marketplace</span>
              </div>
              <div className={styles.channelStockValue}>{stock.amazon}</div>
              <div className={styles.channelMeta}>
                <span>Available Units</span>
                <span style={{ color: "#ff9900" }}>Synced</span>
              </div>
            </div>

            {/* eBay */}
            <div className={styles.channelCard}>
              <div className={styles.channelCardTop}>
                <span className={styles.channelTag} style={{ backgroundColor: "rgba(229, 50, 56, 0.15)", color: "#e53238", border: "1px solid rgba(229, 50, 56, 0.3)" }}>
                  eBay Global
                </span>
                <span style={{ fontSize: "11px", color: "#94a3b8" }}>Storefront</span>
              </div>
              <div className={styles.channelStockValue}>{stock.ebay}</div>
              <div className={styles.channelMeta}>
                <span>Available Units</span>
                <span style={{ color: "#e53238" }}>Synced</span>
              </div>
            </div>
          </div>

          <div className={styles.simulatorControls}>
            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
              <button
                type="button"
                className={styles.btnSimulateOrder}
                onClick={() => handleSimulatePurchase("shopify")}
                disabled={isSimulating}
                id="sim-shopify-btn"
              >
                <span>🛒 Simulate Shopify Sale (-1)</span>
              </button>
              <button
                type="button"
                className={styles.btnSimulateOrder}
                onClick={() => handleSimulatePurchase("amazon")}
                disabled={isSimulating}
                id="sim-amazon-btn"
              >
                <span>📦 Simulate Amazon Sale (-1)</span>
              </button>
              <button
                type="button"
                className={styles.btnSimulateOrder}
                onClick={handleResetStock}
                style={{ background: "rgba(255, 255, 255, 0.05)", borderColor: "rgba(255, 255, 255, 0.12)", color: "#94a3b8" }}
                id="sim-reset-btn"
              >
                <span>↺ Reset</span>
              </button>
            </div>

            <div className={styles.simAuditLog}>
              <span style={{ color: isSimulating ? "#38bdf8" : "#4ade80" }}>●</span>
              <span>{auditLog}</span>
            </div>
          </div>
        </section>

        {/* Metrics Grid */}
        <section className={styles.metricsGrid} aria-label="Performance Metrics">
          <div className={styles.metricCard}>
            <div className={styles.metricValue}>&lt; 15ms</div>
            <div className={styles.metricLabel}>Mutex Lock Latency</div>
            <div className={styles.metricDesc}>Upstash Redis fast-lock acquisition</div>
          </div>
          <div className={styles.metricCard}>
            <div className={styles.metricValue}>0.00%</div>
            <div className={styles.metricLabel}>Oversell Rate</div>
            <div className={styles.metricDesc}>Strict OCC version validation</div>
          </div>
          <div className={styles.metricCard}>
            <div className={styles.metricValue}>3+</div>
            <div className={styles.metricLabel}>Live Channels</div>
            <div className={styles.metricDesc}>Shopify, Amazon, eBay synchronized</div>
          </div>
          <div className={styles.metricCard}>
            <div className={styles.metricValue}>100%</div>
            <div className={styles.metricLabel}>AI Anomaly Audited</div>
            <div className={styles.metricDesc}>Automated Inngest scans with LLM score</div>
          </div>
        </section>

        {/* Key Features Grid */}
        <section id="features" className={styles.sectionHeader}>
          <div className={styles.sectionPretitle}>Engine Highlights</div>
          <h2 className={styles.sectionTitle}>Built for High-Volume Concurrency</h2>
          <p className={styles.sectionSubtitle}>
            Engineered to withstand flash sales, rapid order bursts, and cross-platform inventory drift.
          </p>
        </section>

        <div className={styles.featuresGrid}>
          {/* Feature 1 */}
          <div className={styles.featureCard}>
            <div className={styles.featureIconWrapper} style={{ background: "rgba(99, 102, 241, 0.15)", color: "#818cf8" }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
              </svg>
            </div>
            <h3 className={styles.featureTitle}>Distributed OCC & Redis Mutex</h3>
            <p className={styles.featureDescription}>
              Atomic mutex locks ensure that when 50 customers purchase the last unit at the exact same millisecond,
              only one order succeeds and zero overselling occurs.
            </p>
            <span className={styles.featureBadge}>Upstash Redis + Exponential Jitter</span>
          </div>

          {/* Feature 2 */}
          <div className={styles.featureCard}>
            <div className={styles.featureIconWrapper} style={{ background: "rgba(6, 182, 212, 0.15)", color: "#22d3ee" }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
              </svg>
            </div>
            <h3 className={styles.featureTitle}>Sub-Second WebSocket Sync</h3>
            <p className={styles.featureDescription}>
              Live bi-directional WebSocket broadcasting pushes every delta to the browser within 50ms.
              Operators always observe true global stock numbers across every storefront.
            </p>
            <span className={styles.featureBadge}>Pusher Channels + Edge Events</span>
          </div>

          {/* Feature 3 */}
          <div className={styles.featureCard}>
            <div className={styles.featureIconWrapper} style={{ background: "rgba(245, 158, 11, 0.15)", color: "#fbbf24" }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                <line x1="12" y1="9" x2="12" y2="13"></line>
                <line x1="12" y1="17" x2="12.01" y2="17"></line>
              </svg>
            </div>
            <h3 className={styles.featureTitle}>Automated Anomaly Detection</h3>
            <p className={styles.featureDescription}>
              Background cron workers analyze delta velocity and stock depletion rates.
              Suspicious flash drains trigger an AI score (0-100) with diagnostic explanations.
            </p>
            <span className={styles.featureBadge}>Inngest Workflows + LLM Scoring</span>
          </div>

          {/* Feature 4 */}
          <div className={styles.featureCard}>
            <div className={styles.featureIconWrapper} style={{ background: "rgba(16, 185, 129, 0.15)", color: "#34d399" }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
              </svg>
            </div>
            <h3 className={styles.featureTitle}>Natural Language AI Copilot</h3>
            <p className={styles.featureDescription}>
              Ask questions about stock levels, anomalous drains, and channel discrepancies.
              Powered by streaming multi-provider fallback (Groq Llama 3.3, Gemini Flash, OpenAI).
            </p>
            <span className={styles.featureBadge}>Vercel AI SDK + Multi-Provider Fallback</span>
          </div>
        </div>

        {/* Architecture Pipeline */}
        <section id="architecture" className={styles.archCard}>
          <div className={styles.sectionHeader} style={{ marginBottom: "20px" }}>
            <div className={styles.sectionPretitle}>System Architecture</div>
            <h2 className={styles.sectionTitle} style={{ fontSize: "28px" }}>Event-Driven Ingestion Pipeline</h2>
          </div>

          <div className={styles.pipelineFlow}>
            <div className={styles.pipelineStep}>
              <div className={styles.stepNumber}>Step 01</div>
              <div className={styles.stepTitle}>Webhook Ingest</div>
              <div className={styles.stepDesc}>
                Shopify, Amazon, and eBay dispatch order events to secure API route endpoints.
              </div>
            </div>

            <div className={styles.pipelineStep}>
              <div className={styles.stepNumber}>Step 02</div>
              <div className={styles.stepTitle}>Redis OCC Lock</div>
              <div className={styles.stepDesc}>
                SKU mutex locks with exponential backoff prevent concurrent write collisions.
              </div>
            </div>

            <div className={styles.pipelineStep}>
              <div className={styles.stepNumber}>Step 03</div>
              <div className={styles.stepTitle}>Atomic Persistence</div>
              <div className={styles.stepDesc}>
                Supabase PostgreSQL + MongoDB transactional records verify version consistency.
              </div>
            </div>

            <div className={styles.pipelineStep}>
              <div className={styles.stepNumber}>Step 04</div>
              <div className={styles.stepTitle}>Live Broadcast</div>
              <div className={styles.stepDesc}>
                Pusher pushes real-time updates and Inngest schedules background AI anomaly scans.
              </div>
            </div>
          </div>
        </section>

        {/* Bottom CTA Banner */}
        <section className={styles.ctaBanner}>
          <h2 className={styles.ctaTitle}>Experience the Live Operational Dashboard</h2>
          <p className={styles.ctaSubtitle}>
            Monitor active product SKUs, view real-time WebSocket delta streams, test concurrent load simulations,
            and interact with the AI inventory assistant.
          </p>
          <Link href="/dashboard" className={styles.btnCtaHero} id="cta-bottom-launch-btn">
            <span>Launch Dashboard Now</span>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12"></line>
              <polyline points="12 5 19 12 12 19"></polyline>
            </svg>
          </Link>
        </section>
      </main>

      {/* Footer */}
      <footer className={styles.footer}>
        <div className={styles.footerLeft}>
          <div className={styles.logoIconWrapper} style={{ width: "24px", height: "24px", borderRadius: "6px" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2.5">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
            </svg>
          </div>
          <span>© {new Date().getFullYear()} EcomSync Distributed Engine. All rights reserved.</span>
        </div>

        <div className={styles.footerRight}>
          <Link href="/dashboard" className={styles.footerLink}>Dashboard</Link>
          <a href="/api/inventory" target="_blank" rel="noopener noreferrer" className={styles.footerLink}>Inventory API</a>
          <a href="/api/inngest" target="_blank" rel="noopener noreferrer" className={styles.footerLink}>Inngest Workflows</a>
        </div>
      </footer>
    </div>
  );
}
