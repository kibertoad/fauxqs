import { describe, it, expect } from "vitest";
import { matchesFilterPolicy } from "../../src/sns/filter.js";

describe("SNS Filter Policy: equals-ignore-case", () => {
  it("matches case-insensitive string", () => {
    const policy = { color: [{ "equals-ignore-case": "RED" }] };
    const attrs = { color: { DataType: "String", StringValue: "red" } };
    expect(matchesFilterPolicy(policy, attrs)).toBe(true);
  });

  it("matches mixed case", () => {
    const policy = { color: [{ "equals-ignore-case": "Red" }] };
    const attrs = { color: { DataType: "String", StringValue: "RED" } };
    expect(matchesFilterPolicy(policy, attrs)).toBe(true);
  });

  it("matches same case", () => {
    const policy = { color: [{ "equals-ignore-case": "blue" }] };
    const attrs = { color: { DataType: "String", StringValue: "blue" } };
    expect(matchesFilterPolicy(policy, attrs)).toBe(true);
  });

  it("does not match different value", () => {
    const policy = { color: [{ "equals-ignore-case": "RED" }] };
    const attrs = { color: { DataType: "String", StringValue: "blue" } };
    expect(matchesFilterPolicy(policy, attrs)).toBe(false);
  });

  it("does not match when attribute is missing", () => {
    const policy = { color: [{ "equals-ignore-case": "RED" }] };
    expect(matchesFilterPolicy(policy, {})).toBe(false);
  });
});
