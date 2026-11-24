import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.ts';
import { Editor } from '../server/editor.ts';
import { createApp } from '../server/http.ts';
import { MockProvider } from '../server/providers.ts';
import { convert } from '../server/images.ts';
import type { Project, Version } from '../server/types.ts';
import { inProcessRequest } from './transport.ts';

test('HTTP workflow: upload, reopen, clarify mock target, export; rejects invalid inputs and cross-origin access',async()=>{
  const root=await mkdtemp(join(tmpdir(),'photo-http-')),store=new Store(root),editor=new Editor(store,new MockProvider());const server=createApp(editor);
  const fetchLocal=(path:string,init?:RequestInit)=>inProcessRequest(server,path,init);
  const request=(path:string,body?:unknown)=>fetchLocal(path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);
  try {
    assert.equal((await request('/api/health')).status,200);
    const settings=await (await request('/api/settings')).json();assert.equal(settings.providerMode,'mock');
    const blocked=await fetchLocal('/api/projects',{method:'POST',headers:{Origin:'https://untrusted.example'}});assert.equal(blocked.status,403);
    assert.equal((await request('/api/projects',{bad:'not raw bytes'})).status,415);
    const bytes=await convert(['-size','120x80','gradient:teal-gold','png:-']);
    const response=await fetchLocal('/api/projects',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent('test photo.png')},body:new Uint8Array(bytes)});assert.equal(response.status,201);
    const imported=await response.json() as {project:Project;versions:Version[]};const p=imported.project;
    assert.equal((await (await request('/api/projects')).json()).length,1);
    const job=await (await request(`/api/projects/${p.id}/jobs`,{prompt:'Try the mock',baseVersionId:p.activeVersionId,idempotencyKey:crypto.randomUUID()})).json();
    for(let i=0;i<100;i++){const state=await (await request(`/api/projects/${p.id}/jobs/${job.id}`)).json();if(state.status==='clarification'){assert.equal(state.plan.targets[0].maskPngBase64,undefined);break;}assert.notEqual(state.status,'failed',state.error);await new Promise(resolve=>setTimeout(resolve,20));}
    const selected=await request(`/api/projects/${p.id}/jobs/${job.id}/clarify`,{targetId:'demo-region'});assert.equal(selected.status,202);
    let versionId:string|undefined;
    for(let i=0;i<100;i++){const state=await (await request(`/api/projects/${p.id}/jobs/${job.id}`)).json();if(state.status==='ready'){versionId=state.versionId;break;}assert.notEqual(state.status,'failed',state.error);await new Promise(resolve=>setTimeout(resolve,20));}
    assert.ok(versionId);
    for(const format of ['png','jpeg','tiff']){
      const result=await request(`/api/projects/${p.id}/exports`,{versionId,format,quality:85});assert.equal(result.status,201,await result.clone().text());const output=await result.json();
      assert.equal(output.width,120);assert.equal(output.height,80);
      const download=await fetchLocal(output.url);assert.equal(download.status,200);assert.match(download.headers.get('content-disposition')!,/attachment/);assert.equal(download.headers.get('content-type'),`image/${format}`);assert.ok((await download.arrayBuffer()).byteLength>100);
    }
    assert.equal((await request(`/api/projects/${p.id}/exports`,{versionId,format:'cr3'})).status,400);
    assert.equal((await request(`/api/projects/${p.id}/versions/not-owned/select`,{})).status,404);
    const originalAsset=await request(`/api/projects/${p.id}/assets/${p.sourceId}`);assert.equal(originalAsset.status,200);assert.deepEqual(Buffer.from(await originalAsset.arrayBuffer()),bytes);
    assert.equal((await request(`/api/projects/${p.id}`)).status,200);
  }finally{await editor.shutdown();store.close();await rm(root,{recursive:true,force:true});}
});
