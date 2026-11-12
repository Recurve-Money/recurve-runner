import {describe, expect, it} from "vitest";
import {loadConfig, NETWORKS, selectNetwork} from "./config.js";

const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);
const C = "0x" + "c".repeat(40);
const D = "0x" + "d".repeat(40);
const E = "0x" + "e".repeat(40);
const F = "0x" + "f".repeat(40);
const KEY = "0x" + "1".repeat(64);

const minimal: Record<string, string> = {
  PRIVATE_KEY: KEY,
  RECURVE_VAULT: A,
  RECURVE_GOVERNOR: B,
  RECURVE_REGISTRY: C,
  RECURVE_STRATEGY: D,
  RECURVE_TOKEN: E,
  DEX_QUOTER: F,
};

describe("selectNetwork", () => {
  it("defaults to Robinhood Chain mainnet", () => {
    expect(selectNetwork({})).toEqual(NETWORKS.mainnet);
  });

  it("picks testnet from RECURVE_CHAIN_ID", () => {
    expect(selectNetwork({RECURVE_CHAIN_ID: "46630"})).toEqual(NETWORKS.testnet);
  });

  it("lets RECURVE_RPC_URL override the endpoint without changing the chain", () => {
    const net = selectNetwork({RECURVE_RPC_URL: "http://127.0.0.1:8545"});
    expect(net.id).toBe(4663);
    expect(net.rpcUrl).toBe("http://127.0.0.1:8545");
  });

  it("rejects a chain id it does not know", () => {
    expect(() => selectNetwork({RECURVE_CHAIN_ID: "1"})).toThrow(/RECURVE_CHAIN_ID/);
  });
});

describe("loadConfig", () => {
  it("names every missing required variable at once", () => {
    expect(() => loadConfig({})).toThrow(
      /PRIVATE_KEY.*RECURVE_VAULT.*RECURVE_GOVERNOR.*RECURVE_REGISTRY.*RECURVE_STRATEGY.*RECURVE_TOKEN.*DEX_QUOTER/s,
    );
  });

  it("applies the real-money defaults", () => {
    const cfg = loadConfig(minimal);
    expect(cfg.network.id).toBe(4663);
    expect(cfg.deployBlock).toBe(0n);
    expect(cfg.priceToleranceBps).toBe(300n);
    expect(cfg.minTrade).toBe("0.001");
    expect(cfg.policy.reserveBps).toBe(1000n);
    expect(cfg.policy.holdSeconds).toBeNull();
    expect(cfg.policy.forceUnwind).toBe(false);
    expect(cfg.policy.paused).toBe(false);
    expect(cfg.dryRun).toBe(false);
    expect(cfg.intervalMs).toBe(60_000);
    expect(cfg.healthPort).toBe(8080);
    expect(cfg.logChunk).toBe(100_000n);
  });

  it("lets LOG_CHUNK shrink the scan window for RPCs that cap eth_getLogs", () => {
    expect(loadConfig({...minimal, LOG_CHUNK: "2000"}).logChunk).toBe(2000n);
  });

  it("reads the operator switches as booleans", () => {
    const cfg = loadConfig({...minimal, FORCE_UNWIND: "true", PAUSED: "1", DRY_RUN: "yes"});
    expect(cfg.policy.forceUnwind).toBe(true);
    expect(cfg.policy.paused).toBe(true);
    expect(cfg.dryRun).toBe(true);
  });

  it("takes the health port from PORT, as Railway sets it", () => {
    expect(loadConfig({...minimal, PORT: "3000"}).healthPort).toBe(3000);
  });

  it("rejects a malformed address", () => {
    expect(() => loadConfig({...minimal, RECURVE_VAULT: "0x123"})).toThrow(/RECURVE_VAULT/);
  });

  it("rejects a malformed private key", () => {
    expect(() => loadConfig({...minimal, PRIVATE_KEY: "deadbeef"})).toThrow(/PRIVATE_KEY/);
  });

  it("rejects a price tolerance that would accept any fill", () => {
    expect(() => loadConfig({...minimal, PRICE_TOLERANCE_BPS: "10000"})).toThrow(/PRICE_TOLERANCE_BPS/);
  });

  it("rejects a reserve above 100%", () => {
    expect(() => loadConfig({...minimal, RESERVE_BPS: "10001"})).toThrow(/RESERVE_BPS/);
  });

  it("parses HOLD_SECONDS when set", () => {
    expect(loadConfig({...minimal, HOLD_SECONDS: "604800"}).policy.holdSeconds).toBe(604_800n);
  });
});
