// The consumer loop: send, receive, delete. Each message costs the backend an
// insert, an in-flight update and a delete, which is the write mix a queue sees
// once producers and consumers keep pace with each other.
import {
  closedLoop,
  createQueue,
  deleteMessage,
  payload,
  receiveMessages,
  sendMessage,
  summaryWriter,
} from "./lib.js";

export const options = closedLoop();

const BODY = payload(Number(__ENV.MESSAGE_BYTES || 1024));

export function setup() {
  return { queueUrl: createQueue("bench-roundtrip") };
}

export default function ({ queueUrl }) {
  sendMessage(queueUrl, BODY);
  for (const msg of receiveMessages(queueUrl, 1)) {
    deleteMessage(queueUrl, msg.ReceiptHandle);
  }
}

export const handleSummary = summaryWriter;
