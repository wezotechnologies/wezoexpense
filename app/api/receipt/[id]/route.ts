import { jsonOk, route } from "@/lib/api";
import { ApiError, canViewTransaction, requireUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { getReceiptBytes, getReceiptSasUrl } from "@/lib/storage";

/**
 * GET /api/receipt/:txnId — serves a transaction's receipt (spec 8.4, 12).
 *
 * Authorisation happens here, before any URL exists: the caller must be able to
 * see the transaction. Only then is a short-lived, read-only SAS minted.
 *
 *   default        -> 302 to the SAS URL (so `<img src>` just works)
 *   ?mode=url      -> JSON { url, expiresInSeconds }
 *   ?download=1    -> forces a save-as rather than inline display
 *
 * On the local-disk fallback there is no SAS, so the bytes are streamed back
 * through this same authorised route. Callers see no difference.
 */

const SAS_TTL_MINUTES = 10;

export const GET = route(
  async (request: Request, ctx: RouteContext<"/api/receipt/[id]">) => {
    const user = await requireUser();
    const { id } = await ctx.params;

    const txn = await prisma.transaction.findUnique({
      where: { id },
      select: {
        id: true,
        createdById: true,
        deletedAt: true,
        receiptBlobKey: true,
        receiptMime: true,
      },
    });

    // Identical error for "missing", "deleted" and "not yours", so this can't
    // be used to discover other people's transactions.
    if (!txn || txn.deletedAt || !canViewTransaction(user, txn)) {
      throw new ApiError(404, "That receipt could not be found.");
    }
    if (!txn.receiptBlobKey) {
      throw new ApiError(404, "This transaction has no receipt attached.");
    }

    const url = new URL(request.url);
    const wantsJson = url.searchParams.get("mode") === "url";
    const wantsDownload = url.searchParams.get("download") === "1";
    const mime = txn.receiptMime ?? "application/octet-stream";

    const sasUrl = await getReceiptSasUrl(txn.receiptBlobKey, SAS_TTL_MINUTES);

    if (sasUrl) {
      if (wantsJson) {
        return jsonOk(
          { url: sasUrl, expiresInSeconds: SAS_TTL_MINUTES * 60 },
          { headers: { "cache-control": "private, no-store" } },
        );
      }
      return new Response(null, {
        status: 302,
        headers: { location: sasUrl, "cache-control": "private, no-store" },
      });
    }

    // Local-disk fallback: stream the bytes through this authorised route.
    const bytes = await getReceiptBytes(txn.receiptBlobKey);
    if (!bytes) throw new ApiError(404, "That receipt could not be found.");

    if (wantsJson) {
      return jsonOk(
        { url: `/api/receipt/${txn.id}`, expiresInSeconds: null },
        { headers: { "cache-control": "private, no-store" } },
      );
    }

    const filename = `receipt-${txn.id}${extensionFor(mime)}`;

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "content-type": mime,
        "content-length": String(bytes.length),
        "content-disposition": `${wantsDownload ? "attachment" : "inline"}; filename="${filename}"`,
        // Never let a shared proxy or the service worker keep this.
        "cache-control": "private, no-store, max-age=0",
        "x-content-type-options": "nosniff",
      },
    });
  },
);

function extensionFor(mime: string): string {
  switch (mime) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "application/pdf":
      return ".pdf";
    default:
      return "";
  }
}
