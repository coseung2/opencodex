import { expect, test } from "bun:test";
import { anthropicToResponsesBody } from "../src/claude/inbound";
import { pickerEffortTemplate } from "../src/claude/picker-effort";

test("ToolSearch references preserve loaded names and subsequent task text", () => {
  const body = anthropicToResponsesBody({ model: "fixture/model", messages: [
    { role: "user", content: "Investigate the repository." },
    { role: "assistant", content: [{ type: "tool_use", id: "search", name: "ToolSearch", input: {} }] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "search", content: [{ type: "tool_reference", tool_name: "Read" }] },
      { type: "text", text: "Continue the investigation." },
    ] },
  ] });
  const input = body.input as Record<string, unknown>[];
  expect(input[2]).toMatchObject({ type: "function_call_output", call_id: "search", output: [{ type: "input_text", text: '\n[ToolSearch loaded tool: "Read"]\n' }] });
  expect(JSON.stringify(input)).toContain("Continue the investigation.");
  expect(body.tools).toBeUndefined();
});

test("optional tool parameters stay optional; explicit strict stays strict", () => {
  for (const strict of [undefined, false, true, "true"]) {
    const body = anthropicToResponsesBody({ model: "fixture/model", messages: [{ role: "user", content: "Read." }],
      tools: [{ name: "Read", input_schema: { type: "object", properties: { offset: { type: "number" } } }, strict }],
    });
    expect((body.tools as Record<string, unknown>[])[0]!.strict).toBe(strict === true);
  }
});

test("blocked skill guard and elision keep the original investigation instead of a greeting", () => {
  const body = anthropicToResponsesBody({ model: "fixture/model",
    tools: [{ name: "Skill", description: "Load skills", input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: "Investigate missing effort options in this repository." },
      { role: "assistant", content: [{ type: "tool_use", id: "skill", name: "Skill", input: { skill: "claude-api" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "skill", content: "Launching skill" }] },
    ],
  });
  expect(JSON.stringify(body.tools)).toContain('claude-api');
  expect(JSON.stringify(body.input)).toContain("Investigate missing effort options");
  expect(JSON.stringify(body.input)).toContain("Do not restart with a skill greeting");
  const enabled = anthropicToResponsesBody({ model: "fixture/model", messages: [{ role: "user", content: "Help" }], tools: [{ name: "Skill", description: "original", input_schema: { type: "object" } }] }, { blockedSkills: [] });
  expect((enabled.tools as Record<string, unknown>[])[0]!.description).toBe("original");
});

test("picker prefers an existing effort-capable template over the first native row", () => {
  const haiku = { id: "claude-haiku", name: "Haiku" };
  const opus = { id: "claude-opus", thinking: { effort_options: [{ id: "low" }, { id: "high" }, { id: "max" }] } };
  const before = JSON.stringify([haiku, opus]);
  expect(pickerEffortTemplate([haiku, opus], ["high", "max"])).toBe(opus);
  expect(pickerEffortTemplate([{ ...opus, disabled: true }, haiku], ["high"])).toBe(haiku);
  expect(JSON.stringify([haiku, opus])).toBe(before);
  const ladder = { id: "claude-ladder", effort_levels: ["low", "high"] };
  expect(pickerEffortTemplate([haiku, ladder], ["high"])).toBe(ladder);
});
