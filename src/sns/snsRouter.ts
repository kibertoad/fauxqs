import type { FastifyRequest, FastifyReply } from "fastify";
import { SnsError } from "../common/errors.ts";
import { regionFromAuth } from "../common/types.ts";
import { snsErrorResponse } from "../common/xml.ts";
import type { SnsStore } from "./snsStore.ts";
import type { SqsStore } from "../sqs/sqsStore.ts";

export type SnsActionHandler = (
  params: Record<string, string>,
  snsStore: SnsStore,
  sqsStore: SqsStore,
  request: FastifyRequest,
) => string | Promise<string>;

export class SnsRouter {
  private handlers = new Map<string, SnsActionHandler>();
  private snsStore: SnsStore;
  private sqsStore: SqsStore;

  constructor(snsStore: SnsStore, sqsStore: SqsStore) {
    this.snsStore = snsStore;
    this.sqsStore = sqsStore;
  }

  register(action: string, handler: SnsActionHandler): void {
    this.handlers.set(action, handler);
  }

  async handle(request: FastifyRequest, reply: FastifyReply): Promise<string> {
    const body = request.body as Record<string, string>;
    const action = body.Action;

    if (!action) {
      reply.status(400);
      reply.header("content-type", "text/xml");
      return snsErrorResponse("MissingAction", "Missing Action parameter");
    }

    const handler = this.handlers.get(action);

    if (!handler) {
      reply.status(400);
      reply.header("content-type", "text/xml");
      return snsErrorResponse("InvalidAction", `Unknown action: ${action}`);
    }

    try {
      if (!this.snsStore.region) {
        this.snsStore.region = regionFromAuth(request.headers.authorization);
      }
      const result = await handler(body, this.snsStore, this.sqsStore, request);
      reply.header("content-type", "text/xml");
      return result;
    } catch (err) {
      if (err instanceof SnsError) {
        reply.status(err.statusCode);
        reply.header("content-type", "text/xml");
        return snsErrorResponse(err.code, err.message, err.senderFault ? "Sender" : "Receiver");
      }
      throw err;
    }
  }
}
