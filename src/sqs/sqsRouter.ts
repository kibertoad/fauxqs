import type { FastifyRequest, FastifyReply } from "fastify";
import { SqsError } from "../common/errors.ts";
import type { SqsStore } from "./sqsStore.ts";

export type SqsActionHandler = (
  body: Record<string, unknown>,
  store: SqsStore,
  request: FastifyRequest,
) => unknown | Promise<unknown>;

export class SqsRouter {
  private handlers = new Map<string, SqsActionHandler>();
  private store: SqsStore;

  constructor(store: SqsStore) {
    this.store = store;
  }

  register(action: string, handler: SqsActionHandler): void {
    this.handlers.set(action, handler);
  }

  async handle(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const target = request.headers["x-amz-target"] as string | undefined;
    if (!target) {
      reply.status(400);
      return {
        __type: "com.amazonaws.sqs#MissingAction",
        message: "Missing X-Amz-Target header",
      };
    }

    const action = target.replace("AmazonSQS.", "");
    const handler = this.handlers.get(action);

    if (!handler) {
      reply.status(400);
      return {
        __type: "com.amazonaws.sqs#InvalidAction",
        message: `Unknown action: ${action}`,
      };
    }

    try {
      const result = await handler(request.body as Record<string, unknown>, this.store, request);
      reply.header("content-type", "application/x-amz-json-1.0");
      return result;
    } catch (err) {
      if (err instanceof SqsError) {
        reply.status(err.statusCode);
        reply.header("content-type", "application/x-amz-json-1.0");
        reply.header("x-amzn-query-error", err.queryErrorHeader);
        return err.toJSON();
      }
      throw err;
    }
  }
}
