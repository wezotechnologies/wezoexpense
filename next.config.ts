import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * pdfkit loads its built-in font metrics (.afm) from disk at runtime, and
   * sharp / the Prisma engine are native. Bundling any of them breaks those
   * lookups, so they stay external and are required from node_modules.
   */
  serverExternalPackages: ["pdfkit", "sharp", "@prisma/adapter-pg"],

  // This is an internal tool; typed errors should fail the build, not ship.
  // (Next 16 removed `next lint`; linting runs through the ESLint CLI.)
  typescript: { ignoreBuildErrors: false },

  async headers() {
    return [
      {
        // Baseline hardening for every route (spec 14).
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            // The Add screen uses the camera via a file input, which needs no
            // permission grant, so every powerful feature stays switched off.
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
        ],
      },
      {
        // The service worker must never be served stale, or clients get stuck
        // on an old cache strategy.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
