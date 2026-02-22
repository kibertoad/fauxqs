import { describe, it, expect } from "vitest";
import { matchesFilterPolicy } from "../../src/sns/filter.js";

describe("SNS Filter Policy: cidr", () => {
  it("matches IPv4 address within /24 subnet", () => {
    const policy = { ip: [{ cidr: "10.0.0.0/24" }] };
    expect(matchesFilterPolicy(policy, { ip: { DataType: "String", StringValue: "10.0.0.1" } })).toBe(true);
    expect(matchesFilterPolicy(policy, { ip: { DataType: "String", StringValue: "10.0.0.255" } })).toBe(true);
  });

  it("does not match IPv4 address outside /24 subnet", () => {
    const policy = { ip: [{ cidr: "10.0.0.0/24" }] };
    expect(matchesFilterPolicy(policy, { ip: { DataType: "String", StringValue: "10.0.1.1" } })).toBe(false);
  });

  it("matches IPv4 address within /16 subnet", () => {
    const policy = { ip: [{ cidr: "192.168.1.0/16" }] };
    expect(matchesFilterPolicy(policy, { ip: { DataType: "String", StringValue: "192.168.0.1" } })).toBe(true);
  });

  it("does not match IPv4 address outside /16 subnet", () => {
    const policy = { ip: [{ cidr: "192.168.1.0/16" }] };
    expect(matchesFilterPolicy(policy, { ip: { DataType: "String", StringValue: "10.0.0.1" } })).toBe(false);
  });

  it("matches any IPv4 address with /0 CIDR", () => {
    const policy = { ip: [{ cidr: "0.0.0.0/0" }] };
    expect(matchesFilterPolicy(policy, { ip: { DataType: "String", StringValue: "192.168.1.1" } })).toBe(true);
    expect(matchesFilterPolicy(policy, { ip: { DataType: "String", StringValue: "10.0.0.1" } })).toBe(true);
    expect(matchesFilterPolicy(policy, { ip: { DataType: "String", StringValue: "255.255.255.255" } })).toBe(true);
  });

  it("matches IPv6 loopback with /128 CIDR", () => {
    const policy = { ip: [{ cidr: "::1/128" }] };
    expect(matchesFilterPolicy(policy, { ip: { DataType: "String", StringValue: "::1" } })).toBe(true);
  });

  it("does not match different IPv6 address with /128 CIDR", () => {
    const policy = { ip: [{ cidr: "::1/128" }] };
    expect(matchesFilterPolicy(policy, { ip: { DataType: "String", StringValue: "::2" } })).toBe(false);
  });

  it("returns false when attribute is missing", () => {
    const policy = { ip: [{ cidr: "10.0.0.0/24" }] };
    expect(matchesFilterPolicy(policy, {})).toBe(false);
  });

  it("returns false for non-IP string", () => {
    const policy = { ip: [{ cidr: "10.0.0.0/24" }] };
    expect(matchesFilterPolicy(policy, { ip: { DataType: "String", StringValue: "not-an-ip" } })).toBe(false);
  });
});
