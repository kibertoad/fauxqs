import type { FastifyInstance } from "fastify";
import { S3Error } from "../common/errors.ts";
import type { S3Store } from "./s3Store.ts";
import { createBucket } from "./actions/createBucket.ts";
import { headBucket } from "./actions/headBucket.ts";
import { listObjects } from "./actions/listObjects.ts";
import { deleteObjects } from "./actions/deleteObjects.ts";
import { putObject } from "./actions/putObject.ts";
import { getObject } from "./actions/getObject.ts";
import { deleteObject } from "./actions/deleteObject.ts";
import { headObject } from "./actions/headObject.ts";

export function registerS3Routes(app: FastifyInstance, store: S3Store): void {
  const handleError = (err: unknown, reply: import("fastify").FastifyReply, isHead = false) => {
    if (err instanceof S3Error) {
      if (isHead) {
        reply.status(err.statusCode).send();
      } else {
        reply.header("content-type", "application/xml");
        reply.status(err.statusCode).send(err.toXml());
      }
      return;
    }
    throw err;
  };

  // Helper to get the wildcard key from request params.
  // The S3 SDK sends trailing slashes on bucket-level requests (e.g. PUT /bucket/).
  // Fastify matches /:bucket/* where * is empty string for these.
  const getKey = (params: Record<string, unknown>): string => (params["*"] as string) ?? "";

  // Bucket-level routes (no trailing slash)
  app.put("/:bucket", async (request, reply) => {
    try {
      createBucket(request as any, reply, store);
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.head("/:bucket", async (request, reply) => {
    try {
      headBucket(request as any, reply, store);
    } catch (err) {
      handleError(err, reply, true);
    }
  });

  app.route({
    method: "GET",
    url: "/:bucket",
    exposeHeadRoute: false,
    handler: async (request, reply) => {
      try {
        listObjects(request as any, reply, store);
      } catch (err) {
        handleError(err, reply);
      }
    },
  });

  app.post("/:bucket", async (request, reply) => {
    try {
      deleteObjects(request as any, reply, store);
    } catch (err) {
      handleError(err, reply);
    }
  });

  // Wildcard routes: /:bucket/* handles both bucket-level (trailing slash) and object-level requests.
  // When * is empty, delegate to the bucket-level handler.
  app.put("/:bucket/*", async (request, reply) => {
    try {
      if (!getKey(request.params as Record<string, unknown>)) {
        createBucket(request as any, reply, store);
      } else {
        putObject(request as any, reply, store);
      }
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.route({
    method: "GET",
    url: "/:bucket/*",
    exposeHeadRoute: false,
    handler: async (request, reply) => {
      try {
        if (!getKey(request.params as Record<string, unknown>)) {
          listObjects(request as any, reply, store);
        } else {
          getObject(request as any, reply, store);
        }
      } catch (err) {
        handleError(err, reply);
      }
    },
  });

  app.delete("/:bucket/*", async (request, reply) => {
    try {
      if (!getKey(request.params as Record<string, unknown>)) {
        const bucket = (request.params as Record<string, string>).bucket;
        store.deleteBucket(bucket);
        reply.status(204).send();
      } else {
        deleteObject(request as any, reply, store);
      }
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.head("/:bucket/*", async (request, reply) => {
    try {
      if (!getKey(request.params as Record<string, unknown>)) {
        headBucket(request as any, reply, store);
      } else {
        headObject(request as any, reply, store);
      }
    } catch (err) {
      handleError(err, reply, true);
    }
  });

  app.post("/:bucket/*", async (request, reply) => {
    try {
      deleteObjects(request as any, reply, store);
    } catch (err) {
      handleError(err, reply);
    }
  });
}
