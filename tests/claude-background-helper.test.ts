import {expect,test} from "bun:test";
import {claudeBackgroundHelperKind} from "../src/claude/background-helper";
const body = { model:"claude-haiku-5-5", system:[], tools:[] };
const fetchPrompt = "Web page content:\n---\nFixture page\n---\nSummarize\nProvide a concise response based only on the content above. In your response: use facts.";
test("recognizes dedicated native WebFetch, title and tool label calls",()=>{
 expect(claudeBackgroundHelperKind({...body,messages:[{role:"user",content:fetchPrompt}]})).toBe("web-fetch");
 expect(claudeBackgroundHelperKind({...body,system:'Name this session. Return JSON with a single "title" field.',messages:[{role:"user",content:"<session>fixture</session>\nWrite the title in Korean."}]})).toBe("title");
 expect(claudeBackgroundHelperKind({...body,system:"Write a short summary label describing what these tool calls accomplished.",messages:[{role:"user",content:"Tools completed:\nRead\nLabel:"}]})).toBe("tool-summary");
});
test("does not remap safety, ordinary conversations, history or assigned non-Haiku models",()=>{
 const fixture={...body,messages:[{role:"user",content:fetchPrompt}]};
 for(const overrides of [{model:"claude-opus-5-5"},{model:"claude-ocx-kiro--claude-opus-5.5"},{system:"You are a security monitor for autonomous AI coding agents."},{tools:[{name:"Read"}]},{messages:[...fixture.messages,{role:"assistant",content:"Done"}]},{messages:[{role:"user",content:"Please fetch a page"}]}])expect(claudeBackgroundHelperKind({...fixture,...overrides})).toBeUndefined();
});
