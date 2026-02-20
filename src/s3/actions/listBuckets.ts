import type { FastifyReply } from "fastify";
import type { Bucket, Owner } from "@aws-sdk/client-s3";
import { escapeXml } from "../../common/xml.ts";
import type { S3Store } from "../s3Store.ts";

export function listBuckets(reply: FastifyReply, store: S3Store): void {
  const buckets = store.listBuckets();

  const owner = { ID: "000000000000", DisplayName: "local" } satisfies Owner;

  const bucketsData = buckets.map(
    (b) => ({ Name: b.name, CreationDate: b.creationDate }) satisfies Bucket,
  );

  const bucketsXml = bucketsData
    .map(
      (b) =>
        `<Bucket>` +
        `<Name>${escapeXml(b.Name!)}</Name>` +
        `<CreationDate>${b.CreationDate!.toISOString()}</CreationDate>` +
        `</Bucket>`,
    )
    .join("\n      ");

  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`,
    `  <Owner>`,
    `    <ID>${owner.ID}</ID>`,
    `    <DisplayName>${owner.DisplayName}</DisplayName>`,
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
