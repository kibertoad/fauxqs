import type { FastifyRequest, FastifyReply } from "fastify";
import { S3Error } from "../../common/errors.ts";
import type { S3Store } from "../s3Store.ts";
import {
  checkConditionalDelete,
  deletePreconditionsFromHeaders,
  directoryOnlyPreconditionError,
  hasDeletePreconditions,
  parseDeletePreconditions,
} from "../conditionalDeletes.ts";

export function deleteObject(
  request: FastifyRequest<{ Params: { bucket: string; "*": string } }>,
  reply: FastifyReply,
  store: S3Store,
): void {
  const bucket = request.params.bucket;
  const key = request.params["*"];

  const preconditions = deletePreconditionsFromHeaders(
    request.headers as Record<string, string | string[] | undefined>,
  );
  if (hasDeletePreconditions(preconditions)) {
    // Resolve the bucket first: an absent bucket must read as NoSuchBucket, not
    // as an unsupported precondition (getBucketType answers `undefined` for a
    // bucket that isn't there, which is not a directory bucket either) and not as
    // a failure against a key that could never have been there.
    if (!store.hasBucket(bucket)) {
      throw new S3Error("NoSuchBucket", `The specified bucket does not exist: ${bucket}`, 404);
    }
    if (store.getBucketType(bucket) !== "directory") {
      const unsupported = directoryOnlyPreconditionError(preconditions, "header");
      if (unsupported) throw unsupported;
    }
    checkConditionalDelete(
      parseDeletePreconditions(preconditions),
      store.peekObject(bucket, key),
      `/${bucket}/${key}`,
    );
  }

  store.deleteObject(bucket, key);
  reply.status(204).send();
}
