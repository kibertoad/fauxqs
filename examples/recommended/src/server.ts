/**
 * Dev entrypoint — starts the app against a Docker fauxqs instance.
 *
 * Run with: npm run dev
 * Requires: docker compose up -d (see docker-compose.yml)
 *
 * Environment variables are loaded from .env.dev via --env-file.
 */
import { buildApp } from "./app.ts";

const app = buildApp({
  awsEndpoint: process.env.AWS_ENDPOINT!,
  s3Endpoint: process.env.S3_ENDPOINT!,
  bucket: process.env.S3_BUCKET!,
  queueUrl: process.env.SQS_QUEUE_URL!,
  topicArn: process.env.SNS_TOPIC_ARN!,
});

await app.listen({ port: 3000 });
console.log("App listening on http://localhost:3000");
