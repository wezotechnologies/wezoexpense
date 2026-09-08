import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import OpenAI from "openai";
import sharp from "sharp";
import { z } from "zod";
import { extractText, getDocumentProxy } from "unpdf";

import {
  aiKeyFor,
  env,
  isAiConfigured,
  providerForModel,
  type AiProvider,
} from "@/lib/env";
import { getAiBudget, recordAiSpend } from "@/lib/settings";
import { prisma } from "@/lib/prisma";
import { isPdf } from "@/lib/storage";
import {
  bandFor,
  normaliseDraft,
  type ConfidenceBand,
  type ExtractionDraft,
} from "@/lib/ai-parse";

/**
 * AI / OCR pipeline (spec 8). Server-only: the vision key never leaves here.
 *
 * Providers
 *  - Both OpenAI (the spec's `gpt-4o-mini`) and Anthropic (Claude) are
 *    supported, and both can be configured at the same time. The vendor
 *    follows the *model* chosen in Settings, so switching is a dropdown rather
 *    than an environment change.
 *  - Keys are matched to vendors by their own prefix (`sk-ant-…` is Anthropic),
 *    never by which variable they sit in, so a key pasted into the wrong slot
 *    cannot be leaked to the other vendor.
 *  - Both paths share the prompt, the image preparation, the spend accounting
 *    and the output normalisation, so their results are interchangeable.
 *
 * Input handling
 *  - Images are EXIF-rotated (phone photos are frequently sideways, and a
 *    sideways receipt reads badly), downscaled to 1600px on the longest edge
 *    and re-encoded as JPEG to keep the token count — and the bill — small.
 *  - PDFs take the text-extraction path rather than being rasterised. Invoices
 *    and salary slips are nearly always digital PDFs with a real text layer, so
 *    reading the text is both more accurate than OCR and avoids a native canvas
 *    dependency. A scanned (image-only) PDF yields no text; that is detected
 *    and routed to the manual form with an explanation, per spec 8.3.
 *
 * Reliability
 *  - Both providers are constrained to a strict schema, so neither can reply
 *    with prose. Parsing is *still* defensive (see lib/ai-parse.ts), because
 *    spec 8.2 requires a malformed reply to degrade to manual entry rather
 *    than fail the request.
 *
 * Cost control
 *  - The monthly cap is checked before the call and the running total is
 *    incremented from the usage the API actually reports (spec 8.1).
 */

export const MAX_IMAGE_EDGE = 1600;

export type {
  ConfidenceBand,
  ExtractionDraft,
  FieldConfidence,
} from "@/lib/ai-parse";
export { bandFor, normaliseDraft } from "@/lib/ai-parse";

/**
 * Per-model facts the pipeline needs.
 *
 *  - `inputPerM` / `outputPerM`: USD per 1M tokens, for estimating spend
 *    against the monthly cap.
 *  - `supportsEffort`: whether the model accepts `output_config.effort`.
 *    Claude Haiku 4.5 does **not** — sending it returns
 *    `400 This model does not support the effort parameter`, which would make
 *    the model silently unusable. Capability lives here rather than as an
 *    inline special case so adding a model is a one-line change.
 */
type ModelInfo = {
  inputPerM: number;
  outputPerM: number;
  supportsEffort?: boolean;
};

const MODELS: Record<string, ModelInfo> = {
  // OpenAI (effort is not an OpenAI concept; the flag is unused there)
  "gpt-4o-mini": { inputPerM: 0.15, outputPerM: 0.6 },
  "gpt-4o": { inputPerM: 2.5, outputPerM: 10 },
  "gpt-4.1-mini": { inputPerM: 0.4, outputPerM: 1.6 },
  // Anthropic
  "claude-opus-5": { inputPerM: 5, outputPerM: 25, supportsEffort: true },
  "claude-sonnet-5": { inputPerM: 2, outputPerM: 10, supportsEffort: true },
  "claude-haiku-4-5": { inputPerM: 1, outputPerM: 5, supportsEffort: false },
};

/** Priced as the most expensive supported model, so an unknown id can't
 *  quietly under-report spend against the cap. Effort is assumed unsupported,
 *  because sending it to a model that rejects it breaks the call outright
 *  whereas omitting it merely costs a little more. */
const UNKNOWN_MODEL: ModelInfo = {
  inputPerM: 5,
  outputPerM: 25,
  supportsEffort: false,
};

function modelInfo(model: string): ModelInfo {
  return MODELS[model] ?? UNKNOWN_MODEL;
}

export type ExtractionOutcome = {
  /** false => show the manual form with a banner. */
  ok: boolean;
  band: ConfidenceBand;
  draft: ExtractionDraft | null;
  /** Raw model output, stored on the transaction for audit. */
  raw: unknown;
  notice: string | null;
  model: string | null;
  provider: AiProvider | null;
  estimatedCostUsd: number;
};

function manualFallback(notice: string, raw: unknown = null): ExtractionOutcome {
  return {
    ok: false,
    band: "low",
    draft: null,
    raw,
    notice,
    model: null,
    provider: null,
    estimatedCostUsd: 0,
  };
}

// ---------------------------------------------------------------------------
// Prompt & schema (shared by both providers)
// ---------------------------------------------------------------------------

function systemPrompt(categoryNames: string[]): string {
  const allowed = categoryNames.length
    ? categoryNames.join(", ")
    : "(no categories configured)";

  return `You are a finance data extractor for an Indian company.
Read the attached receipt / invoice / salary slip / payment screenshot and return ONLY a JSON
object (no prose, no markdown) with this exact shape:

{
  "type": "income" | "expense" | "unknown",
  "date": "YYYY-MM-DD" | null,
  "vendor": string | null,
  "originalCurrency": "INR"|"USD"|"CAD"|"AED"|other|null,
  "originalAmount": number | null,
  "amountInr": number | null,
  "taxOrVatAmount": number | null,
  "paymentMethod": string | null,
  "suggestedCategory": string | null,
  "confidence": number,
  "fieldConfidence": { "amount": number, "date": number, "vendor": number, "category": number },
  "reasoning": string
}

Rules:
- Allowed categories (choose the single best or null): ${allowed}.
- Guess income vs expense from context (a bank credit / client payment = income; a bill / salary slip / purchase = expense).
- If a value is not clearly present, use null and lower its fieldConfidence.
- Never invent amounts. Prefer the total/paid amount.
- "originalAmount" is the amount as printed on the document, in the document's own currency.
- "amountInr" is only for an INR figure actually shown on the document (for example a bank credit in rupees). If the document shows no INR figure, use null — do not convert currencies yourself.
- Dates may be written DD/MM/YYYY or MM/DD/YYYY. Indian documents are usually DD/MM/YYYY; use surrounding context and never return an impossible date.
- All confidence values are between 0 and 1. "reasoning" must be one short line.`;
}

/** Zod mirror of the shape above, for Anthropic's structured outputs. */
const extractionSchema = z.object({
  type: z.enum(["income", "expense", "unknown"]),
  date: z.string().nullable(),
  vendor: z.string().nullable(),
  originalCurrency: z.string().nullable(),
  originalAmount: z.number().nullable(),
  amountInr: z.number().nullable(),
  taxOrVatAmount: z.number().nullable(),
  paymentMethod: z.string().nullable(),
  suggestedCategory: z.string().nullable(),
  confidence: z.number(),
  fieldConfidence: z.object({
    amount: z.number(),
    date: z.number(),
    vendor: z.number(),
    category: z.number(),
  }),
  reasoning: z.string(),
});

/** JSON Schema equivalent, for OpenAI's strict json_schema mode. */
const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "type", "date", "vendor", "originalCurrency", "originalAmount",
    "amountInr", "taxOrVatAmount", "paymentMethod", "suggestedCategory",
    "confidence", "fieldConfidence", "reasoning",
  ],
  properties: {
    type: { type: "string", enum: ["income", "expense", "unknown"] },
    date: { type: ["string", "null"] },
    vendor: { type: ["string", "null"] },
    originalCurrency: { type: ["string", "null"] },
    originalAmount: { type: ["number", "null"] },
    amountInr: { type: ["number", "null"] },
    taxOrVatAmount: { type: ["number", "null"] },
    paymentMethod: { type: ["string", "null"] },
    suggestedCategory: { type: ["string", "null"] },
    confidence: { type: "number" },
    fieldConfidence: {
      type: "object",
      additionalProperties: false,
      required: ["amount", "date", "vendor", "category"],
      properties: {
        amount: { type: "number" },
        date: { type: "number" },
        vendor: { type: "number" },
        category: { type: "number" },
      },
    },
    reasoning: { type: "string" },
  },
} as const;

// ---------------------------------------------------------------------------
// Input preparation
// ---------------------------------------------------------------------------

/** EXIF-rotate, downscale and re-encode an image to keep tokens low. */
export async function prepareImageForAi(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes)
    .rotate() // honour EXIF orientation
    .resize({
      width: MAX_IMAGE_EDGE,
      height: MAX_IMAGE_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
}

/** Pulls the text layer out of a PDF. Returns "" for a scanned/image-only PDF. */
export async function extractPdfText(bytes: Buffer): Promise<string> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    const merged = Array.isArray(text) ? text.join("\n") : text;
    return (merged ?? "").replace(/\s+\n/g, "\n").trim();
  } catch {
    return "";
  }
}

function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = modelInfo(model);
  return (
    (inputTokens / 1_000_000) * pricing.inputPerM +
    (outputTokens / 1_000_000) * pricing.outputPerM
  );
}

/** What the model is given: either a prepared image or a PDF's text. */
type PreparedInput =
  | { kind: "image"; base64: string }
  | { kind: "text"; text: string }
  | { kind: "unusable"; notice: string };

async function prepareInput(
  bytes: Buffer,
  mime: string,
): Promise<PreparedInput> {
  if (isPdf(mime)) {
    const text = await extractPdfText(bytes);
    if (text.length < 20) {
      return {
        kind: "unusable",
        notice:
          "This PDF has no readable text layer (it looks like a scan), so please fill in the details yourself.",
      };
    }
    return { kind: "text", text: text.slice(0, 12_000) };
  }

  try {
    const prepared = await prepareImageForAi(bytes);
    return { kind: "image", base64: prepared.toString("base64") };
  } catch {
    return {
      kind: "unusable",
      notice:
        "That image couldn't be processed, so please fill in the details yourself.",
    };
  }
}

const USER_INSTRUCTION = "Extract the transaction from this document.";

function textPrompt(text: string): string {
  return `Extract the transaction from this document's text:\n\n${text}`;
}

// ---------------------------------------------------------------------------
// Provider: Anthropic (Claude)
// ---------------------------------------------------------------------------

async function extractViaClaude(
  input: Exclude<PreparedInput, { kind: "unusable" }>,
  model: string,
  categoryNames: string[],
): Promise<ExtractionOutcome> {
  const client = new Anthropic({
    apiKey: aiKeyFor("anthropic") ?? "",
    maxRetries: 1,
    timeout: 60_000,
  });

  const content: Anthropic.ContentBlockParam[] =
    input.kind === "image"
      ? [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: input.base64,
            },
          },
          { type: "text", text: USER_INSTRUCTION },
        ]
      : [{ type: "text", text: textPrompt(input.text) }];

  try {
    const response = await client.messages.parse({
      model,
      max_tokens: 2048,
      system: systemPrompt(categoryNames),
      messages: [{ role: "user", content }],
      output_config: {
        format: zodOutputFormat(extractionSchema),
        // Reading a receipt is a simple extraction, so low effort keeps both
        // latency and cost down without hurting accuracy — but only models
        // that accept the parameter may be sent it.
        ...(modelInfo(model).supportsEffort ? { effort: "low" as const } : {}),
      },
    });

    const cost = estimateCost(
      model,
      response.usage.input_tokens,
      response.usage.output_tokens,
    );

    // A safety decline is a normal outcome here, not an exception.
    if (response.stop_reason === "refusal") {
      return {
        ...manualFallback(
          "The model declined to read this document — please fill in the details yourself.",
          response.stop_details ?? null,
        ),
        model,
        provider: "anthropic",
        estimatedCostUsd: cost,
      };
    }

    const parsed = response.parsed_output ?? null;
    return finishOutcome(parsed, parsed, model, "anthropic", cost);
  } catch (error) {
    console.error("[ai] Claude extraction failed:", describeError(error));
    return manualFallback(
      "AI reading is unavailable right now, so please fill in the details yourself.",
    );
  }
}

// ---------------------------------------------------------------------------
// Provider: OpenAI
// ---------------------------------------------------------------------------

async function extractViaOpenAI(
  input: Exclude<PreparedInput, { kind: "unusable" }>,
  model: string,
  categoryNames: string[],
): Promise<ExtractionOutcome> {
  const client = new OpenAI({
    apiKey: aiKeyFor("openai") ?? "",
    maxRetries: 1,
    timeout: 45_000,
  });

  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] =
    input.kind === "image"
      ? [
          { type: "text", text: USER_INSTRUCTION },
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${input.base64}`,
              detail: "high", // receipts have small print worth resolving
            },
          },
        ]
      : [{ type: "text", text: textPrompt(input.text) }];

  let completion: OpenAI.Chat.Completions.ChatCompletion;
  try {
    completion = await client.chat.completions.create({
      model,
      temperature: 0, // deterministic extraction
      max_completion_tokens: 700,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "receipt_extraction",
          strict: true,
          schema: RESPONSE_SCHEMA as unknown as Record<string, unknown>,
        },
      },
      messages: [
        { role: "system", content: systemPrompt(categoryNames) },
        { role: "user", content },
      ],
    });
  } catch (error) {
    console.error("[ai] OpenAI extraction failed:", describeError(error));
    return manualFallback(
      "AI reading is unavailable right now, so please fill in the details yourself.",
    );
  }

  const cost = estimateCost(
    model,
    completion.usage?.prompt_tokens ?? 0,
    completion.usage?.completion_tokens ?? 0,
  );

  const text = completion.choices[0]?.message?.content ?? "";

  // Defensive parse: tolerate stray markdown fences even though strict mode
  // should prevent them.
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim(),
    );
  } catch {
    return {
      ...manualFallback(
        "AI couldn't read this clearly — please fill this in.",
        text,
      ),
      model,
      provider: "openai",
      estimatedCostUsd: cost,
    };
  }

  return finishOutcome(parsed, parsed, model, "openai", cost);
}

// ---------------------------------------------------------------------------
// Shared tail
// ---------------------------------------------------------------------------

function finishOutcome(
  candidate: unknown,
  raw: unknown,
  model: string,
  provider: AiProvider,
  cost: number,
): ExtractionOutcome {
  const draft = normaliseDraft(candidate);

  if (!draft) {
    return {
      ...manualFallback(
        "AI couldn't read this clearly — please fill this in.",
        raw,
      ),
      model,
      provider,
      estimatedCostUsd: cost,
    };
  }

  const band = bandFor(draft.confidence);

  return {
    ok: true,
    band,
    draft,
    raw,
    notice:
      band === "low"
        ? "AI wasn't confident — please check every field before saving."
        : band === "verify"
          ? "Please verify the highlighted fields before saving."
          : null,
    model,
    provider,
    estimatedCostUsd: cost,
  };
}

/** Keeps provider error details out of the response but in the server log. */
function describeError(error: unknown): string {
  if (error instanceof Anthropic.APIError || error instanceof OpenAI.APIError) {
    return `${error.name} ${error.status ?? ""}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Reads a receipt and returns a draft transaction.
 * Always resolves — every failure path degrades to manual entry (spec 8.3).
 */
export async function extractReceipt(
  bytes: Buffer,
  mime: string,
): Promise<ExtractionOutcome> {
  if (!isAiConfigured()) {
    return manualFallback(
      "AI reading isn't configured on this deployment, so please fill in the details yourself.",
    );
  }

  // Spend cap — checked before the call (spec 8.1).
  const budget = await getAiBudget();
  if (budget.exhausted) {
    return manualFallback(
      `This month's AI budget of $${budget.capUsd.toFixed(2)} is used up, so please fill in the details yourself. A Superadmin can raise the cap in Settings.`,
    );
  }

  const categories = await prisma.category.findMany({
    where: { isActive: true },
    select: { name: true },
    orderBy: { name: "asc" },
  });
  const categoryNames = [...new Set(categories.map((c) => c.name))];

  const input = await prepareInput(bytes, mime);
  if (input.kind === "unusable") return manualFallback(input.notice);

  // The chosen model decides the vendor. If Settings names a model whose
  // provider has no key configured, fall back to a model we can actually call
  // rather than failing every extraction.
  const savedModel = budget.model;
  const model = aiKeyFor(providerForModel(savedModel)) ? savedModel : env.aiModel;
  const provider = providerForModel(model);

  if (!aiKeyFor(provider)) {
    return manualFallback(
      "No API key is configured for the selected model, so please fill in the details yourself.",
    );
  }

  const outcome =
    provider === "anthropic"
      ? await extractViaClaude(input, model, categoryNames)
      : await extractViaOpenAI(input, model, categoryNames);

  if (outcome.estimatedCostUsd > 0) {
    await recordAiSpend(outcome.estimatedCostUsd);
  }

  return outcome;
}
