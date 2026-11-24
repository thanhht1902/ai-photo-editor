import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpProvider, decodeBase64, validatePlan } from '../server/providers.ts';
import type { PlanInput } from '../server/providers.ts';
import { convert } from '../server/images.ts';

test('planner validation rejects invented geometry, unsupported operations, malformed masks and changed versions',async()=>{
  const mask=(await convert(['-size','10x8','xc:white','png:-'])).toString('base64');
  const input:PlanInput={projectId:'project',baseVersionId:'base',prompt:'remove',preview:{data:'',mime:'image/jpeg',width:10,height:8},history:[],correlationId:'job'};
  const plan={operation:'remove_object',baseVersionId:'base',coordinateSpace:{width:10,height:8},uncertain:false,targets:[{id:'t',label:'object',box:{x:0,y:0,width:10,height:8},maskPngBase64:mask}]};
  assert.equal(validatePlan(plan,input).targets.length,1);
  assert.throws(()=>validatePlan({...plan,operation:'insert_reference'},input),/supports object removal/);
  assert.throws(()=>validatePlan({...plan,baseVersionId:'other'},input),/wrong base version/);
  assert.throws(()=>validatePlan({...plan,coordinateSpace:{width:100,height:80}},input),/coordinates/);
  assert.throws(()=>validatePlan({...plan,targets:[{...plan.targets[0],box:{x:8,y:0,width:10,height:8}}]},input),/outside/);
  assert.throws(()=>validatePlan({...plan,targets:[{...plan.targets[0],maskPngBase64:'not_base64'}]},input),/base64/);
  assert.throws(()=>validatePlan({...plan,targets:[plan.targets[0],plan.targets[0]]},input),/duplicate/);
  assert.throws(()=>decodeBase64('AAAA',1),/size limit/);
  const result=validatePlan({...plan,tool:'shell',path:'/etc/passwd'},input);assert.equal('tool' in result,false);assert.equal('path' in result,false);
});

test('HTTP adapter validates declared capabilities, redacts upstream errors, and handles timeout/malformed JSON',async()=>{
  const saved={...process.env};let state='ok';let authorization='';
  const fakeFetch:typeof fetch=async (_url,init)=>{
    authorization=new Headers(init?.headers).get('Authorization') || '';
    assert.equal(init?.redirect,'error');
    if(state==='timeout')return new Promise((_resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('timeout harness failed')),500);init!.signal!.addEventListener('abort',()=>{clearTimeout(timer);reject(init!.signal!.reason);},{once:true});});
    if(state==='error')return Response.json({secret:'sensitive-upstream-value'},{status:401});
    if(state==='redirect')throw new Error('Disallowed redirect');
    if(state==='json')return new Response('invalid',{headers:{'Content-Type':'application/json'}});
    return Response.json({roles:['plan','segment','edit'],operations:['remove_object'],acceptedFormats:['image/jpeg','image/png'],outputFormats:['image/png'],mask:state!=='mask',maxInputPixels:state==='unknown'?null:1_000_000,maxOutputPixels:1_000_000});
  };
  try{
    process.env.EDITOR_URL='http://127.0.0.1:9999/adapter/';process.env.EDITOR_API_KEY='backend-only-test-key';process.env.ALLOW_LOCAL_PROVIDER_HTTP='true';process.env.PROVIDER_TIMEOUT_MS='100';
    const provider=new HttpProvider(fakeFetch);assert.equal((await provider.capabilities('editor')).mask,true);assert.equal(authorization,'Bearer backend-only-test-key');
    state='unknown';await assert.rejects(provider.capabilities('editor'),/limits are unknown/);
    state='mask';await assert.rejects(provider.capabilities('editor'),/mask support/);
    state='json';await assert.rejects(provider.capabilities('editor'),/malformed JSON/);
    state='error';await assert.rejects(provider.capabilities('editor'),e=>e instanceof Error && /HTTP 401/.test(e.message) && !e.message.includes('sensitive'));
    state='redirect';await assert.rejects(provider.capabilities('editor'),/connection failed/);
    state='timeout';await assert.rejects(provider.capabilities('editor'),/timed out/);
    process.env.ALLOW_LOCAL_PROVIDER_HTTP='false';await assert.rejects(provider.capabilities('editor'),/HTTPS/);
    process.env.EDITOR_URL='https://user:password@example.com/';await assert.rejects(provider.capabilities('editor'),/HTTPS/);
  }finally{
    for(const key of ['EDITOR_URL','EDITOR_API_KEY','ALLOW_LOCAL_PROVIDER_HTTP','PROVIDER_TIMEOUT_MS'])if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];
  }
});
