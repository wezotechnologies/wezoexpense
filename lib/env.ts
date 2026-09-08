import "server-only";

/**
 * Server-only environment access (spec 2 "Hard rule", spec 14).
 *
 * The `server-only` import above makes the build fail if any Client Component
 * ever imports this module, so OpenAI / Azure / DB secrets cannot be bundled
 * into the PWA. Nothing here is prefixed NEXT_PUBLIC_.
 *
 * Required vars throw on first access. Optional integrations (OpenAI, Azure)
 * report "not configured" instead so the app still runs and degrades to the
 * manual-entry path (spec 8.1, 8.3).
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return v;
}

function optional(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : null;
}

export type AiProvider = "anthropic" | "openai";

/**
 * Which vendor a model id belongs to. Model ids are the routing key for the
 * whole AI path, so this is the single place that mapping is decided.
 */
export function providerForModel(model: string): AiProvider {
  return model.toLowerCase().startsWith("claude") ? "anthropic" : "openai";
}

export const env = {
  get databaseUrl() {
    return required("DATABASE_URL");
  },
  get authSecret() {
    return process.env.AUTH_SECRET || required("NEXTAUTH_SECRET");
  },
  /**
   * Vision keys for receipt reading. Both providers can be configured at once;
   * which one is used follows the *model* chosen in Settings.
   *
   * Keys are sorted by their own prefix rather than by which variable they sit
   * in, so a key pasted into the wrong slot is still routed to the right vendor
   * instead of being leaked to the other one.
   */
  get aiKeys(): { anthropic: string | null; openai: string | null } {
    const candidates = [
      optional("ANTHROPIC_API_KEY"),
      optional("OPENAI_API_KEY"),
      optional("AI_API_KEY"),
    ].filter((k): k is string => k !== null);

    let anthropic: string | null = null;
    let openai: string | null = null;
    for (const key of candidates) {
      if (key.startsWith("sk-ant-")) anthropic ??= key;
      else openai ??= key;
    }
    return { anthropic, openai };
  },

  /** Providers this deployment can actually call. */
  get aiProviders(): AiProvider[] {
    const { anthropic, openai } = this.aiKeys;
    const out: AiProvider[] = [];
    if (anthropic) out.push("anthropic");
    if (openai) out.push("openai");
    return out;
  },

  /**
   * Default model when Settings has none, or names a provider with no key.
   *
   * `gpt-4.1-mini` rather than the spec's `gpt-4o-mini`: measured on a real
   * receipt it is ~5x cheaper per document (933 vs 25,527 image input tokens)
   * at identical accuracy, which is what the owner asked to optimise for.
   * Falls back to the cheapest Claude model if only Anthropic is configured.
   */
  get aiModel(): string {
    const configured = optional("OPENAI_MODEL") ?? optional("AI_MODEL");
    if (configured && this.aiKeys[providerForModel(configured)]) {
      return configured;
    }
    return this.aiKeys.openai ? "gpt-4.1-mini" : "claude-haiku-4-5";
  },
  get azureConnectionString() {
    return optional("AZURE_STORAGE_CONNECTION_STRING");
  },
  get azureContainer() {
    return optional("AZURE_BLOB_CONTAINER") ?? "wezo-receipts";
  },
  get superadminEmail() {
    return optional("SUPERADMIN_EMAIL");
  },
  get superadminPassword() {
    return optional("SUPERADMIN_PASSWORD");
  },
  get superadminName() {
    return optional("SUPERADMIN_NAME") ?? "Wezo Superadmin";
  },
  get cronSecret() {
    return optional("CRON_SECRET");
  },
  /**
   * Release identifier stamped in by the deploy script, surfaced on
   * /api/health so you can see which build is actually serving.
   *
   * Read through `optional()` deliberately: it indexes `process.env` with a
   * variable, which Next cannot statically analyse. A literal
   * `process.env.WEZO_RELEASE` is inlined at build time — and since the value
   * only exists at run time, that would bake in `undefined` for ever.
   */
  get releaseId() {
    return optional("WEZO_RELEASE");
  },
  get isProduction() {
    return process.env.NODE_ENV === "production";
  },
} as const;

/** True when at least one vision key is present; drives the AI-vs-manual fallback. */
export function isAiConfigured(): boolean {
  return env.aiProviders.length > 0;
}

/** The key for a provider, or null if that provider isn't configured. */
export function aiKeyFor(provider: AiProvider): string | null {
  return env.aiKeys[provider];
}

/** True when Azure Blob is wired up; otherwise dev falls back to local disk. */
export function isAzureConfigured(): boolean {
  return env.azureConnectionString !== null;
}
