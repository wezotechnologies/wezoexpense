import type { MetadataRoute } from "next";

/**
 * PWA manifest (spec 13). Served at /manifest.webmanifest.
 * Dark theme colour, maskable icons, standalone display.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Wezo Expense Tracker",
    short_name: "Wezo Expenses",
    description:
      "Track Wezo income and expenses, read receipts with AI, approve submissions and export financial reports.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#000000",
    theme_color: "#000000",
    lang: "en-IN",
    dir: "ltr",
    categories: ["finance", "business", "productivity"],
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    shortcuts: [
      {
        name: "Add transaction",
        short_name: "Add",
        description: "Capture a receipt or enter a transaction",
        url: "/add",
      },
      {
        name: "Pending approvals",
        short_name: "Approvals",
        description: "Review submissions awaiting approval",
        url: "/approvals",
      },
    ],
  };
}
