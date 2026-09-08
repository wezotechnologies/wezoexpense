import { jsonCreated, route } from "@/lib/api";
import { ApiError, requireUser } from "@/lib/rbac";
import { enforceRateLimit, LIMITS } from "@/lib/ratelimit";
import { MAX_UPLOAD_BYTES, putReceipt, storageMode } from "@/lib/storage";

/**
 * POST /api/upload — stores a receipt in the private container and returns its
 * blob key (spec 12). The bytes never touch the client again: viewing goes
 * through /api/receipt/:id, which mints a short-lived SAS.
 */
export const POST = route(async (request: Request) => {
  const user = await requireUser();
  enforceRateLimit("upload", user.id, LIMITS.upload.limit, LIMITS.upload.windowMs);

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    throw new ApiError(415, "Send the file as multipart/form-data.");
  }

  // Reject oversized bodies from the header before buffering them.
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_UPLOAD_BYTES * 1.1) {
    throw new ApiError(
      413,
      `File is too large. Maximum size is ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`,
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new ApiError(400, "Could not read the uploaded file.");
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new ApiError(400, "No file was included in the upload.");
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const stored = await putReceipt(bytes, file.type || "application/octet-stream");

  return jsonCreated({
    blobKey: stored.key,
    mime: stored.mime,
    size: stored.size,
    storage: storageMode(),
  });
});
