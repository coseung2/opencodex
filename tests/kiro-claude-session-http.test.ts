import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server";
import { saveConfig } from "../src/config";
import { encodeMessage } from "../src/lib/eventstream-decoder";
import { managementFetch } from "./helpers/management-auth";
import { installIsolatedCodexHome } from "./helpers/isolated-codex-home";
import type { OcxConfig } from "../src/types";

test("Messages HTTP turns reuse only the same explicit session and never honor a caller-injected scope", async()=>{
 const oldHome=process.env.OPENCODEX_HOME; const isolated=installIsolatedCodexHome("kiro-claude-http-");const home=mkdtempSync(join(tmpdir(),"kiro-claude-http-"));process.env.OPENCODEX_HOME=home;
 const ids:string[]=[];const headersSeen:Headers[]=[];const enc=new TextEncoder();
 const upstream=Bun.serve({port:0,async fetch(req){
   const body=await req.json() as any;ids.push(body.conversationState.conversationId);headersSeen.push(req.headers);
   const frame=encodeMessage({":message-type":"event",":event-type":"assistantResponseEvent"},enc.encode(JSON.stringify({content:"OK"})));
   return new Response(frame,{headers:{"content-type":"application/vnd.amazon.eventstream"}});
 }});
 saveConfig({port:0,defaultProvider:"fixture",providers:{fixture:{adapter:"kiro",baseUrl:upstream.url.toString(),apiKey:"fixture",authMode:"key",allowPrivateNetwork:true,liveModels:false,kiroCompletionMode:"disabled"}}} as OcxConfig);
 const server=startServer(0);
 try{
  const send=async(session:string|undefined,previous=false)=>{
   const messages:any[]=[{role:"user",content:"hello"}];if(previous)messages.push({role:"assistant",content:"OK"},{role:"user",content:"continue"});
   const r=await managementFetch(new URL("/v1/messages",server.url),{method:"POST",headers:{"content-type":"application/json","x-ocx-claude-session-scope":"a".repeat(64)},body:JSON.stringify({model:"fixture/claude-sonnet-4.5",messages,max_tokens:32,...(session?{metadata:{user_id:JSON.stringify({session_id:session})}}:{})})});
   expect(r.status).toBe(200);await r.text();
  };
  const session="11111111-2222-4333-8444-555555555555";
  await send(session);await send(session,true);
  expect(ids[1]).toBe(ids[0]);
  await send("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",true);expect(ids[2]).not.toBe(ids[0]);
  await send(undefined);await send(undefined,true);expect(ids[4]).not.toBe(ids[3]);
  expect(headersSeen.every(h=>!h.has("x-ocx-claude-session-scope"))).toBe(true);
 }finally{
  server.stop(true);upstream.stop(true);isolated.restore();if(oldHome===undefined)delete process.env.OPENCODEX_HOME;else process.env.OPENCODEX_HOME=oldHome;rmSync(home,{recursive:true,force:true});
 }
},60000);
