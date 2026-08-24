import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import {
  CreateBucketCommand,
  CopyObjectCommand,
  GetObjectAttributesCommand,
  HeadObjectCommand,
  ChecksumMode,
  ObjectAttributes,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";
import { computeChecksum } from "../../src/s3/checksum.js";
import type { ChecksumAlgorithm } from "../../src/s3/s3Types.js";

/**
 * The five algorithms AWS added on 2026-04-22. The JS SDK models them in its
 * response shapes but its request-side flexible-checksums middleware still
 * only computes the original five, so uploads here go over raw HTTP with an
 * explicit `x-amz-checksum-*` header — exactly what a CRT-based or updated SDK
 * sends on the wire.
 */
const NEW_ALGORITHMS = ["SHA512", "MD5", "XXHASH64", "XXHASH3", "XXHASH128"] as const;

const checksumHeader = (algorithm: ChecksumAlgorithm) =>
  `x-amz-checksum-${algorithm.toLowerCase()}`;

describe("S3 checksum algorithms added in 2026", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;
  let baseUrl: string;
  const bucket = "new-checksum-bucket";

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
    baseUrl = `http://127.0.0.1:${server.port}`;
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  const putWithChecksum = (key: string, body: string | Buffer, algorithm: ChecksumAlgorithm) =>
    fetch(`${baseUrl}/${bucket}/${key}`, {
      method: "PUT",
      headers: { [checksumHeader(algorithm)]: computeChecksum(algorithm, Buffer.from(body)) },
      body,
    });

  describe.each(NEW_ALGORITHMS)("%s", (algorithm) => {
    const key = `roundtrip-${algorithm.toLowerCase()}.txt`;
    const body = `payload for ${algorithm}`;
    const expected = computeChecksum(algorithm, Buffer.from(body));
    // ChecksumSHA512, ChecksumMD5, ChecksumXXHASH64, ...
    const member = `Checksum${algorithm}` as const;

    it("PutObject echoes the checksum it stored", async () => {
      const response = await putWithChecksum(key, body, algorithm);
      expect(response.status).toBe(200);
      expect(response.headers.get(checksumHeader(algorithm))).toBe(expected);
      expect(response.headers.get("x-amz-checksum-type")).toBe("FULL_OBJECT");
      await response.text();
    });

    // Read back over raw HTTP: the JS SDK's response-side checksum validation
    // still rejects SHA512 and the xxHash algorithms as "not supported by the
    // client", so GetObject through the SDK cannot exercise them yet.
    it("GetObject returns it with x-amz-checksum-mode: ENABLED", async () => {
      await putWithChecksum(key, body, algorithm).then((r) => r.text());

      const response = await fetch(`${baseUrl}/${bucket}/${key}`, {
        headers: { "x-amz-checksum-mode": "ENABLED" },
      });
      expect(response.headers.get(checksumHeader(algorithm))).toBe(expected);
      expect(response.headers.get("x-amz-checksum-type")).toBe("FULL_OBJECT");
      await response.text();
    });

    it("GetObject omits it without the mode header", async () => {
      await putWithChecksum(key, body, algorithm).then((r) => r.text());

      const response = await fetch(`${baseUrl}/${bucket}/${key}`);
      expect(response.headers.get(checksumHeader(algorithm))).toBeNull();
      await response.text();
    });

    it("HeadObject returns it with x-amz-checksum-mode: ENABLED", async () => {
      await putWithChecksum(key, body, algorithm).then((r) => r.text());

      const result = await s3.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: ChecksumMode.ENABLED }),
      );
      expect(result[member]).toBe(expected);
    });

    it("GetObjectAttributes reports it under Checksum", async () => {
      await putWithChecksum(key, body, algorithm).then((r) => r.text());

      const result = await s3.send(
        new GetObjectAttributesCommand({
          Bucket: bucket,
          Key: key,
          ObjectAttributes: [ObjectAttributes.CHECKSUM],
        }),
      );
      expect(result.Checksum?.[member]).toBe(expected);
    });

    it("CopyObject preserves it", async () => {
      const src = `copy-src-${algorithm.toLowerCase()}.txt`;
      const dst = `copy-dst-${algorithm.toLowerCase()}.txt`;
      await putWithChecksum(src, body, algorithm).then((r) => r.text());

      await s3.send(
        new CopyObjectCommand({ Bucket: bucket, Key: dst, CopySource: `${bucket}/${src}` }),
      );

      const response = await fetch(`${baseUrl}/${bucket}/${dst}`, {
        headers: { "x-amz-checksum-mode": "ENABLED" },
      });
      expect(response.headers.get(checksumHeader(algorithm))).toBe(expected);
      await response.text();
    });
  });

  it("computes SHA512 identically to node:crypto", async () => {
    const body = "sha512 interop";
    const response = await putWithChecksum("sha512-interop.txt", body, "SHA512");
    expect(response.headers.get("x-amz-checksum-sha512")).toBe(
      createHash("sha512").update(body).digest("base64"),
    );
    await response.text();
  });

  it("treats x-amz-checksum-md5 as a checksum header, not Content-MD5", async () => {
    const body = "md5 is a flexible checksum algorithm now";
    // Content-MD5 is the legacy integrity header and must not be mistaken for
    // the flexible-checksum MD5 algorithm added in 2026.
    const response = await fetch(`${baseUrl}/${bucket}/legacy-content-md5.txt`, {
      method: "PUT",
      headers: { "content-md5": createHash("md5").update(body).digest("base64") },
      body,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-amz-checksum-md5")).toBeNull();
    await response.text();
  });

  describe("multipart uploads", () => {
    const createUpload = async (key: string, algorithm: ChecksumAlgorithm) => {
      const response = await fetch(`${baseUrl}/${bucket}/${key}?uploads`, {
        method: "POST",
        headers: { "x-amz-checksum-algorithm": algorithm },
      });
      const xml = await response.text();
      expect(response.headers.get("x-amz-checksum-algorithm")).toBe(algorithm);
      return xml.match(/<UploadId>([^<]+)<\/UploadId>/)![1];
    };

    const uploadPart = async (
      key: string,
      uploadId: string,
      partNumber: number,
      body: Buffer,
      algorithm: ChecksumAlgorithm,
    ) => {
      const response = await fetch(
        `${baseUrl}/${bucket}/${key}?partNumber=${partNumber}&uploadId=${uploadId}`,
        {
          method: "PUT",
          headers: { [checksumHeader(algorithm)]: computeChecksum(algorithm, body) },
          body,
        },
      );
      await response.text();
      return {
        etag: response.headers.get("etag")!,
        checksum: response.headers.get(checksumHeader(algorithm))!,
      };
    };

    const complete = async (
      key: string,
      uploadId: string,
      parts: { etag: string; partNumber: number }[],
    ) => {
      const body = [
        "<CompleteMultipartUpload>",
        ...parts.map(
          (p) =>
            `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`,
        ),
        "</CompleteMultipartUpload>",
      ].join("");
      const response = await fetch(`${baseUrl}/${bucket}/${key}?uploadId=${uploadId}`, {
        method: "POST",
        body,
      });
      return { status: response.status, xml: await response.text() };
    };

    it.each(["SHA512", "XXHASH64", "XXHASH128"] as const)(
      "%s multipart upload produces a composite checksum over the part checksums",
      async (algorithm) => {
        const key = `multipart-${algorithm.toLowerCase()}`;
        const part1 = Buffer.alloc(5 * 1024 * 1024, "m");
        const part2 = Buffer.from(`last part for ${algorithm}`);

        const uploadId = await createUpload(key, algorithm);
        const uploaded1 = await uploadPart(key, uploadId, 1, part1, algorithm);
        const uploaded2 = await uploadPart(key, uploadId, 2, part2, algorithm);
        expect(uploaded1.checksum).toBe(computeChecksum(algorithm, part1));
        expect(uploaded2.checksum).toBe(computeChecksum(algorithm, part2));

        const { status, xml } = await complete(key, uploadId, [
          { partNumber: 1, etag: uploaded1.etag },
          { partNumber: 2, etag: uploaded2.etag },
        ]);
        expect(status).toBe(200);

        // A composite checksum is the checksum of the concatenated raw part
        // checksums, suffixed with the part count.
        const expected = `${computeChecksum(
          algorithm,
          Buffer.concat([uploaded1.checksum, uploaded2.checksum].map((c) => Buffer.from(c, "base64"))),
        )}-2`;
        expect(xml).toContain(`<Checksum${algorithm}>${expected}</Checksum${algorithm}>`);
        expect(xml).toContain("<ChecksumType>COMPOSITE</ChecksumType>");

        const attributes = await s3.send(
          new GetObjectAttributesCommand({
            Bucket: bucket,
            Key: key,
            ObjectAttributes: [ObjectAttributes.CHECKSUM, ObjectAttributes.OBJECT_PARTS],
          }),
        );
        const member = `Checksum${algorithm}` as const;
        expect(attributes.Checksum?.[member]).toBe(expected);
        expect(attributes.ObjectParts?.Parts?.map((p) => p[member])).toEqual([
          uploaded1.checksum,
          uploaded2.checksum,
        ]);
      },
      30_000,
    );

    it("ignores an unknown checksum algorithm on CreateMultipartUpload", async () => {
      const response = await fetch(`${baseUrl}/${bucket}/unknown-algo?uploads`, {
        method: "POST",
        headers: { "x-amz-checksum-algorithm": "NOTAREALALGORITHM" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-amz-checksum-algorithm")).toBeNull();
      await response.text();
    });
  });
});

describe("opt-in checksum validation", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;
  let baseUrl: string;
  const bucket = "validated-bucket";

  beforeAll(async () => {
    server = await startFauxqsTestServer({ strictRules: { validateChecksums: true } });
    s3 = createS3Client(server.port);
    baseUrl = `http://127.0.0.1:${server.port}`;
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  const put = (key: string, body: string, headers: Record<string, string>) =>
    fetch(`${baseUrl}/${bucket}/${key}`, { method: "PUT", headers, body });

  const ALL_ALGORITHMS = [
    "CRC32",
    "CRC32C",
    "CRC64NVME",
    "SHA1",
    "SHA256",
    "SHA512",
    "MD5",
    "XXHASH64",
    "XXHASH3",
    "XXHASH128",
  ] as const;

  it.each(ALL_ALGORITHMS)("accepts a correct %s checksum", async (algorithm) => {
    const body = `valid body for ${algorithm}`;
    const response = await put(`valid-${algorithm.toLowerCase()}.txt`, body, {
      [checksumHeader(algorithm)]: computeChecksum(algorithm, Buffer.from(body)),
    });
    expect(response.status).toBe(200);
    await response.text();
  });

  it.each(ALL_ALGORITHMS)("rejects a %s checksum that does not match the body", async (algorithm) => {
    const response = await put(`invalid-${algorithm.toLowerCase()}.txt`, "the real body", {
      [checksumHeader(algorithm)]: computeChecksum(algorithm, Buffer.from("a different body")),
    });
    expect(response.status).toBe(400);
    const xml = await response.text();
    expect(xml).toContain("<Code>BadDigest</Code>");
    expect(xml).toContain(`The ${algorithm} you specified did not match the calculated checksum.`);
  });

  it("does not store an object whose checksum was rejected", async () => {
    const key = "never-stored.txt";
    const rejected = await put(key, "body", {
      "x-amz-checksum-sha256": computeChecksum("SHA256", Buffer.from("other")),
    });
    expect(rejected.status).toBe(400);
    await rejected.text();

    const response = await fetch(`${baseUrl}/${bucket}/${key}`);
    expect(response.status).toBe(404);
    await response.text();
  });

  it("rejects a mismatched part checksum on UploadPart", async () => {
    const key = "multipart-validated";
    const create = await fetch(`${baseUrl}/${bucket}/${key}?uploads`, {
      method: "POST",
      headers: { "x-amz-checksum-algorithm": "SHA256" },
    });
    const uploadId = (await create.text()).match(/<UploadId>([^<]+)<\/UploadId>/)![1];

    const response = await fetch(
      `${baseUrl}/${bucket}/${key}?partNumber=1&uploadId=${uploadId}`,
      {
        method: "PUT",
        headers: { "x-amz-checksum-sha256": computeChecksum("SHA256", Buffer.from("other")) },
        body: Buffer.alloc(5 * 1024 * 1024, "p"),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("<Code>BadDigest</Code>");
  });

  it("rejects a mismatched checksum on a CopyObject that replaces metadata", async () => {
    await put("copy-validated-src.txt", "source body", {
      "x-amz-checksum-sha256": computeChecksum("SHA256", Buffer.from("source body")),
    }).then((r) => r.text());

    const response = await fetch(`${baseUrl}/${bucket}/copy-validated-dst.txt`, {
      method: "PUT",
      headers: {
        "x-amz-copy-source": `${bucket}/copy-validated-src.txt`,
        "x-amz-metadata-directive": "REPLACE",
        "x-amz-checksum-sha256": computeChecksum("SHA256", Buffer.from("not the source body")),
      },
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("<Code>BadDigest</Code>");
  });
});

describe("checksum validation is off by default", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;
  const bucket = "unvalidated-bucket";

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  it("stores and returns a wrong checksum as-is", async () => {
    const wrong = computeChecksum("SHA256", Buffer.from("something else"));
    const response = await fetch(`http://127.0.0.1:${server.port}/${bucket}/unchecked.txt`, {
      method: "PUT",
      headers: { "x-amz-checksum-sha256": wrong },
      body: "the real body",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-amz-checksum-sha256")).toBe(wrong);
    await response.text();
  });
});
