// One Publish fanned out to SUBSCRIBERS queues. Each publish is one request to
// the client and SUBSCRIBERS inserts to the backend, so this is where per-write
// latency multiplies.
import {
  closedLoop,
  createQueue,
  createTopic,
  payload,
  publish,
  subscribeQueue,
  summaryWriter,
} from "./lib.js";

export const options = closedLoop();

const BODY = payload(Number(__ENV.MESSAGE_BYTES || 1024));
const SUBSCRIBERS = Number(__ENV.SUBSCRIBERS || 3);

export function setup() {
  const topicArn = createTopic("bench-fanout");
  for (let i = 0; i < SUBSCRIBERS; i++) {
    const name = `bench-fanout-${i}`;
    createQueue(name);
    subscribeQueue(topicArn, name);
  }
  return { topicArn };
}

export default function ({ topicArn }) {
  publish(topicArn, BODY);
}

export const handleSummary = summaryWriter;
