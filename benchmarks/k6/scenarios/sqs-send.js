// Write path only: every iteration is one SendMessage, so each request is one
// insert into the persistence backend and nothing is ever read back.
import { closedLoop, createQueue, payload, sendMessage, summaryWriter } from "./lib.js";

export const options = closedLoop();

const BODY = payload(Number(__ENV.MESSAGE_BYTES || 1024));

export function setup() {
  return { queueUrl: createQueue("bench-send") };
}

export default function ({ queueUrl }) {
  sendMessage(queueUrl, BODY);
}

export const handleSummary = summaryWriter;
