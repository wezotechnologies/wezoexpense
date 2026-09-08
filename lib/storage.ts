import "server-only";

import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  BlobSASPermissions,
  BlobServiceClient,
  type ContainerClient,
} from "@azure/storage-blob";

import { env, isAzureConfigured } from "@/lib/env";
import { ApiError } from "@/lib/rbac";

/**
 * Receipt storage (spec 2, 8.4, 14).
 *
 * Azure Blob, PRIVATE container. The UI never gets a durable URL — it gets a
 * short-lived read-only SAS minted per request by /api/receipt/[id], which
 * checks role and ownership first.
 *
 * When Azure is not configured (local development, and before the owner
 * supplies credentials at deploy time per spec 20) files fall back to a
 * gitignored folder on disk and are streamed through the same authorised
 * route. Behaviour is identical from the caller's point of view, so no feature
 * is blocked on having Azure available.
 */

export const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;

export type AllowedMime = (typeof ALLOWED_MIME_TYPES)[number];

/** 10 MB — generous for a phone photo, small enough to stay cheap. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const EXTENSIONS: Record<AllowedMime, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

const LOCAL_ROOT = path.join(process.cwd(), ".localblob");

export function isAllowedMime(mime: string): mime is AllowedMime {
  return (ALLOWED_MIME_TYPES as readonly string[]).includes(mime);
}

export function isPdf(mime: string | null | undefined): boolean {
  return mime === "application/pdf";
}

export function isImage(mime: string | null | undefined): boolean {
  return !!mime && mime.startsWith("image/");
}

/**
 * Sniffs the real type from magic bytes rather than trusting the browser's
 * Content-Type, so a renamed executable can't be stored as an "image".
 */
export function sniffMime(bytes: Buffer): AllowedMime | null {
  // Shortest signature checked below is 3 bytes (JPEG); WebP needs 12 and is
  // length-guarded at its own branch.
  if (bytes.length < 5) return null;

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
    bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a &&
    bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.toString("ascii", 0, 5) === "%PDF-") {
    return "application/pdf";
  }
  return null;
}

/** Non-guessable, date-partitioned key. */
function buildKey(mime: AllowedMime): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `receipts/${yyyy}/${mm}/${randomUUID()}.${EXTENSIONS[mime]}`;
}

/** Rejects keys that try to escape the receipts prefix. */
function assertSafeKey(key: string): void {
  if (
    !key.startsWith("receipts/") ||
    key.includes("..") ||
    key.includes("\\") ||
    key.startsWith("/")
  ) {
    throw new ApiError(400, "Invalid receipt reference.");
  }
}

// ---------------------------------------------------------------------------
// Azure
// ---------------------------------------------------------------------------

let containerPromise: Promise<ContainerClient> | null = null;

function getContainer(): Promise<ContainerClient> {
  if (!containerPromise) {
    containerPromise = (async () => {
      const connectionString = env.azureConnectionString;
      if (!connectionString) {
        throw new ApiError(500, "Azure Blob Storage is not configured.");
      }
      const service = BlobServiceClient.fromConnectionString(connectionString);
      const container = service.getContainerClient(env.azureContainer);
      // No `access` argument => private container (spec 14).
      await container.createIfNotExists();
      return container;
    })();
  }
  return containerPromise;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type StoredBlob = { key: string; mime: AllowedMime; size: number };

export async function putReceipt(
  bytes: Buffer,
  declaredMime: string,
): Promise<StoredBlob> {
  if (bytes.length === 0) throw new ApiError(400, "The file is empty.");
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new ApiError(
      413,
      `File is too large. Maximum size is ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`,
    );
  }

  // The browser's Content-Type is never trusted: the type is decided purely by
  // the file's own magic bytes. Falling back to the declared type when sniffing
  // fails would defeat the check entirely — a text file renamed .png would sail
  // through and then be served back with an image content-type.
  const mime = sniffMime(bytes);
  if (!mime) {
    throw new ApiError(
      415,
      "That file isn't a JPG, PNG or WebP image, or a PDF. Check the file and try again.",
    );
  }
  // `declaredMime` is only used to explain a mismatch, never to decide.
  if (isAllowedMime(declaredMime) && declaredMime !== mime) {
    console.warn(
      `[upload] declared ${declaredMime} but the file is actually ${mime}; using the sniffed type.`,
    );
  }

  const key = buildKey(mime);

  if (isAzureConfigured()) {
    const container = await getContainer();
    await container.getBlockBlobClient(key).uploadData(bytes, {
      blobHTTPHeaders: {
        blobContentType: mime,
        // Receipts are immutable once written.
        blobCacheControl: "private, max-age=31536000, immutable",
      },
    });
  } else {
    const full = path.join(LOCAL_ROOT, key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, bytes);
  }

  return { key, mime, size: bytes.length };
}

/** Reads the stored bytes — used for AI extraction and authorised streaming. */
export async function getReceiptBytes(key: string): Promise<Buffer | null> {
  assertSafeKey(key);

  if (isAzureConfigured()) {
    try {
      const container = await getContainer();
      return await container.getBlockBlobClient(key).downloadToBuffer();
    } catch {
      return null;
    }
  }

  try {
    return await readFile(path.join(LOCAL_ROOT, key));
  } catch {
    return null;
  }
}

/**
 * Mints a short-lived, read-only SAS URL for a receipt (spec 8.4).
 * Returns null when running on the local fallback, where the caller streams
 * the bytes through the authorised route instead.
 */
export async function getReceiptSasUrl(
  key: string,
  ttlMinutes = 10,
): Promise<string | null> {
  assertSafeKey(key);
  if (!isAzureConfigured()) return null;

  const container = await getContainer();
  const blob = container.getBlockBlobClient(key);

  return blob.generateSasUrl({
    permissions: BlobSASPermissions.parse("r"), // read only
    expiresOn: new Date(Date.now() + ttlMinutes * 60 * 1000),
    // Guard against clock skew between the app and Azure.
    startsOn: new Date(Date.now() - 2 * 60 * 1000),
    contentDisposition: "inline",
  });
}

export async function deleteReceipt(key: string): Promise<void> {
  assertSafeKey(key);

  if (isAzureConfigured()) {
    const container = await getContainer();
    await container.getBlockBlobClient(key).deleteIfExists();
    return;
  }

  try {
    await unlink(path.join(LOCAL_ROOT, key));
  } catch {
    // Already gone — nothing to do.
  }
}

/** Human-readable description of where receipts are being kept. */
export function storageMode(): "azure" | "local" {
  return isAzureConfigured() ? "azure" : "local";
}
