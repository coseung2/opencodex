import { describe, expect, test } from "bun:test";
import {
  fetchKiroAvailableModels,
  kiroAvailableModelsUrl,
  kiroNativeEffortFromSchema,
  parseKiroAvailableModels,
} from "../src/providers/kiro-live-models";

describe("kiro control-plane model discovery", () => {
  test("requests the CLI's List-Available-Models operation", () => {
    expect(kiroAvailableModelsUrl("us-east-1")).toBe(
      "https://q.us-east-1.amazonaws.com/List-Available-Models?origin=KIRO_CLI",
    );
    const withProfile = new URL(
      kiroAvailableModelsUrl("eu-west-1", "arn:aws:codewhisperer:eu-west-1:1:profile/x"),
    );
    expect(withProfile.hostname).toBe("q.eu-west-1.amazonaws.com");
    expect(withProfile.searchParams.get("profileArn")).toBe("arn:aws:codewhisperer:eu-west-1:1:profile/x");
  });

  test("reads the native effort contract from the published schema", () => {
    expect(
      kiroNativeEffortFromSchema({
        properties: { output_config: { properties: { effort: { enum: ["low", "medium", "high"] } } } },
      }),
    ).toEqual({ effortPath: "output_config", effortLevels: ["low", "medium", "high"] });
    expect(
      kiroNativeEffortFromSchema({
        properties: { reasoning: { properties: { effort: { oneOf: [{ const: "high" }, { const: "max" }] } } } },
      }),
    ).toEqual({ effortPath: "reasoning", effortLevels: ["high", "max"] });
    // A schema without a known effort path carries no native contract.
    expect(kiroNativeEffortFromSchema({ properties: { temperature: {} } })).toEqual({});
    expect(kiroNativeEffortFromSchema(undefined)).toEqual({});
  });

  test("parses the service list and skips unusable rows", () => {
    const models = parseKiroAvailableModels({
      models: [
        { modelId: "claude-opus-5.5", modelName: "Claude Opus 5.5" },
        {
          modelId: "gpt-6-astra",
          modelName: "GPT-6 Astra",
          additionalModelRequestFieldsSchema: {
            properties: { reasoning: { properties: { effort: { enum: ["low", "xhigh"] } } } },
          },
        },
        { modelId: "gpt-6-sol" },
        { modelId: "gpt-6-sol" },
        { modelId: "  padded  " },
        { modelId: "" },
        { modelName: "no id" },
        "not an object",
      ],
    });

    expect(models).toEqual([
      { id: "claude-opus-5.5", name: "Claude Opus 5.5" },
      {
        id: "gpt-6-astra",
        name: "GPT-6 Astra",
        effortPath: "reasoning",
        effortLevels: ["low", "xhigh"],
      },
      { id: "gpt-6-sol" },
    ]);
    expect(parseKiroAvailableModels({ data: [] })).toEqual([]);
    expect(parseKiroAvailableModels(null)).toEqual([]);
  });

  test("classifies failures so the caller can degrade instead of guessing", async () => {
    const respond = (status: number, body: string, headers: Record<string, string> = {}) =>
      (async () =>
        new Response(body, { status, headers: { "content-type": "application/json", ...headers } })) as typeof fetch;

    const ok = await fetchKiroAvailableModels({
      accessToken: "token",
      region: "us-east-1",
      fetchImpl: respond(200, JSON.stringify({ models: [{ modelId: "gpt-6-luna" }] })),
    });
    expect(ok).toEqual({ ok: true, models: [{ id: "gpt-6-luna" }] });

    const unauthorized = await fetchKiroAvailableModels({
      accessToken: "token",
      region: "us-east-1",
      fetchImpl: respond(401, "{}"),
    });
    expect(unauthorized.ok).toBe(false);
    expect(unauthorized.ok === false && unauthorized.error).toBe("auth");

    const serverError = await fetchKiroAvailableModels({
      accessToken: "token",
      region: "us-east-1",
      fetchImpl: respond(500, "{}"),
    });
    expect(serverError.ok === false && serverError.error).toBe("http");

    const invalid = await fetchKiroAvailableModels({
      accessToken: "token",
      region: "us-east-1",
      fetchImpl: respond(200, "not json"),
    });
    expect(invalid.ok === false && invalid.error).toBe("invalid");

    const empty = await fetchKiroAvailableModels({
      accessToken: "token",
      region: "us-east-1",
      fetchImpl: respond(200, JSON.stringify({ models: [] })),
    });
    expect(empty.ok === false && empty.error).toBe("empty");

    const oversized = await fetchKiroAvailableModels({
      accessToken: "token",
      region: "us-east-1",
      fetchImpl: respond(200, "{}", { "content-length": String(5 * 1024 * 1024) }),
    });
    expect(oversized.ok === false && oversized.error).toBe("invalid");

    const transport = await fetchKiroAvailableModels({
      accessToken: "token",
      region: "us-east-1",
      fetchImpl: (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as typeof fetch,
    });
    expect(transport.ok === false && transport.error).toBe("transport");
  });
});
