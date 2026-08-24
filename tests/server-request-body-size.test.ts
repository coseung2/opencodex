import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../src/server";
import { MAX_DECOMPRESSED_BODY_BYTES } from "../src/server/request-decompress";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const TEST_DIR = join(import.meta.dir, ".tmp-server-request-body-size-test");
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  isolatedCodexHome = installIsolatedCodexHome("ocx-server-body-size-codex-");
});

afterEach(() => {
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("server maxRequestBodySize", () => {
  test("matches the bounded decompression ceiling", () => {
    expect(MAX_DECOMPRESSED_BODY_BYTES).toBe(256 * 1024 * 1024);
  });

  test("accepts a request above Bun's 128 MiB default", async () => {
    const server = startServer(0);
    try {
      const body = Buffer.alloc(129 * 1024 * 1024, 0x20);
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      expect(res.status).not.toBe(413);
      await res.text();
    } finally {
      await server.stop(true);
    }
  });
});
