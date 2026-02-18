import Fastify from "fastify";
import { SqsStore } from "./sqs/sqsStore.js";
import { SqsRouter } from "./sqs/sqsRouter.js";
import { SnsStore } from "./sns/snsStore.js";
import { SnsRouter } from "./sns/snsRouter.js";
import { createQueue } from "./sqs/actions/createQueue.js";
import { deleteQueue } from "./sqs/actions/deleteQueue.js";
import { getQueueUrl } from "./sqs/actions/getQueueUrl.js";
import { listQueues } from "./sqs/actions/listQueues.js";
import { getQueueAttributes } from "./sqs/actions/getQueueAttributes.js";
import { setQueueAttributes } from "./sqs/actions/setQueueAttributes.js";
import { purgeQueue } from "./sqs/actions/purgeQueue.js";
import { sendMessage } from "./sqs/actions/sendMessage.js";
import { receiveMessage } from "./sqs/actions/receiveMessage.js";
import { deleteMessage } from "./sqs/actions/deleteMessage.js";
import { sendMessageBatch } from "./sqs/actions/sendMessageBatch.js";
import { deleteMessageBatch } from "./sqs/actions/deleteMessageBatch.js";
import { changeMessageVisibility } from "./sqs/actions/changeMessageVisibility.js";
import { changeMessageVisibilityBatch } from "./sqs/actions/changeMessageVisibilityBatch.js";
import { tagQueue } from "./sqs/actions/tagQueue.js";
import { untagQueue } from "./sqs/actions/untagQueue.js";
import { listQueueTags } from "./sqs/actions/listQueueTags.js";
import { createTopic } from "./sns/actions/createTopic.js";
import { deleteTopic } from "./sns/actions/deleteTopic.js";
import { listTopics } from "./sns/actions/listTopics.js";
import { getTopicAttributes } from "./sns/actions/getTopicAttributes.js";
import { setTopicAttributes } from "./sns/actions/setTopicAttributes.js";
import { subscribe } from "./sns/actions/subscribe.js";
import { unsubscribe } from "./sns/actions/unsubscribe.js";
import { confirmSubscription } from "./sns/actions/confirmSubscription.js";
import { listSubscriptions, listSubscriptionsByTopic } from "./sns/actions/listSubscriptions.js";
import { getSubscriptionAttributes } from "./sns/actions/getSubscriptionAttributes.js";
import { setSubscriptionAttributes } from "./sns/actions/setSubscriptionAttributes.js";
import { publish, publishBatch } from "./sns/actions/publish.js";
import { tagResource, untagResource, listTagsForResource } from "./sns/actions/tagResource.js";
import { S3Store } from "./s3/s3Store.js";
import { registerS3Routes } from "./s3/s3Router.js";

export function buildApp(options?: { logger?: boolean; host?: string; defaultRegion?: string }) {
  const app = Fastify({
    logger: options?.logger ?? true,
    bodyLimit: 2 * 1_048_576, // 2 MiB — allow our handlers to validate message size
    forceCloseConnections: true,
  });

  const sqsStore = new SqsStore();
  if (options?.host) {
    sqsStore.host = options.host;
  }
  if (options?.defaultRegion) {
    sqsStore.region = options.defaultRegion;
  }
  const snsStore = new SnsStore();
  if (options?.defaultRegion) {
    snsStore.region = options.defaultRegion;
  }

  const sqsRouter = new SqsRouter(sqsStore);
  sqsRouter.register("CreateQueue", createQueue);
  sqsRouter.register("DeleteQueue", deleteQueue);
  sqsRouter.register("GetQueueUrl", getQueueUrl);
  sqsRouter.register("ListQueues", listQueues);
  sqsRouter.register("GetQueueAttributes", getQueueAttributes);
  sqsRouter.register("SetQueueAttributes", setQueueAttributes);
  sqsRouter.register("PurgeQueue", purgeQueue);
  sqsRouter.register("SendMessage", sendMessage);
  sqsRouter.register("ReceiveMessage", receiveMessage);
  sqsRouter.register("DeleteMessage", deleteMessage);
  sqsRouter.register("SendMessageBatch", sendMessageBatch);
  sqsRouter.register("DeleteMessageBatch", deleteMessageBatch);
  sqsRouter.register("ChangeMessageVisibility", changeMessageVisibility);
  sqsRouter.register("ChangeMessageVisibilityBatch", changeMessageVisibilityBatch);
  sqsRouter.register("TagQueue", tagQueue);
  sqsRouter.register("UntagQueue", untagQueue);
  sqsRouter.register("ListQueueTags", listQueueTags);

  const snsRouter = new SnsRouter(snsStore, sqsStore);
  snsRouter.register("CreateTopic", createTopic);
  snsRouter.register("DeleteTopic", deleteTopic);
  snsRouter.register("ListTopics", listTopics);
  snsRouter.register("GetTopicAttributes", getTopicAttributes);
  snsRouter.register("SetTopicAttributes", setTopicAttributes);
  snsRouter.register("Subscribe", subscribe);
  snsRouter.register("Unsubscribe", unsubscribe);
  snsRouter.register("ConfirmSubscription", confirmSubscription);
  snsRouter.register("ListSubscriptions", listSubscriptions);
  snsRouter.register("ListSubscriptionsByTopic", listSubscriptionsByTopic);
  snsRouter.register("GetSubscriptionAttributes", getSubscriptionAttributes);
  snsRouter.register("SetSubscriptionAttributes", setSubscriptionAttributes);
  snsRouter.register("Publish", publish);
  snsRouter.register("PublishBatch", publishBatch);
  snsRouter.register("TagResource", tagResource);
  snsRouter.register("UntagResource", untagResource);
  snsRouter.register("ListTagsForResource", listTagsForResource);

  // Parse AWS JSON protocol (SQS)
  app.addContentTypeParser(
    "application/x-amz-json-1.0",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error);
      }
    },
  );

  // Parse Query protocol (SNS)
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        const result: Record<string, string> = {};
        for (const [key, value] of new URLSearchParams(body as string)) {
          result[key] = value;
        }
        done(null, result);
      } catch (err) {
        done(err as Error);
      }
    },
  );

  // Wildcard parser for S3 (binary bodies)
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  const s3Store = new S3Store();
  registerS3Routes(app, s3Store);

  app.addHook("preClose", () => {
    sqsStore.shutdown();
  });

  app.get("/health", async () => {
    return { status: "ok" };
  });

  app.post("/", async (request, reply) => {
    const contentType = request.headers["content-type"] ?? "";

    if (contentType.includes("application/x-amz-json-1.0")) {
      return sqsRouter.handle(request, reply);
    }

    if (contentType.includes("application/x-www-form-urlencoded")) {
      return snsRouter.handle(request, reply);
    }

    reply.status(400);
    return { error: "Unsupported content type" };
  });

  return app;
}

export interface FauxqsServer {
  readonly port: number;
  readonly address: string;
  stop(): Promise<void>;
}

export async function startFauxqs(options?: {
  port?: number;
  logger?: boolean;
  host?: string;
  /** Fallback region used only when the region cannot be resolved from request Authorization headers. Defaults to "us-east-1". */
  defaultRegion?: string;
}): Promise<FauxqsServer> {
  const port = options?.port ?? parseInt(process.env.FAUXQS_PORT ?? "4566");
  const app = buildApp({
    logger: options?.logger ?? true,
    host: options?.host,
    defaultRegion: options?.defaultRegion,
  });
  const listenAddress = await app.listen({ port, host: "127.0.0.1" });
  const url = new URL(listenAddress);

  return {
    get port() {
      return parseInt(url.port);
    },
    get address() {
      return listenAddress;
    },
    stop() {
      return app.close();
    },
  };
}
