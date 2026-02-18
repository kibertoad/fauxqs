import type { FastifyInstance } from "fastify";
import { S3Error } from "../common/errors.js";
import type { S3Store } from "./s3Store.js";
import { createBucket } from "./actions/createBucket.js";
import { headBucket } from "./actions/headBucket.js";
import { listObjects } from "./actions/listObjects.js";
import { deleteObjects } from "./actions/deleteObjects.js";
import { putObject } from "./actions/putObject.js";
import { getObject } from "./actions/getObject.js";
import { deleteObject } from "./actions/deleteObject.js";
import { headObject } from "./actions/headObject.js";

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

  // Bucket-level routes
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

  // Use exposeHeadRoute: false to avoid conflict with explicit HEAD route
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

  // Object-level routes
  app.put("/:bucket/*", async (request, reply) => {
    try {
      putObject(request as any, reply, store);
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
        getObject(request as any, reply, store);
      } catch (err) {
        handleError(err, reply);
      }
    },
  });

  app.delete("/:bucket/*", async (request, reply) => {
    try {
      deleteObject(request as any, reply, store);
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.head("/:bucket/*", async (request, reply) => {
    try {
      headObject(request as any, reply, store);
    } catch (err) {
      handleError(err, reply, true);
    }
  });
}
