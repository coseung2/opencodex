import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createKiroSessionStore } from "../src/adapters/kiro-session";
import { claudeSessionScope, CLAUDE_SESSION_SCOPE_HEADER } from "../src/claude/session-scope";
import { createKiroAdapter } from "../src/adapters/kiro";
import { encodeMessage } from "../src/lib/eventstream-decoder";
import { createTestTranslatorBudget } from "./helpers/translator-budget";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";
const provider: OcxProviderConfig = { adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev", authMode: "oauth", apiKey: "fixture-one" };
const scope = () => randomBytes(32).toString("hex");
const model = "claude-sonnet-4.5";

test("scope accepts session metadata only, binds admission and first user, ignores cache cohorts", () => {
 const headers = new Headers({ authorization: "Bearer admission-one" });
 const session = "11111111-2222-4333-8444-555555555555";
 const raw = { metadata: { user_id: JSON.stringify({ session_id: session }) }, messages: [{ role: "user", content: "start" }] };
 const key = claudeSessionScope(headers, raw)!;
 expect(key).toMatch(/^[a-f0-9]{64}$/);
 expect(claudeSessionScope(headers, { ...raw, messages: [...raw.messages, { role: "assistant", content: "ok" }, { role: "user", content: "next" }] })).toBe(key);
 expect(claudeSessionScope(headers, { ...raw, metadata: { user_id: `user_a_account_b_session_${session}` } })).toBe(key);
 expect(claudeSessionScope(new Headers({ authorization: "Bearer admission-two" }), raw)).not.toBe(key);
 expect(claudeSessionScope(headers, { ...raw, messages: [{ role: "user", content: "different start" }] })).not.toBe(key);
 for(const user_id of ["same-user", "", JSON.stringify({ user_id: session }), "x".repeat(5000)]) expect(claudeSessionScope(headers,{...raw,metadata:{user_id}})).toBeUndefined();
 expect(claudeSessionScope(headers, { messages: raw.messages, system: "same system", prompt_cache_key: key })).toBeUndefined();
});

test("sequential success reuses returned id; parallel, failed, changed-account/model and expired sessions isolate", () => {
 let time=0; const store=createKiroSessionStore(4,100,()=>time); const key=scope();
 const first=store.acquire(key,provider,model)!;
 expect(store.acquire(key,provider,model)).toBeUndefined();
 first.finish(true,"provider-returned-id");
 const next=store.acquire(key,provider,model)!; expect(next.conversationId).toBe("provider-returned-id");
 next.finish(false);
 const reset=store.acquire(key,provider,model)!;expect(reset.conversationId).not.toBe("provider-returned-id");reset.finish(true);
 const account=store.acquire(key,{...provider,apiKey:"fixture-two"},model)!;expect(account.conversationId).not.toBe(reset.conversationId);account.finish(true);
 const otherModel=store.acquire(key,provider,"other-model")!;expect(otherModel.conversationId).not.toBe(reset.conversationId);otherModel.finish(true);
 time=101;const expired=store.acquire(key,provider,model)!;expect(expired.conversationId).not.toBe(reset.conversationId);
 time=202;const abandonedReplacement=store.acquire(key,provider,model)!;expired.finish(true,"stale-id");abandonedReplacement.finish(true);
 const restored=store.acquire(key,provider,model)!;expect(restored.conversationId).toBe(abandonedReplacement.conversationId);
});

test("capacity remains bounded without evicting busy owners", () => {
 const store=createKiroSessionStore(1);const a=store.acquire(scope(),provider,model)!;
 expect(store.acquire(scope(),provider,model)).toBeUndefined();a.finish(true);
 expect(store.acquire(scope(),provider,model)).toBeDefined();
});

function parsed():OcxParsedRequest {return {modelId:model,stream:true,options:{},context:{messages:[{role:"user",content:"hello",timestamp:0}]}};}
function response(){const enc=new TextEncoder();return new Response(new ReadableStream({start(c){
 c.enqueue(encodeMessage({":message-type":"event",":event-type":"assistantResponseEvent"},enc.encode(JSON.stringify({content:"hello"}))));c.close();
}}));}

test("actual adapter commits only successful parsing, isolates concurrency, preserves Codex state and releases cancellation", async()=>{
 const key=scope();const meta={headers:new Headers({[CLAUDE_SESSION_SCOPE_HEADER]:key}),translatorBudget:createTestTranslatorBudget()};
 const first=createKiroAdapter(provider);const p=parsed();const built=await first.buildRequest(p,meta);const id=JSON.parse(built.body).conversationState.conversationId;
 expect(p._providerContinuation).toBeUndefined();
 expect(JSON.stringify(built.headers)).not.toContain(key);
 const parallel=createKiroAdapter(provider);const parallelBuilt=await parallel.buildRequest(parsed(),meta);expect(JSON.parse(parallelBuilt.body).conversationState.conversationId).not.toBe(id);
 for await(const _ of parallel.parseStream(response(),createTestTranslatorBudget())){}
 const iterator=first.parseStream(response(),createTestTranslatorBudget());
 while(true){const next=await iterator.next();if(next.done||next.value.type==="done")break;}
 const second=createKiroAdapter(provider);const secondBuilt=await second.buildRequest(parsed(),meta);expect(JSON.parse(secondBuilt.body).conversationState.conversationId).toBe(id);
 await iterator.return();
 for await(const _ of second.parseStream(response(),createTestTranslatorBudget())){}
 const abort=new AbortController();const cancelled=createKiroAdapter(provider);await cancelled.buildRequest(parsed(),{...meta,abortSignal:abort.signal});abort.abort();
 const afterAbort=createKiroAdapter(provider);const after=await afterAbort.buildRequest(parsed(),meta);expect(JSON.parse(after.body).conversationState.conversationId).not.toBe(id);
 for await(const _ of afterAbort.parseStream(response(),createTestTranslatorBudget())){}
 const codex=createKiroAdapter(provider);const inherited=parsed();inherited._providerContinuation={kiro:{conversationId:"codex-existing"}};
 expect(JSON.parse((await codex.buildRequest(inherited,meta)).body).conversationState.conversationId).toBe("codex-existing");
});
