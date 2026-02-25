import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { createS3Client } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 PostObject", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;
  let port: number;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    port = server.port;
    s3 = createS3Client(port);
    await s3.send(new CreateBucketCommand({ Bucket: "post-uploads" }));
  });

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  it("uploads file via presigned POST form data", async () => {
    const { url, fields } = await createPresignedPost(s3, {
      Bucket: "post-uploads",
      Key: "test-file.txt",
      Expires: 60,
    });

    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      formData.append(key, value);
    }
    formData.append("file", new Blob(["hello post upload"], { type: "text/plain" }), "test-file.txt");

    const response = await fetch(url, { method: "POST", body: formData });
    expect(response.status).toBe(204);

    // Verify the file was stored
    const headResult = await s3.send(
      new HeadObjectCommand({ Bucket: "post-uploads", Key: "test-file.txt" }),
    );
    expect(headResult.ContentLength).toBe(17); // "hello post upload".length

    // Verify content
    const getResult = await s3.send(
      new GetObjectCommand({ Bucket: "post-uploads", Key: "test-file.txt" }),
    );
    const body = await getResult.Body!.transformToString();
    expect(body).toBe("hello post upload");
  });

  it("uploads file with Content-Type form field", async () => {
    const { url, fields } = await createPresignedPost(s3, {
      Bucket: "post-uploads",
      Key: "typed-file.json",
      Expires: 60,
    });

    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      formData.append(key, value);
    }
    formData.append("Content-Type", "application/json");
    formData.append("file", new Blob(['{"key":"value"}'], { type: "application/json" }), "typed-file.json");

    const response = await fetch(url, { method: "POST", body: formData });
    expect(response.status).toBe(204);

    const headResult = await s3.send(
      new HeadObjectCommand({ Bucket: "post-uploads", Key: "typed-file.json" }),
    );
    expect(headResult.ContentType).toBe("application/json");
  });

  it("returns 201 with XML when success_action_status is 201", async () => {
    const { url, fields } = await createPresignedPost(s3, {
      Bucket: "post-uploads",
      Key: "status-201.txt",
      Expires: 60,
    });

    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      formData.append(key, value);
    }
    formData.append("success_action_status", "201");
    formData.append("file", new Blob(["content"]), "status-201.txt");

    const response = await fetch(url, { method: "POST", body: formData });
    expect(response.status).toBe(201);

    const text = await response.text();
    expect(text).toContain("<PostResponse>");
    expect(text).toContain("<Bucket>post-uploads</Bucket>");
    expect(text).toContain("<Key>status-201.txt</Key>");
    expect(text).toContain("<ETag>");
  });

  it("returns 200 with empty body when success_action_status is 200", async () => {
    const { url, fields } = await createPresignedPost(s3, {
      Bucket: "post-uploads",
      Key: "status-200.txt",
      Expires: 60,
    });

    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      formData.append(key, value);
    }
    formData.append("success_action_status", "200");
    formData.append("file", new Blob(["content"]), "status-200.txt");

    const response = await fetch(url, { method: "POST", body: formData });
    expect(response.status).toBe(200);
  });

  it("defaults invalid success_action_status to 204", async () => {
    const { url, fields } = await createPresignedPost(s3, {
      Bucket: "post-uploads",
      Key: "status-invalid.txt",
      Expires: 60,
    });

    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      formData.append(key, value);
    }
    formData.append("success_action_status", "999");
    formData.append("file", new Blob(["content"]), "status-invalid.txt");

    const response = await fetch(url, { method: "POST", body: formData });
    expect(response.status).toBe(204);
  });

  it("substitutes ${filename} in key field", async () => {
    const formData = new FormData();
    formData.append("key", "uploads/${filename}");
    formData.append("file", new Blob(["photo data"]), "vacation.jpg");

    const url = `http://127.0.0.1:${port}/post-uploads`;
    const response = await fetch(url, { method: "POST", body: formData });
    expect(response.status).toBe(204);

    // Verify the object was stored with the substituted key
    const headResult = await s3.send(
      new HeadObjectCommand({ Bucket: "post-uploads", Key: "uploads/vacation.jpg" }),
    );
    expect(headResult.ContentLength).toBe(10);
  });

  it("returns 400 when key field is missing", async () => {
    const formData = new FormData();
    formData.append("file", new Blob(["content"]), "test.txt");

    const url = `http://127.0.0.1:${port}/post-uploads`;
    const response = await fetch(url, { method: "POST", body: formData });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("InvalidArgument");
  });

  it("stores x-amz-meta-* form fields as user metadata", async () => {
    const formData = new FormData();
    formData.append("key", "meta-file.txt");
    formData.append("x-amz-meta-author", "Jane");
    formData.append("x-amz-meta-project", "test-project");
    formData.append("file", new Blob(["metadata test"]), "meta-file.txt");

    const url = `http://127.0.0.1:${port}/post-uploads`;
    const response = await fetch(url, { method: "POST", body: formData });
    expect(response.status).toBe(204);

    const headResult = await s3.send(
      new HeadObjectCommand({ Bucket: "post-uploads", Key: "meta-file.txt" }),
    );
    expect(headResult.Metadata).toEqual({ author: "Jane", project: "test-project" });
  });

  it("stores Content-Disposition from form fields", async () => {
    const formData = new FormData();
    formData.append("key", "disposition-file.txt");
    formData.append("Content-Disposition", "attachment; filename=\"download.txt\"");
    formData.append("file", new Blob(["content"]), "disposition-file.txt");

    const url = `http://127.0.0.1:${port}/post-uploads`;
    const response = await fetch(url, { method: "POST", body: formData });
    expect(response.status).toBe(204);

    const headResult = await s3.send(
      new HeadObjectCommand({ Bucket: "post-uploads", Key: "disposition-file.txt" }),
    );
    expect(headResult.ContentDisposition).toBe("attachment; filename=\"download.txt\"");
  });

  it("redirects with 303 when success_action_redirect is set", async () => {
    const formData = new FormData();
    formData.append("key", "redirect-file.txt");
    formData.append("success_action_redirect", "http://example.com/callback");
    formData.append("file", new Blob(["content"]), "redirect-file.txt");

    const url = `http://127.0.0.1:${port}/post-uploads`;
    const response = await fetch(url, { method: "POST", body: formData, redirect: "manual" });
    expect(response.status).toBe(303);

    const location = response.headers.get("location")!;
    const locationUrl = new URL(location);
    expect(locationUrl.origin).toBe("http://example.com");
    expect(locationUrl.pathname).toBe("/callback");
    expect(locationUrl.searchParams.get("bucket")).toBe("post-uploads");
    expect(locationUrl.searchParams.get("key")).toBe("redirect-file.txt");
    expect(locationUrl.searchParams.get("etag")).toBeTruthy();
  });

  it("falls through to success_action_status when redirect URL is invalid", async () => {
    const formData = new FormData();
    formData.append("key", "bad-redirect.txt");
    formData.append("success_action_redirect", "not-a-valid-url");
    formData.append("success_action_status", "200");
    formData.append("file", new Blob(["content"]), "bad-redirect.txt");

    const url = `http://127.0.0.1:${port}/post-uploads`;
    const response = await fetch(url, { method: "POST", body: formData });
    expect(response.status).toBe(200);
  });

  it("handles binary file content correctly", async () => {
    const binaryContent = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);

    const { url, fields } = await createPresignedPost(s3, {
      Bucket: "post-uploads",
      Key: "binary-file.bin",
      Expires: 60,
    });

    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      formData.append(key, value);
    }
    formData.append("file", new Blob([binaryContent]), "binary-file.bin");

    const response = await fetch(url, { method: "POST", body: formData });
    expect(response.status).toBe(204);

    const getResult = await s3.send(
      new GetObjectCommand({ Bucket: "post-uploads", Key: "binary-file.bin" }),
    );
    const body = await getResult.Body!.transformToByteArray();
    expect(Buffer.from(body)).toEqual(Buffer.from(binaryContent));
  });
});
