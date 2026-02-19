import { Bench } from "tinybench";
import { SqsStore } from "../src/sqs/sqsStore.ts";
import { sqsQueueArn } from "../src/common/arnHelper.ts";

function populateStore(n: number): { store: SqsStore; lastArn: string } {
  const store = new SqsStore();
  store.host = "localhost:3000";
  let lastArn = "";
  for (let i = 0; i < n; i++) {
    const name = `queue-${i}`;
    const arn = sqsQueueArn(name);
    const url = `http://localhost:3000/000000000000/${name}`;
    store.createQueue(name, url, arn);
    lastArn = arn;
  }
  return { store, lastArn };
}

async function run() {
  for (const size of [10, 100, 500]) {
    const { store, lastArn } = populateStore(size);

    const bench = new Bench({ warmupIterations: 1000 });

    bench.add(`getQueueByArn (${size} queues, worst-case)`, () => {
      store.getQueueByArn(lastArn);
    });

    await bench.run();

    console.log(`\n--- getQueueByArn with ${size} queues ---`);
    console.table(bench.table());
  }
}

run();
