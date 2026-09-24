// Raw-HTTP clients for the three protocols fauxqs speaks. fauxqs does not verify
// SigV4, so k6 skips signing and the numbers measure the server rather than the
// load generator's crypto.
import http from "k6/http";
import { check, fail } from "k6";

export const BASE_URL = __ENV.FAUXQS_URL || "http://fauxqs:4566";
export const ACCOUNT_ARN_PREFIX = "arn:aws:sqs:us-east-1:000000000000";

const SQS_HEADERS = { "Content-Type": "application/x-amz-json-1.0" };
const SNS_HEADERS = { "Content-Type": "application/x-www-form-urlencoded" };

function sqs(action, body, tags) {
  const res = http.post(`${BASE_URL}/`, JSON.stringify(body), {
    headers: { ...SQS_HEADERS, "X-Amz-Target": `AmazonSQS.${action}` },
    tags: { op: tags ?? action },
  });
  if (!check(res, { [`${action} 200`]: (r) => r.status === 200 })) {
    fail(`${action} failed: ${res.status} ${res.body}`);
  }
  return res.json();
}

export function createQueue(name, attributes) {
  return sqs("CreateQueue", { QueueName: name, Attributes: attributes ?? {} }).QueueUrl;
}

export function sendMessage(queueUrl, body) {
  return sqs("SendMessage", { QueueUrl: queueUrl, MessageBody: body });
}

export function receiveMessages(queueUrl, max) {
  return sqs("ReceiveMessage", { QueueUrl: queueUrl, MaxNumberOfMessages: max }).Messages ?? [];
}

export function deleteMessage(queueUrl, receiptHandle) {
  return sqs("DeleteMessage", { QueueUrl: queueUrl, ReceiptHandle: receiptHandle });
}

function sns(params, op) {
  const res = http.post(`${BASE_URL}/`, params, {
    headers: SNS_HEADERS,
    tags: { op: op ?? params.Action },
  });
  if (!check(res, { [`${params.Action} 200`]: (r) => r.status === 200 })) {
    fail(`${params.Action} failed: ${res.status} ${res.body}`);
  }
  return res.body;
}

export function createTopic(name) {
  const xml = sns({ Action: "CreateTopic", Name: name });
  return /<TopicArn>([^<]+)<\/TopicArn>/.exec(xml)[1];
}

export function subscribeQueue(topicArn, queueName) {
  sns({
    Action: "Subscribe",
    TopicArn: topicArn,
    Protocol: "sqs",
    Endpoint: `${ACCOUNT_ARN_PREFIX}:${queueName}`,
    "Attributes.entry.1.key": "RawMessageDelivery",
    "Attributes.entry.1.value": "true",
  });
}

export function publish(topicArn, message) {
  return sns({ Action: "Publish", TopicArn: topicArn, Message: message });
}

function s3(method, path, body, op) {
  const res = http.request(method, `${BASE_URL}/${path}`, body ?? null, {
    headers: body ? { "Content-Type": "application/octet-stream" } : {},
    tags: { op },
    responseType: method === "GET" ? "binary" : "text",
  });
  if (!check(res, { [`${op} 2xx`]: (r) => r.status >= 200 && r.status < 300 })) {
    fail(`${op} ${path} failed: ${res.status}`);
  }
  return res;
}

export function createBucket(name) {
  return s3("PUT", name, undefined, "CreateBucket");
}

export function putObject(bucket, key, body) {
  return s3("PUT", `${bucket}/${key}`, body, "PutObject");
}

export function getObject(bucket, key) {
  return s3("GET", `${bucket}/${key}`, undefined, "GetObject");
}

/** A closed-loop load shape: a fixed number of VUs, each issuing its next request as soon as the last returns. */
export function closedLoop() {
  return {
    scenarios: {
      load: {
        executor: "constant-vus",
        vus: Number(__ENV.VUS || 16),
        duration: __ENV.DURATION || "30s",
      },
    },
    // Per-operation latency breakdowns in the summary.
    thresholds: {
      "http_req_duration{op:SendMessage}": ["max>=0"],
      "http_req_duration{op:ReceiveMessage}": ["max>=0"],
      "http_req_duration{op:DeleteMessage}": ["max>=0"],
      "http_req_duration{op:Publish}": ["max>=0"],
      "http_req_duration{op:PutObject}": ["max>=0"],
      "http_req_duration{op:GetObject}": ["max>=0"],
    },
    summaryTrendStats: ["avg", "med", "p(95)", "p(99)", "max"],
  };
}

/** Writes the k6 summary where the runner collects it, keyed by the run id. */
export function summaryWriter(data) {
  const out = __ENV.SUMMARY_FILE;
  return out ? { [out]: JSON.stringify(data, null, 2), stdout: "" } : {};
}

/** A payload of `bytes` bytes, built once per VU. */
export function payload(bytes) {
  return "x".repeat(bytes);
}
