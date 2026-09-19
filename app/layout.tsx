import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "EcomSync — Distributed Inventory Engine",
  description:
    "Real-time multi-channel inventory synchronization with AI-powered anomaly detection, " +
    "distributed locking, and live dashboard powered by Pusher.",
  keywords: ["inventory", "e-commerce", "shopify", "amazon", "ebay", "sync", "dashboard"],
  openGraph: {
    title: "EcomSync — Distributed Inventory Engine",
    description: "Real-time multi-channel inventory sync with AI anomaly detection.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
