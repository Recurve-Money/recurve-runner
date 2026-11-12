import {describe, expect, it} from "vitest";
import {withoutUrlSecrets} from "./health.js";

describe("withoutUrlSecrets", () => {
  it("keeps the host of an endpoint and drops the key in its path or query", () => {
    expect(withoutUrlSecrets("HTTP request failed. URL: https://rpc.example.com/v2/s3cr3t?apikey=abc Details: timeout")).toBe(
      "HTTP request failed. URL: https://rpc.example.com/... Details: timeout",
    );
  });

  it("does the same whatever the scheme, or its case", () => {
    expect(withoutUrlSecrets("HTTPS://rpc.example.com/KEY and postgres://u:p@db.example.com/x")).toBe(
      "HTTPS://rpc.example.com/... and postgres://db.example.com/...",
    );
  });

  it("drops credentials written before the host", () => {
    expect(withoutUrlSecrets("failed: wss://user:pass@node.example.com:8546/ws")).toBe("failed: wss://node.example.com:8546/...");
  });

  it("leaves a message without a URL as it is", () => {
    expect(withoutUrlSecrets("settle(0x12, 5) does not simulate: WrongState")).toBe("settle(0x12, 5) does not simulate: WrongState");
  });
});
