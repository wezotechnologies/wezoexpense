import "dotenv/config";
import { defineConfig } from "prisma/config";

/**
 * Prisma CLI configuration.
 *
 * `datasource.url` is resolved here rather than with Prisma's `env()` helper,
 * which throws while the config file is being *loaded* if the variable is
 * absent. That is too strict: `prisma generate` only reads the schema to emit
 * the client and never opens a connection, but it still loads this file — so a
 * missing DATABASE_URL broke `npm ci` (via the postinstall hook) on any machine
 * without a .env, including CI and a fresh clone.
 *
 * The fallback host is deliberately an RFC 2606 `.invalid` name, which can
 * never resolve. A plausible-looking placeholder such as
 * `postgresql://user:pass@localhost:5432/db` would be dangerous: on a developer
 * machine that really is running Postgres, a command that *does* connect —
 * `migrate deploy`, `db push` — could silently operate on the wrong database.
 * With `.invalid`, generate succeeds and anything needing a real connection
 * fails immediately with a legible DNS error.
 */
const PLACEHOLDER_URL =
  "postgresql://placeholder:placeholder@prisma-config-placeholder.invalid:5432/placeholder?schema=public";

const databaseUrl = process.env["DATABASE_URL"]?.trim() || PLACEHOLDER_URL;

if (databaseUrl === PLACEHOLDER_URL) {
  // Visible, but not fatal — generate is legitimate here.
  console.warn(
    "[prisma.config] DATABASE_URL is not set; using an unresolvable placeholder. " +
      "`prisma generate` works, but any command that connects will fail.",
  );
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: databaseUrl,
  },
});
