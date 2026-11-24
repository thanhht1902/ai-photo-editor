import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composite, contextBox, convert, encodeRGBA, inspect, mapBox, normalize, rgba, scaleMask, validateBox, verifyProtected } from '../server/images.ts';

test('coordinate mapping handles non-integer preview scale, padded context, and image bounds', () => {
  assert.deepEqual(mapBox({x:100,y:50,width:200,height:100},{width:1400,height:933},{width:6000,height:4000}),{x:428,y:214,width:858,height:430});
  assert.deepEqual(contextBox({x:0,y:0,width:10,height:20},{width:100,height:80}),{x:0,y:0,width:42,height:52});
  assert.throws(()=>validateBox({x:-1,y:0,width:3,height:3},{width:10,height:10}),/outside/);
  assert.throws(()=>validateBox({x:0.5,y:0,width:3,height:3},{width:10,height:10}),/integers/);
  const scaled=scaleMask(Buffer.from([0,0,0,255]),{width:2,height:2},{width:4,height:4},{x:2,y:2,width:2,height:2});
  assert.deepEqual([...scaled],[0,0,0,0,0,0,0,0,0,0,255,255,0,0,255,255]);
  assert.throws(()=>scaleMask(Buffer.from([255]),{width:1,height:1},{width:2,height:2},{x:1,y:1,width:1,height:1}),/outside/);
  assert.throws(()=>scaleMask(Buffer.alloc(4),{width:2,height:2},{width:2,height:2},{x:0,y:0,width:2,height:2}),/empty/);
});

test('feathered compositing respects straight alpha and preserves all zero-coverage pixels', () => {
  const base=Buffer.alloc(3*8),patch=Buffer.alloc(3*8);
  for(let i=0;i<3;i++){base.writeUInt16BE(1000,i*8);base.writeUInt16BE(65535,i*8+6);patch.writeUInt16BE(60000,i*8);patch.writeUInt16BE(32768,i*8+6);}
  const mask=Buffer.from([0,128,255]);
  const output=composite(base,patch,mask,{width:3,height:1},{x:0,y:0,width:3,height:1});
  assert.deepEqual(output.subarray(0,8),base.subarray(0,8));
  assert.equal(output.readUInt16BE(16),60000);assert.equal(output.readUInt16BE(22),32768);
  assert.ok(output.readUInt16BE(8)>1000 && output.readUInt16BE(8)<60000);
  assert.ok(output.readUInt16BE(14)>32768 && output.readUInt16BE(14)<65535);
  verifyProtected(base,output,mask);
  output[0]=1;assert.throws(()=>verifyProtected(base,output,mask),/Protected pixels changed/);
});

test('16-bit PNG round-trip preserves sub-8-bit channel values and transparent RGB', async () => {
  const dir=await mkdtemp(join(tmpdir(),'photo-depth-'));
  try {
    const size={width:3,height:2}, pixels=Buffer.alloc(48);
    for(let i=0;i<6;i++){pixels.writeUInt16BE(1000+i,i*8);pixels.writeUInt16BE(32101+i,i*8+2);pixels.writeUInt16BE(64499-i,i*8+4);pixels.writeUInt16BE(i===0?0:50001,i*8+6);}
    const path=join(dir,'test.png');await encodeRGBA(pixels,size,path);
    assert.equal((await inspect(path)).depth,16);assert.deepEqual(await rgba(path,size),pixels);
    const tif=join(dir,'test.tif');await convert([`png:${path}`,'-depth','16','-compress','Zip',`tiff:${tif}`]);
    const bytes=await convert([`tiff:${tif}`,'-alpha','on','-depth','16','-endian','MSB','rgba:-']);assert.deepEqual(bytes,pixels);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('EXIF orientation becomes an oriented baseline without changing source bytes', async () => {
  const dir=await mkdtemp(join(tmpdir(),'photo-orient-'));
  try {
    // JPEG APP1 with a real TIFF orientation entry, independent of ImageMagick metadata setters.
    const jpeg=await convert(['-size','80x40','gradient:red-blue','jpeg:-']);
    const tiff=Buffer.from([0x49,0x49,42,0,8,0,0,0,1,0,0x12,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0]);
    const exif=Buffer.concat([Buffer.from('Exif\0\0'),tiff]);const marker=Buffer.alloc(4);marker.writeUInt16BE(0xffe1);marker.writeUInt16BE(exif.length+2,2);
    const bytes=Buffer.concat([jpeg.subarray(0,2),marker,exif,jpeg.subarray(2)]);
    const source=join(dir,'source.jpg');const {writeFile}=await import('node:fs/promises');await writeFile(source,bytes);
    const result=await normalize(source,bytes,join(dir,'base.png'));
    assert.equal(result.width,40);assert.equal(result.height,80);assert.deepEqual(await readFile(source),bytes);
  } finally {await rm(dir,{recursive:true,force:true});}
});
