import type { FastifyRequest, FastifyReply } from "fastify";
import { S3Error } from "../../common/errors.ts";
import type { S3Store } from "../s3Store.ts";
import {
  DIRECTORY_ONLY_DELETE_PRECONDITIONS,
  checkConditionalDelete,
  deletePreconditionsFromHeaders,
  hasDeletePreconditions,
  rejectDirectoryOnlyPreconditions,
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
    if (store.getBucketType(bucket) !== "directory") {
      rejectDirectoryOnlyPreconditions(preconditions, DIRECTORY_ONLY_DELETE_PRECONDITIONS);
    }
    // Resolve the bucket first: an absent bucket must read as NoSuchBucket, not
    // as a precondition failure against a key that could never have been there.
    if (!store.hasBucket(bucket)) {
      throw new S3Error("NoSuchBucket", `The specified bucket does not exist: ${bucket}`, 404);
    }
    checkConditionalDelete(preconditions, store.peekObject(bucket, key), `/${bucket}/${key}`);
  }

  store.deleteObject(bucket, key);
  reply.status(204).send();
}
