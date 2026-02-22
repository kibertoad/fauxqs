import { describe, it, expect } from "vitest";
import { matchesFilterPolicy } from "../../src/sns/filter.js";

describe("SNS Filter Policy: wildcard", () => {
  it("matches pattern with * in the middle", () => {
    const policy = { key: [{ wildcard: "v*e" }] };
    expect(matchesFilterPolicy(policy, { key: { DataType: "String", StringValue: "value" } })).toBe(true);
    expect(matchesFilterPolicy(policy, { key: { DataType: "String", StringValue: "vue" } })).toBe(true);
  });

  it("does not match when pattern with * in the middle fails", () => {
    const policy = { key: [{ wildcard: "v*e" }] };
    expect(matchesFilterPolicy(policy, { key: { DataType: "String", StringValue: "val" } })).toBe(false);
  });

  it("matches pattern with trailing *", () => {
    const policy = { key: [{ wildcard: "test*" }] };
    expect(matchesFilterPolicy(policy, { key: { DataType: "String", StringValue: "testing" } })).toBe(true);
    expect(matchesFilterPolicy(policy, { key: { DataType: "String", StringValue: "test" } })).toBe(true);
  });

  it("does not match when trailing * pattern fails", () => {
    const policy = { key: [{ wildcard: "test*" }] };
    expect(matchesFilterPolicy(policy, { key: { DataType: "String", StringValue: "best" } })).toBe(false);
  });

  it("matches pattern with leading *", () => {
    const policy = { key: [{ wildcard: "*end" }] };
    expect(matchesFilterPolicy(policy, { key: { DataType: "String", StringValue: "the end" } })).toBe(true);
    expect(matchesFilterPolicy(policy, { key: { DataType: "String", StringValue: "end" } })).toBe(true);
  });

  it("does not match when leading * pattern fails", () => {
    const policy = { key: [{ wildcard: "*end" }] };
    expect(matchesFilterPolicy(policy, { key: { DataType: "String", StringValue: "ending" } })).toBe(false);
  });

  it("matches pattern with multiple *", () => {
    const policy = { key: [{ wildcard: "a*b*c" }] };
    expect(matchesFilterPolicy(policy, { key: { DataType: "String", StringValue: "abc" } })).toBe(true);
    expect(matchesFilterPolicy(policy, { key: { DataType: "String", StringValue: "axbxc" } })).toBe(true);
  });

  it("does not match when multiple * pattern fails", () => {
    const policy = { key: [{ wildcard: "a*b*c" }] };
    expect(matchesFilterPolicy(policy, { key: { DataType: "String", StringValue: "abx" } })).toBe(false);
  });

  it("returns false when attribute is missing", () => {
    const policy = { key: [{ wildcard: "v*e" }] };
    expect(matchesFilterPolicy(policy, {})).toBe(false);
  });

  describe("anything-but with wildcard", () => {
    it("matches when value does not match excluded wildcard", () => {
      const policy = { key: [{ "anything-but": { wildcard: "test*" } }] };
      expect(matchesFilterPolicy(policy, { key: { DataType: "String", StringValue: "production" } })).toBe(true);
    });

    it("does not match when value matches excluded wildcard", () => {
      const policy = { key: [{ "anything-but": { wildcard: "test*" } }] };
      expect(matchesFilterPolicy(policy, { key: { DataType: "String", StringValue: "testing" } })).toBe(false);
    });
  });
});
