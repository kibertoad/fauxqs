import type { FastifyReply } from "fastify";
import { escapeXml } from "../../common/xml.ts";
import type { S3Store } from "../s3Store.ts";

export function listBuckets(reply: FastifyReply, store: S3Store): void {
  const buckets = store.listBuckets();

  const bucketsXml = buckets
    .map(
      (b) =>
        `<Bucket>` +
        `<Name>${escapeXml(b.name)}</Name>` +
        `<CreationDate>${b.creationDate.toISOString()}</CreationDate>` +
        `</Bucket>`,
    )
    .join("\n      ");

  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`,
    `  <Owner>`,
    `    <ID>000000000000</ID>`,
    `    <DisplayName>local</DisplayName>`,
    `  </Owner>`,
    `  <Buckets>`,
    bucketsXml ? `      ${bucketsXml}` : "",
    `  </Buckets>`,
    `</ListAllMyBucketsResult>`,
  ]
    .filter(Boolean)
    .join("\n");

  reply.header("content-type", "application/xml");
  reply.status(200).send(xml);
}
