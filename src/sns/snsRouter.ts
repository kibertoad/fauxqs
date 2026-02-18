import type { FastifyRequest, FastifyReply } from "fastify";
import { SnsError } from "../common/errors.js";
import { snsErrorResponse } from "../common/xml.js";
import type { SnsStore } from "./snsStore.js";
import type { SqsStore } from "../sqs/sqsStore.js";

export type SnsActionHandler = (
  params: Record<string, string>,
  snsStore: SnsStore,
  sqsStore: SqsStore,
  request: FastifyRequest,
) => string | Promise<string>;

export class SnsRouter {
  private handlers = new Map<string, SnsActionHandler>();

  constructor(
    private snsStore: SnsStore,
    private sqsStore: SqsStore,
  ) {}

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
      return snsErrorResponse(
        "InvalidAction",
        `Unknown action: ${action}`,
      );
    }

    try {
      const result = await handler(
        body,
        this.snsStore,
        this.sqsStore,
        request,
      );
      reply.header("content-type", "text/xml");
      return result;
    } catch (err) {
      if (err instanceof SnsError) {
        reply.status(err.statusCode);
        reply.header("content-type", "text/xml");
        return snsErrorResponse(
          err.code,
          err.message,
          err.senderFault ? "Sender" : "Receiver",
        );
      }
      throw err;
    }
  }
}
