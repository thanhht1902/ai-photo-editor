import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.ts';
import { Editor } from '../server/editor.ts';
import { MockProvider } from '../server/providers.ts';
import type { EditInput } from '../server/providers.ts';
import type { Job, Version, Asset } from '../server/types.ts';
import { checksum, convert, rgba, verifyProtected } from '../server/images.ts';

class CountingFake extends MockProvider {
  calls=0; fault:'none'|'dimensions'|'malformed'|'timeout'='none';
  beforeReturn?:()=>void;
  release?:()=>void;
  block=false;
  async edit(input:EditInput,signal:AbortSignal) {
    this.calls++;
    if(this.block)await new Promise<void>(resolve=>{this.release=resolve;signal.addEventListener('abort',()=>resolve(),{once:true});});
    signal.throwIfAborted();
    if(this.fault==='timeout'){const {AppError}=await import('../server/types.ts');throw new AppError('Provider timed out.',504);}
    const result=await super.edit(input,signal);this.beforeReturn?.();
    if(this.fault==='dimensions')result.imagePngBase64=(await convert(['-size','3x5','xc:red','png:-'])).toString('base64');
    if(this.fault==='malformed')result.imagePngBase64=Buffer.from('not an image').toString('base64');
    return result;
  }
}
async function setup() {
  const root=await mkdtemp(join(tmpdir(),'photo-editor-'));const store=new Store(root),provider=new CountingFake(),editor=new Editor(store,provider);
  return {root,store,provider,editor,async close(){await editor.shutdown();store.close();await rm(root,{recursive:true,force:true});}};
}
async function until(store:Store,id:string,projectId:string,statuses:string[],timeout=60_000) {
  const start=Date.now();while(Date.now()-start<timeout){const job=store.job(id,projectId);if(statuses.includes(job.status))return job;await new Promise(resolve=>setTimeout(resolve,25));}
  throw new Error(`Job ${id} did not reach ${statuses.join(', ')}; last state ${store.job(id,projectId).status}`);
}
async function submitAndChoose(ctx:Awaited<ReturnType<typeof setup>>,projectId:string,key=crypto.randomUUID()) {
  const project=ctx.store.project(projectId);const job=ctx.editor.submit(projectId,project.activeVersionId,'Remove an object',key);
  const choice=await until(ctx.store,job.id,projectId,['clarification','failed']);assert.equal(choice.status,'clarification',choice.error);
  ctx.editor.clarify(projectId,job.id,choice.plan!.targets[0].id);return job;
}

test('24 MP mock pipeline keeps original checksum, dimensions, protected pixels and full-resolution exports', {timeout:240_000}, async t => {
  const ctx=await setup();const started=Date.now();
  try {
    const source=await convert(['-size','6000x4000','gradient:#63797c-#d4b38b','-depth','8','jpeg:-']);
    const sourceHash=checksum(source),project=await ctx.editor.importSource(source,'24mp.jpg');
    assert.equal(project.width,6000);assert.equal(project.height,4000);
    const original=ctx.store.asset(project.sourceId,project.id);assert.equal(original.checksum,sourceHash);
    const base=ctx.store.version(project.activeVersionId,project.id);
    const job=await submitAndChoose(ctx,project.id);
    const completed=await until(ctx.store,job.id,project.id,['ready','failed'],180_000);assert.equal(completed.status,'ready',completed.error);
    const selected=ctx.store.project(project.id);assert.notEqual(selected.activeVersionId,base.id);
    const next=ctx.store.version(selected.activeVersionId,project.id);assert.equal(next.parentId,base.id);assert.equal(next.operation.type,'demo_patch');
    const maskAsset=ctx.store.asset(String(next.operation.maskId),project.id);
    const mask=await convert([`png:${ctx.store.path(maskAsset)}`,'-depth','8','gray:-']);
    const originalPixels=await rgba(ctx.store.path(ctx.store.asset(base.imageId,project.id)),project);
    const newPixels=await rgba(ctx.store.path(ctx.store.asset(next.imageId,project.id)),project);
    verifyProtected(originalPixels,newPixels,mask);assert.notDeepEqual(newPixels,originalPixels);
    const exported=await ctx.editor.export(project.id,next.id,'png');assert.equal(exported.width,6000);assert.equal(exported.height,4000);assert.equal(exported.precision,16);
    assert.deepEqual(await readFile(ctx.store.path(exported)),await readFile(ctx.store.path(ctx.store.asset(next.imageId,project.id))));
    assert.equal(checksum(await readFile(ctx.store.path(original))),sourceHash);
    t.diagnostic(`24MP mock import/edit/validation/export: ${((Date.now()-started)/1000).toFixed(2)}s; Node maxRSS ${(process.resourceUsage().maxRSS/1024).toFixed(0)} MiB (excludes simultaneous native-process memory); provider calls ${ctx.provider.calls}; paid usage 0.`);
  }finally{await ctx.close();}
});

test('duplicate retries are idempotent, restore persists, and reference names remain stable after reopening',async()=>{
  const ctx=await setup();
  try{
    const bytes=await convert(['-size','120x80','gradient:red-blue','png:-']);const p=await ctx.editor.importSource(bytes,'source.png');
    const refA=await ctx.editor.addReference(p.id,bytes,'poster.png'),refB=await ctx.editor.addReference(p.id,bytes,'second.png');assert.equal(refA.name,'Reference A');assert.equal(refB.name,'Reference B');
    assert.ok(ctx.store.all<Asset>('assets',p.id).some(a=>a.kind==='preview' && a.provenance.referenceId===refA.id));
    assert.deepEqual(await readFile(ctx.store.path(refA)),bytes);
    const key=crypto.randomUUID();const job=await submitAndChoose(ctx,p.id,key);const result=await until(ctx.store,job.id,p.id,['ready','failed']);assert.equal(result.status,'ready',result.error);
    const duplicate=ctx.editor.submit(p.id,p.activeVersionId,'Remove an object',key);assert.equal(duplicate.id,job.id);assert.equal(ctx.provider.calls,1);
    assert.throws(()=>ctx.editor.submit(p.id,p.activeVersionId,'different',key),/different edit/);
    ctx.store.select(p.id,p.activeVersionId);assert.equal(ctx.store.project(p.id).activeVersionId,p.activeVersionId);
    await ctx.editor.shutdown();ctx.store.close();
    const reopened=new Store(ctx.root);assert.equal(reopened.project(p.id).activeVersionId,p.activeVersionId);assert.equal(reopened.all<Version>('versions',p.id).length,2);assert.equal(reopened.asset(refA.id,p.id).name,'Reference A');reopened.close();
    // close() is replaced because the original database was already closed.
    ctx.close=async()=>{await rm(ctx.root,{recursive:true,force:true});};
  }finally{await ctx.close();}
});

test('late results remain a branch and cannot overwrite a newer selection',async()=>{
  const ctx=await setup();try{
    const p=await ctx.editor.importSource(await convert(['-size','120x80','xc:gray','png:-']),'source.png');
    ctx.provider.beforeReturn=()=>ctx.store.select(p.id,p.activeVersionId);
    const job=await submitAndChoose(ctx,p.id);const result=await until(ctx.store,job.id,p.id,['ready','failed']);assert.equal(result.status,'ready',result.error);
    assert.equal(ctx.store.project(p.id).activeVersionId,p.activeVersionId);assert.equal(ctx.store.all('versions',p.id).length,2);assert.match(result.warnings.join(' '),/remains active/);
  }finally{await ctx.close();}
});

for(const fault of ['dimensions','malformed','timeout'] as const)test(`${fault} provider failure leaves baseline and version history intact`,async()=>{
  const ctx=await setup();try{
    const p=await ctx.editor.importSource(await convert(['-size','120x80','xc:gray','png:-']),'source.png');ctx.provider.fault=fault;
    const job=await submitAndChoose(ctx,p.id);const result=await until(ctx.store,job.id,p.id,['ready','failed']);assert.equal(result.status,'failed');assert.ok(result.error);assert.equal(ctx.store.project(p.id).activeVersionId,p.activeVersionId);assert.equal(ctx.store.all('versions',p.id).length,1);
  }finally{await ctx.close();}
});

test('cancellation during provider execution never commits a version',async()=>{
  const ctx=await setup();try{
    const p=await ctx.editor.importSource(await convert(['-size','120x80','xc:gray','png:-']),'source.png');ctx.provider.block=true;
    const job=await submitAndChoose(ctx,p.id);await until(ctx.store,job.id,p.id,['editing']);
    ctx.editor.cancel(p.id,job.id);await ctx.editor.shutdown();assert.equal(ctx.store.job(job.id,p.id).status,'cancelled');assert.equal(ctx.store.all('versions',p.id).length,1);
  }finally{await ctx.close();}
});

test('restart marks interrupted work failed without replaying a paid call',async()=>{
  const ctx=await setup();try{
    const p=await ctx.editor.importSource(await convert(['-size','12x8','xc:gray','png:-']),'source.png');
    const job:Job={id:crypto.randomUUID(),projectId:p.id,baseVersionId:p.activeVersionId,prompt:'test',status:'editing',idempotencyKey:crypto.randomUUID(),selectionEpoch:0,providerMode:'mock',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),warnings:[]};ctx.store.insertJob(job);
    const reopened=new Store(ctx.root);assert.equal(reopened.job(job.id,p.id).status,'failed');assert.match(reopened.job(job.id,p.id).error!,/restarted/);assert.equal(ctx.provider.calls,0);reopened.close();
  }finally{await ctx.close();}
});

test('corrupted original refuses edits and exports; project asset ownership is enforced',async()=>{
  const ctx=await setup();try{
    const bytes=await convert(['-size','12x8','xc:gray','png:-']);const p=await ctx.editor.importSource(bytes,'source.png');const other=await ctx.editor.importSource(bytes,'other.png');
    assert.throws(()=>ctx.store.asset(p.sourceId,other.id),/does not belong/);
    const {writeFile}=await import('node:fs/promises');await writeFile(ctx.store.path(ctx.store.asset(p.sourceId,p.id)),Buffer.from('tampered'));
    await assert.rejects(ctx.editor.export(p.id,p.activeVersionId,'png'),/checksum mismatch/);
    const job=ctx.editor.submit(p.id,p.activeVersionId,'remove',crypto.randomUUID());const failed=await until(ctx.store,job.id,p.id,['failed']);assert.match(failed.error!,/checksum mismatch/);assert.equal(ctx.store.all('versions',p.id).length,1);
  }finally{await ctx.close();}
});
