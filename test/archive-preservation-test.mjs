import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ScheduleBridge} from '../lib/index.js';
const state=mkdtempSync(join(tmpdir(),'dss-archive-')), rows=[], listeners=new Map(), archived=[], sessions=new Map();let sequence=0;
const workspaces=[{id:'workspace',path:'/test',sessionIds:[]}];
const ctx={
 workspaceRegistry:{list:()=>workspaces,get archivedSessionIds(){return archived}},
 on:(name,fn)=>{const set=listeners.get(name)||new Set();listeners.set(name,set);set.add(fn);return()=>set.delete(fn)},
 sessions:{get:id=>sessions.get(id)},
 sessionController:{create:async()=>{const sessionId='session-'+ ++sequence;sessions.set(sessionId,{id:sessionId,header:{cwd:'/test'}});workspaces[0].sessionIds.push(sessionId);return{sessionId}},rename:async()=>{},prompt:async()=>{}},
 schedule:{catalog:async()=>structuredClone(rows),create:async(sessionId,r)=>{const record={id:'schedule-'+ ++sequence,title:r.title,prompt:r.prompt,kind:r.every_seconds?'every':r.at?'at':'cron',everySeconds:r.every_seconds,expression:r.cron?.expression,timeZone:r.cron?.time_zone,scheduledAt:r.at||new Date(Date.now()+86400000).toISOString()};rows.push({...record,sessionId,status:'active'});return record},update:async r=>{const e=rows.find(x=>x.id===r.id);if(!e)return{id:r.id,updated:false,code:'missing'};if(r.title)e.title=r.title;if(r.prompt)e.prompt=r.prompt;return{id:r.id,updated:true,record:e}},delete:async({id})=>{const i=rows.findIndex(x=>x.id===id);if(i<0)return{deleted:false};rows.splice(i,1);return{deleted:true}}}
};
let bridge=new ScheduleBridge(ctx,state,'test');bridge.start();
const recurring=await bridge.create({title:'周期任务',prompt:'归档后仍保留',workspaceId:'workspace',frequency:{kind:'every',seconds:86400},builtin:true});
const once=await bridge.create({title:'一次性任务',prompt:'归档遵循宿主停止语义',sessionId:recurring.sessionId,frequency:{kind:'once',at:new Date(Date.now()+86400000).toISOString()}});
// Same public archive sequence as WorkspaceRegistry + official Schedule: durable
// archived membership, then workspace/session-stop deletes original-session rows.
archived.push(recurring.sessionId);
for(let i=rows.length-1;i>=0;i--)if(rows[i].sessionId===recurring.sessionId)rows.splice(i,1);
for(const fn of listeners.get('schedule/changed')||[])fn();
const after=await bridge.list();
assert.equal(after.filter(x=>x.title==='周期任务').length,1,'recurring task survives archive exactly once');
assert.notEqual(after.find(x=>x.title==='周期任务').sessionId,recurring.sessionId,'delivery goes to a fresh session');
assert(!after.some(x=>x.id===once.id),'one-off tasks keep native stop behavior');
assert.equal(after.find(x=>x.title==='周期任务').builtin,true,'builtin classification survives');
bridge.stop();bridge=new ScheduleBridge(ctx,state,'test');bridge.start();
assert.equal((await bridge.list()).filter(x=>x.title==='周期任务').length,1,'restart does not duplicate');
const current=(await bridge.list()).find(x=>x.title==='周期任务');
await bridge.update({id:current.id,prompt:'临时错误改动'});
await bridge.pause(current.id);
assert.equal(rows.length,0,'paused task is disarmed in official Schedule');
assert.equal((await bridge.list())[0].status,'paused','paused task stays visible');
bridge.stop();bridge=new ScheduleBridge(ctx,state,'test');bridge.start();
assert.equal((await bridge.list())[0].status,'paused','restart preserves pause');
await bridge.restoreDefaults();
assert.equal(rows.length,0,'default reset preserves pause');
assert.equal((await bridge.list())[0].prompt,'归档后仍保留','default reset corrects edited prompt');
await Promise.all([bridge.resume(current.id),bridge.resume(current.id)]);
assert.equal(rows.length,1,'repeated resume does not duplicate');
assert.equal((await bridge.list())[0].status,'active');
const resumed=(await bridge.list())[0];
await bridge.delete(resumed.id);
assert.equal((await bridge.list()).length,0,'explicit deletion is respected');
await bridge.restoreDefaults();
assert.equal((await bridge.list()).length,1,'default reset restores explicitly missing builtin');
await bridge.restoreDefaults();
assert.equal((await bridge.list()).length,1,'repeated default reset is idempotent');
// Restoring an unset baseline also clears a later per-task model override.
ctx.sessionController.selectModel=async()=>{};
const resetTask=(await bridge.list())[0];
await bridge.update({id:resetTask.id,model:{provider:'test',model:'temporary'}});
assert((await bridge.list())[0].model);
await bridge.restoreDefaults();
assert.equal((await bridge.list())[0].model,undefined,'default reset clears non-baseline model override');
bridge.stop();
console.log('PASS archive migration, one-off stop, builtin identity, pause/restart/resume, default reset and explicit delete');
