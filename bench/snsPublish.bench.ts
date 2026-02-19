import { Bench } from "tinybench";
import { SqsStore } from "../src/sqs/sqsStore.ts";
import { SnsStore } from "../src/sns/snsStore.ts";
import { publish } from "../src/sns/actions/publish.ts";
import { sqsQueueArn } from "../src/common/arnHelper.ts";
import { snsTopicArn } from "../src/common/arnHelper.ts";

function setupStores(subCount: number, options: { rawDelivery: boolean; filterOnBody: boolean }) {
  const sqsStore = new SqsStore();
  sqsStore.host = "localhost:3000";
  const snsStore = new SnsStore();

  const topicArn = snsTopicArn("bench-topic");
  snsStore.createTopic("bench-topic");

  for (let i = 0; i < subCount; i++) {
    const queueName = `queue-${i}`;
    const queueArn = sqsQueueArn(queueName);
    const queueUrl = `http://localhost:3000/000000000000/${queueName}`;
    sqsStore.createQueue(queueName, queueUrl, queueArn);

    const attrs: Record<string, string> = {};
    if (options.rawDelivery) {
      attrs.RawMessageDelivery = "true";
    }
    if (options.filterOnBody) {
      attrs.FilterPolicy = JSON.stringify({ eventType: ["OrderCreated"] });
      attrs.FilterPolicyScope = "MessageBody";
    }

    snsStore.subscribe(topicArn, "sqs", queueArn, attrs);
  }

  return { sqsStore, snsStore, topicArn };
}

async function run() {
  const subCount = 10;
  const messageBody = JSON.stringify({
    eventType: "OrderCreated",
    orderId: "abc-123-def-456",
    amount: 99.99,
  });

  // Bench: publish with wrapped envelope (JSON.stringify per subscription)
  {
    const { sqsStore, snsStore, topicArn } = setupStores(subCount, {
      rawDelivery: false,
      filterOnBody: false,
    });

    const bench = new Bench({ warmupIterations: 500 });
    bench.add(`publish to ${subCount} subs (wrapped envelope, no filter)`, () => {
      publish(
        {
          TopicArn: topicArn,
          Message: messageBody,
        },
        snsStore,
        sqsStore,
      );
    });

    await bench.run();
    console.log("\n--- SNS publish: wrapped envelope (JSON.stringify per sub) ---");
    console.table(bench.table());
  }

  // Bench: publish with MessageBody filter policy (JSON.parse per subscription)
  {
    const { sqsStore, snsStore, topicArn } = setupStores(subCount, {
      rawDelivery: false,
      filterOnBody: true,
    });

    const bench = new Bench({ warmupIterations: 500 });
    bench.add(`publish to ${subCount} subs (body filter + wrapped envelope)`, () => {
      publish(
        {
          TopicArn: topicArn,
          Message: messageBody,
        },
        snsStore,
        sqsStore,
      );
    });

    await bench.run();
    console.log("\n--- SNS publish: body filter + wrapped envelope (JSON.parse + JSON.stringify per sub) ---");
    console.table(bench.table());
  }

  // Bench: publish with raw delivery + body filter (JSON.parse per sub, no stringify)
  {
    const { sqsStore, snsStore, topicArn } = setupStores(subCount, {
      rawDelivery: true,
      filterOnBody: true,
    });

    const bench = new Bench({ warmupIterations: 500 });
    bench.add(`publish to ${subCount} subs (body filter + raw delivery)`, () => {
      publish(
        {
          TopicArn: topicArn,
          Message: messageBody,
        },
        snsStore,
        sqsStore,
      );
    });

    await bench.run();
    console.log("\n--- SNS publish: body filter + raw delivery (JSON.parse per sub only) ---");
    console.table(bench.table());
  }
}

run();
