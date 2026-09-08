import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";

import { getSessionUser } from "@/lib/rbac";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Wezo Expense Tracker",
    template: "%s · Wezo Expenses",
  },
  description:
    "Income and expense tracking for Wezo Technologies — AI receipt reading, approvals and financial reports.",
  applicationName: "Wezo Expenses",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Wezo Expenses",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  formatDetection: { telephone: false },
  robots: { index: false, follow: false }, // internal tool
};

export const viewport: Viewport = {
  themeColor: "#000000",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover", // let the app fill notched screens in standalone mode
};

export default async function RootLayout({
  children,
}: LayoutProps<"/">) {
  // Dark is the default (spec 4). The user's remembered choice is applied on
  // the server so there is no light-to-dark flash on first paint.
  const user = await getSessionUser().catch(() => null);
  const themeClass = user?.themePref === "light" ? "light" : "";

  return (
    <html lang="en" className={`${inter.variable} ${themeClass} h-full`}>
      <body className="min-h-full flex flex-col bg-canvas text-ink">
        {children}
      </body>
    </html>
  );
}
