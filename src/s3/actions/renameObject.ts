import type { FastifyRequest, FastifyReply } from "fastify";
import { S3Error } from "../../common/errors.ts";
import type { S3Store } from "../s3Store.ts";

export async function renameObject(
  request: FastifyRequest<{ Params: { bucket: string; "*": string } }>,
  reply: FastifyReply,
  store: S3Store,
): Promise<void> {
  const bucket = request.params.bucket;
  const destKey = request.params["*"];

  const renameSourceRaw = request.headers["x-amz-rename-source"] as string | undefined;
  if (!renameSourceRaw) {
    throw new S3Error("InvalidRequest", "Missing required header: x-amz-rename-source", 400);
  }

  const decoded = decodeURIComponent(renameSourceRaw);
  const sourceKey = decoded.startsWith("/") ? decoded.slice(1) : decoded;

  // AWS: RenameObject will not succeed on objects that end with the slash (/) delimiter character
  if (sourceKey.endsWith("/") || destKey.endsWith("/")) {
    throw new S3Error(
      "InvalidRequest",
      "RenameObject does not support objects with keys ending in the / delimiter.",
      400,
    );
  }

  // Source conditionals (evaluated against source object)
  const sourceObj = store.headObject(bucket, sourceKey);

  const srcIfMatch = request.headers["x-amz-rename-source-if-match"] as string | undefined;
  if (srcIfMatch && srcIfMatch !== sourceObj.etag) {
    throw new S3Error(
      "PreconditionFailed",
      "At least one of the pre-conditions you specified did not hold",
      412,
    );
  }

  const srcIfNoneMatch = request.headers["x-amz-rename-source-if-none-match"] as string | undefined;
  if (srcIfNoneMatch) {
    if (srcIfNoneMatch === "*" || srcIfNoneMatch === sourceObj.etag) {
      throw new S3Error(
        "PreconditionFailed",
        "At least one of the pre-conditions you specified did not hold",
        412,
      );
    }
  }

  const srcIfModifiedSince = request.headers["x-amz-rename-source-if-modified-since"] as
    | string
    | undefined;
  if (srcIfModifiedSince) {
    const since = new Date(srcIfModifiedSince);
    if (sourceObj.lastModified <= since) {
      throw new S3Error(
        "PreconditionFailed",
        "At least one of the pre-conditions you specified did not hold",
        412,
      );
    }
  }

  const srcIfUnmodifiedSince = request.headers["x-amz-rename-source-if-unmodified-since"] as
    | string
    | undefined;
  if (srcIfUnmodifiedSince) {
    const since = new Date(srcIfUnmodifiedSince);
    if (sourceObj.lastModified > since) {
      throw new S3Error(
        "PreconditionFailed",
        "At least one of the pre-conditions you specified did not hold",
        412,
      );
    }
  }

  // Destination conditionals
  // AWS default: if destination already exists and no conditional headers are provided, fail with 412.
  // If-Match allows explicit overwrite when the ETag matches.
  const ifMatch = request.headers["if-match"] as string | undefined;
  const ifNoneMatch = request.headers["if-none-match"] as string | undefined;
  const ifModifiedSince = request.headers["if-modified-since"] as string | undefined;
  const ifUnmodifiedSince = request.headers["if-unmodified-since"] as string | undefined;
  const hasDestConditionals = !!(ifMatch || ifNoneMatch || ifModifiedSince || ifUnmodifiedSince);

  try {
    const destObj = store.headObject(bucket, destKey);

    // Destination exists
    if (!hasDestConditionals) {
      // No conditionals provided — AWS rejects overwrite by default
      throw new S3Error(
        "PreconditionFailed",
        "At least one of the pre-conditions you specified did not hold",
        412,
      );
    }

    if (ifMatch && ifMatch !== destObj.etag) {
      throw new S3Error(
        "PreconditionFailed",
        "At least one of the pre-conditions you specified did not hold",
        412,
      );
    }

    if (ifNoneMatch) {
      if (ifNoneMatch === "*" || ifNoneMatch === destObj.etag) {
        throw new S3Error(
          "PreconditionFailed",
          "At least one of the pre-conditions you specified did not hold",
          412,
        );
      }
    }

    if (ifModifiedSince) {
      const since = new Date(ifModifiedSince);
      if (destObj.lastModified <= since) {
        throw new S3Error(
          "PreconditionFailed",
          "At least one of the pre-conditions you specified did not hold",
          412,
        );
      }
    }

    if (ifUnmodifiedSince) {
      const since = new Date(ifUnmodifiedSince);
      if (destObj.lastModified > since) {
        throw new S3Error(
          "PreconditionFailed",
          "At least one of the pre-conditions you specified did not hold",
          412,
        );
      }
    }
  } catch (err) {
    if (err instanceof S3Error && err.code === "NoSuchKey") {
      // Destination doesn't exist — this is the happy path for most renames.
      // If-Match requires the destination to exist, so fail if it was provided.
      if (ifMatch) {
        throw new S3Error(
          "PreconditionFailed",
          "At least one of the pre-conditions you specified did not hold",
          412,
        );
      }
    } else {
      throw err;
    }
  }

  await store.renameObject(bucket, sourceKey, destKey);
  reply.status(200).send();
}
