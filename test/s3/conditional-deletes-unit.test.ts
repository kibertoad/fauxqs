import { describe, it, expect } from "vitest";
import {
  checkConditionalDelete,
  parseDeletePreconditions,
  type DeleteTarget,
} from "../../src/s3/conditionalDeletes.js";

/**
 * The timestamp precondition is exercised directly here rather than over HTTP:
 * S3 only ever hands a client a second-granular `Last-Modified`, so the
 * millisecond cases a client can still *send* are unreachable through the API.
 */
describe("conditional delete last-modified-time precision", () => {
  /** An object stored 456 ms into its second, as fauxqs timestamps them. */
  const stored: DeleteTarget = {
    etag: '"d41d8cd98f00b204e9800998ecf8427e"',
    lastModified: new Date("2026-08-24T13:17:23.456Z"),
    contentLength: 2,
  };

  function check(ifMatchLastModifiedTime: string): void {
    checkConditionalDelete(parseDeletePreconditions({ ifMatchLastModifiedTime }), stored);
  }

  it("matches an HTTP-date naming the stored second", () => {
    expect(() => check("Mon, 24 Aug 2026 13:17:23 GMT")).not.toThrow();
  });

  it("matches an RFC-3339 value with no fraction", () => {
    // What the SDK serialises a <LastModifiedTime> as, `.000` stripped.
    expect(() => check("2026-08-24T13:17:23Z")).not.toThrow();
  });

  it("matches an RFC-3339 value whose fraction is zero", () => {
    // A client echoing back the second-granular Last-Modified it was given,
    // formatted with milliseconds. The zero claims nothing beyond the second.
    expect(() => check("2026-08-24T13:17:23.000Z")).not.toThrow();
  });

  it("matches the stored milliseconds exactly", () => {
    expect(() => check("2026-08-24T13:17:23.456Z")).not.toThrow();
  });

  it("fails a non-zero fraction the stored object does not have", () => {
    // Truncating to the second would let this pass, so a compare-and-swap racing
    // a same-second overwrite would delete the wrong version.
    expect(() => check("2026-08-24T13:17:23.900Z")).toThrow(/pre-conditions/);
  });

  it("fails a different second", () => {
    expect(() => check("Mon, 24 Aug 2026 13:17:24 GMT")).toThrow(/pre-conditions/);
  });

  it("reads a non-UTC offset as the instant it names, not as local time", () => {
    // 16:17:23+03:00 is the stored second. Bare Date.parse on an offset-less
    // string would instead land wherever the host's timezone put it.
    expect(() => check("2026-08-24T16:17:23+03:00")).not.toThrow();
    expect(() => check("2026-08-24T13:17:23+03:00")).toThrow(/pre-conditions/);
  });

  it.each([
    ["an offset-less date-time", "2026-08-24T13:17:23"],
    ["a bare year", "999"],
    ["epoch seconds", "1787577443"],
    ["a date with no time", "2026-08-24"],
    ["an impossible month", "2026-13-24T13:17:23Z"],
    // Date.parse rolls each of these into the following month rather than
    // refusing it, so the precondition would be compared against an instant the
    // caller never named.
    ["a day the month never had", "2026-02-29T13:17:23Z"],
    ["a day the month never had, as an HTTP-date", "Sun, 29 Feb 2026 13:17:23 GMT"],
    ["a 31st in a 30-day month", "2026-04-31T13:17:23Z"],
    ["a month name that does not exist", "Mon, 24 Foo 2026 13:17:23 GMT"],
    ["prose", "yesterday"],
    ["a blank value", ""],
  ])("rejects %s as InvalidArgument", (_label, value) => {
    expect(() => check(value)).toThrow(/Invalid last modified time precondition/);
  });

  it("accepts a leap day that did exist, failing only the comparison", () => {
    // The guard against rolled-over dates must not swallow a real 29 February.
    expect(() => check("2024-02-29T13:17:23Z")).toThrow(/pre-conditions/);
  });
});
