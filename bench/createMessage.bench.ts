import { Bench } from "tinybench";
import { SqsStore } from "../src/sqs/sqsStore.ts";
import { sendMessage } from "../src/sqs/actions/sendMessage.ts";
import { sqsQueueArn } from "../src/common/arnHelper.ts";

function createFifoStore(): SqsStore {
  const store = new SqsStore();
  store.host = "localhost:3000";
  const name = "test-queue.fifo";
  const arn = sqsQueueArn(name);
  const url = `http://localhost:3000/000000000000/${name}`;
  store.createQueue(name, url, arn, {
    FifoQueue: "true",
    ContentBasedDeduplication: "true",
  });
  return store;
}

async function run() {
  const bench = new Bench({ warmupIterations: 500 });

  // Benchmark the FIFO dedup path (sendMessage called with a duplicate message).
  // The current code calls createMessage twice in the dedup branch.
  bench.add("sendMessage FIFO dedup path (duplicate message)", () => {
    const store = createFifoStore();
    const queueUrl = "http://localhost:3000/000000000000/test-queue.fifo";

    // First send to populate dedup cache
    sendMessage(
      {
        QueueUrl: queueUrl,
        MessageBody: '{"orderId":"abc-123"}',
        MessageGroupId: "group-1",
      },
      store,
    );

    // Second send triggers dedup path (calls createMessage twice currently)
    sendMessage(
      {
        QueueUrl: queueUrl,
        MessageBody: '{"orderId":"abc-123"}',
        MessageGroupId: "group-1",
        MessageAttributes: {
          eventType: { DataType: "String", StringValue: "OrderCreated" },
          priority: { DataType: "Number", StringValue: "5" },
          source: { DataType: "String", StringValue: "checkout-service" },
        },
      },
      store,
    );
  });

  // Also benchmark the normal (non-dedup) FIFO path for comparison
  let normalCounter = 0;
  const normalStore = createFifoStore();
  const normalQueueUrl = "http://localhost:3000/000000000000/test-queue.fifo";

  bench.add("sendMessage FIFO normal path (unique messages)", () => {
    normalCounter++;
    sendMessage(
      {
        QueueUrl: normalQueueUrl,
        MessageBody: `{"orderId":"order-${normalCounter}"}`,
        MessageGroupId: "group-1",
        MessageDeduplicationId: `dedup-${normalCounter}`,
        MessageAttributes: {
          eventType: { DataType: "String", StringValue: "OrderCreated" },
          priority: { DataType: "Number", StringValue: "5" },
          source: { DataType: "String", StringValue: "checkout-service" },
        },
      },
      normalStore,
    );
  });

  await bench.run();

  console.log("\n--- sendMessage FIFO paths ---");
  console.table(bench.table());
}

run();
