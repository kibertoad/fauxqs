import Fastify from "fastify";
import { SqsStore } from "./sqs/sqsStore.ts";
import { SqsRouter } from "./sqs/sqsRouter.ts";
import { SnsStore } from "./sns/snsStore.ts";
import { SnsRouter } from "./sns/snsRouter.ts";
import { createQueue } from "./sqs/actions/createQueue.ts";
import { deleteQueue } from "./sqs/actions/deleteQueue.ts";
import { getQueueUrl } from "./sqs/actions/getQueueUrl.ts";
import { listQueues } from "./sqs/actions/listQueues.ts";
import { getQueueAttributes } from "./sqs/actions/getQueueAttributes.ts";
import { setQueueAttributes } from "./sqs/actions/setQueueAttributes.ts";
import { purgeQueue } from "./sqs/actions/purgeQueue.ts";
import { sendMessage } from "./sqs/actions/sendMessage.ts";
import { receiveMessage } from "./sqs/actions/receiveMessage.ts";
import { deleteMessage } from "./sqs/actions/deleteMessage.ts";
import { sendMessageBatch } from "./sqs/actions/sendMessageBatch.ts";
import { deleteMessageBatch } from "./sqs/actions/deleteMessageBatch.ts";
import { changeMessageVisibility } from "./sqs/actions/changeMessageVisibility.ts";
import { changeMessageVisibilityBatch } from "./sqs/actions/changeMessageVisibilityBatch.ts";
import { tagQueue } from "./sqs/actions/tagQueue.ts";
import { untagQueue } from "./sqs/actions/untagQueue.ts";
import { listQueueTags } from "./sqs/actions/listQueueTags.ts";
import { createTopic } from "./sns/actions/createTopic.ts";
import { deleteTopic } from "./sns/actions/deleteTopic.ts";
import { listTopics } from "./sns/actions/listTopics.ts";
import { getTopicAttributes } from "./sns/actions/getTopicAttributes.ts";
import { setTopicAttributes } from "./sns/actions/setTopicAttributes.ts";
import { subscribe } from "./sns/actions/subscribe.ts";
import { unsubscribe } from "./sns/actions/unsubscribe.ts";
import { confirmSubscription } from "./sns/actions/confirmSubscription.ts";
import { listSubscriptions, listSubscriptionsByTopic } from "./sns/actions/listSubscriptions.ts";
import { getSubscriptionAttributes } from "./sns/actions/getSubscriptionAttributes.ts";
import { setSubscriptionAttributes } from "./sns/actions/setSubscriptionAttributes.ts";
import { publish, publishBatch } from "./sns/actions/publish.ts";
import { tagResource, untagResource, listTagsForResource } from "./sns/actions/tagResource.ts";
import { S3Store } from "./s3/s3Store.ts";
import { registerS3Routes } from "./s3/s3Router.ts";
import { getCallerIdentity } from "./sts/getCallerIdentity.ts";
import { sqsQueueArn, snsTopicArn } from "./common/arnHelper.ts";
import { DEFAULT_ACCOUNT_ID, DEFAULT_REGION } from "./common/types.ts";
import { loadInitConfig, applyInitConfig } from "./initConfig.ts";
export type { FauxqsInitConfig } from "./initConfig.ts";
export { createLocalhostHandler, interceptLocalhostDns } from "./localhost.ts";

export interface BuildAppOptions {
  logger?: boolean;
  host?: string;
  defaultRegion?: string;
  stores?: { sqsStore: SqsStore; snsStore: SnsStore; s3Store: S3Store };
}

export function buildApp(options?: BuildAppOptions) {
  const app = Fastify({
    logger: options?.logger ?? true,
    bodyLimit: 2 * 1_048_576, // 2 MiB — allow our handlers to validate message size
    forceCloseConnections: true,
    // Support S3 virtual-hosted-style requests: bucket name in Host header (e.g. bucket.localhost:port)
    // Rewrites to path-style (e.g. /bucket/key) before routing.
    rewriteUrl: (req) => {
      const host = req.headers.host ?? "";
      const hostname = host.split(":")[0];
      // No rewrite for plain hostnames (localhost) or IP addresses
      if (!hostname.includes(".") || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
        return req.url ?? "/";
      }
      const dotIndex = hostname.indexOf(".");
      const bucket = hostname.substring(0, dotIndex);
      return `/${bucket}${req.url ?? "/"}`;
    },
  });

  const sqsStore = options?.stores?.sqsStore ?? new SqsStore();
  if (options?.host) {
    sqsStore.host = options.host;
  }
  if (options?.defaultRegion) {
    sqsStore.region = options.defaultRegion;
  }
  const snsStore = options?.stores?.snsStore ?? new SnsStore();
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

  const s3Store = options?.stores?.s3Store ?? new S3Store();
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
      const body = request.body as Record<string, string>;
      if (body.Action === "GetCallerIdentity") {
        reply.header("content-type", "text/xml");
        return getCallerIdentity();
      }
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

  createQueue(
    name: string,
    options?: { attributes?: Record<string, string>; tags?: Record<string, string> },
  ): void;
  createTopic(
    name: string,
    options?: { attributes?: Record<string, string>; tags?: Record<string, string> },
  ): void;
  subscribe(options: { topic: string; queue: string; attributes?: Record<string, string> }): void;
  createBucket(name: string): void;
  setup(config: import("./initConfig.ts").FauxqsInitConfig): void;
  purgeAll(): void;
}

export async function startFauxqs(options?: {
  port?: number;
  logger?: boolean;
  host?: string;
  /** Fallback region used only when the region cannot be resolved from request Authorization headers. Defaults to "us-east-1". */
  defaultRegion?: string;
  /** Path to a JSON init config file, or an inline config object. Resources are created after the server starts. */
  init?: string | import("./initConfig.ts").FauxqsInitConfig;
}): Promise<FauxqsServer> {
  const port = options?.port ?? parseInt(process.env.FAUXQS_PORT ?? "4566");
  const host = options?.host ?? process.env.FAUXQS_HOST;
  const defaultRegion = options?.defaultRegion ?? process.env.FAUXQS_DEFAULT_REGION;
  const loggerEnv = process.env.FAUXQS_LOGGER;
  const logger = options?.logger ?? (loggerEnv !== undefined ? loggerEnv !== "false" : true);
  const init = options?.init ?? process.env.FAUXQS_INIT;

  const sqsStore = new SqsStore();
  const snsStore = new SnsStore();
  const s3Store = new S3Store();

  const app = buildApp({
    logger,
    host,
    defaultRegion,
    stores: { sqsStore, snsStore, s3Store },
  });

  const listenAddress = await app.listen({ port, host: "0.0.0.0" });
  const url = new URL(listenAddress);
  const actualPort = parseInt(url.port);
  const region = defaultRegion ?? DEFAULT_REGION;

  function makeQueueUrl(name: string): string {
    if (host) {
      return `http://sqs.${region}.${host}:${actualPort}/${DEFAULT_ACCOUNT_ID}/${name}`;
    }
    return `http://127.0.0.1:${actualPort}/${DEFAULT_ACCOUNT_ID}/${name}`;
  }

  const server: FauxqsServer = {
    get port() {
      return actualPort;
    },
    get address() {
      return listenAddress;
    },
    stop() {
      return app.close();
    },
    createQueue(name, opts) {
      const arn = sqsQueueArn(name, region);
      const queueUrl = makeQueueUrl(name);
      sqsStore.createQueue(name, queueUrl, arn, opts?.attributes, opts?.tags);
    },
    createTopic(name, opts) {
      snsStore.createTopic(name, opts?.attributes, opts?.tags);
    },
    subscribe(opts) {
      const topicArn = snsTopicArn(opts.topic, region);
      const queueArn = sqsQueueArn(opts.queue, region);
      snsStore.subscribe(topicArn, "sqs", queueArn, opts.attributes);
    },
    createBucket(name) {
      s3Store.createBucket(name);
    },
    setup(config) {
      applyInitConfig(config, sqsStore, snsStore, s3Store, {
        host,
        port: actualPort,
        region,
      });
    },
    purgeAll() {
      sqsStore.purgeAll();
      snsStore.purgeAll();
      s3Store.purgeAll();
    },
  };

  // Apply init config if provided
  if (init) {
    const config = typeof init === "string" ? loadInitConfig(init) : init;
    server.setup(config);
  }

  return server;
}
