/* Check real host batching across delayed delivery and transferred buffers. */
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname,'../web/js/diablo-host.js'),'utf8');
async function scenario(transferred) {
  const messages=[], sandbox={performance,Date,ArrayBuffer,Uint8Array,console};
  sandbox.self=sandbox;sandbox.setInterval=()=>1;sandbox.clearInterval=()=>{};
  sandbox.DiabloSpawn=()=>Promise.resolve({_DApi_Init(){},_DApi_Render(){},HEAPU8:new Uint8Array(128)});
  vm.createContext(sandbox);vm.runInContext(source,sandbox);
  const host=sandbox.createDiabloHost((message,transfer)=>messages.push(transferred?structuredClone(message,{transfer}):message));
  await host.init({archive:new ArrayBuffer(4),saves:[],audioEnabled:false});
  function frame(x,y,color,text) {
    sandbox.DApi.draw_begin();sandbox.DApi.draw_blit(x,y,1,1,new Uint8Array(color));
    if(text)sandbox.DApi.draw_text(1,2,text,0xffffff);
    sandbox.DApi.draw_end();
  }
  frame(2,3,[10,20,30,255]);
  let renders=messages.filter(m=>m.action==='render');
  assert.equal(renders.length,1);
  assert.deepEqual(Array.from(renders[0].batch.images[0].bytes),[10,20,30,255]);
  for(let i=0;i<20;i++)frame(4,5,[i,40,50,255],String(i));
  frame(2,3,[70,80,90,255]);
  assert.equal(messages.filter(m=>m.action==='render').length,1,'slow delivery must keep only one outstanding render');
  host.acknowledge(999,null);
  assert.equal(messages.filter(m=>m.action==='render').length,1,'stale acknowledgement must not release the buffer');
  const first=renders[0], oldBuffer=first.batch.images[0].bytes.buffer;
  host.acknowledge(first.sequence,transferred?structuredClone(oldBuffer,{transfer:[oldBuffer]}):oldBuffer);
  renders=messages.filter(m=>m.action==='render');
  assert.equal(renders.length,2,'latest accumulated dirty pixels must follow acknowledgement');
  const rect=renders[1].batch.images[0];
  assert.deepEqual([rect.x,rect.y,rect.w,rect.h],[2,3,3,3]);
  const pixel=(x,y)=>Array.from(rect.bytes.subarray(((y-rect.y)*rect.w+x-rect.x)*4,((y-rect.y)*rect.w+x-rect.x)*4+4));
  assert.deepEqual(pixel(2,3),[70,80,90,255]);
  assert.deepEqual(pixel(4,5),[19,40,50,255],'earlier dirty rectangles must survive coalescing');
  assert.equal(renders[1].batch.text.length,0,'the latest frame owns the text overlay');
  const secondBuffer=rect.bytes.buffer;
  host.acknowledge(renders[1].sequence,transferred?structuredClone(secondBuffer,{transfer:[secondBuffer]}):secondBuffer);
  sandbox.DApi.draw_begin();sandbox.DApi.draw_text(1,2,'ready',0xffffff);sandbox.DApi.draw_end();
  renders=messages.filter(m=>m.action==='render');
  assert.equal(renders.length,3);assert.equal(renders[2].batch.images.length,0);
  assert.equal(renders[2].batch.text[0].text,'ready');
  host.acknowledge(renders[2].sequence,null);
  sandbox.DApi.create_sound(1,new Uint8Array(4));
  assert.equal(messages.filter(m=>m.action==='audio').length,0);
  host.stop();
}
async function indexedScenario(transferred) {
  const messages=[], sandbox={performance,Date,ArrayBuffer,Uint8Array,Uint32Array,console};
  sandbox.self=sandbox;sandbox.setInterval=()=>1;sandbox.clearInterval=()=>{};
  sandbox.DiabloSpawn=()=>Promise.resolve({_DApi_Init(){},_DApi_Render(){},HEAPU8:new Uint8Array(128)});
  vm.createContext(sandbox);vm.runInContext(source,sandbox);
  const host=sandbox.createDiabloHost((message,transfer)=>messages.push(transferred?structuredClone(message,{transfer}):message));
  await host.init({archive:new ArrayBuffer(4),indexed:true,audioEnabled:false});
  const palette=new Uint8Array(1024);palette.set([10,20,30,0],17*4);palette.set([40,50,60,7],18*4);
  sandbox.DApi.draw_begin();sandbox.DApi.draw_indexed(2,3,1,2,new Uint8Array([17,99,99,18]),3,palette);sandbox.DApi.draw_end();
  let renders=messages.filter(m=>m.action==='render');assert.equal(renders.length,1);
  const first=renders[0], rect=first.batch.images[0];
  assert.equal(rect.format,'indexed');assert.deepEqual([rect.x,rect.y,rect.w,rect.h],[0,0,640,480]);
  assert.equal(rect.bytes[3*640+2],17);assert.equal(rect.bytes[4*640+2],18,'borrowed source stride must be respected');
  assert.equal(first.batch.palette.buffer,rect.bytes.buffer,'palette must share the single transferred frame buffer');
  assert.deepEqual(Array.from(first.batch.palette.subarray(17*4,17*4+4)),[10,20,30,255]);
  palette.set([70,80,90,0],17*4);
  sandbox.DApi.draw_begin();sandbox.DApi.draw_indexed(4,5,1,1,new Uint8Array([18]),1,palette);sandbox.DApi.draw_end();
  assert.equal(messages.filter(m=>m.action==='render').length,1);
  const returnBuffer=rect.bytes.buffer;
  host.acknowledge(first.sequence,transferred?structuredClone(returnBuffer,{transfer:[returnBuffer]}):returnBuffer);
  renders=messages.filter(m=>m.action==='render');assert.equal(renders.length,2);
  const second=renders[1].batch.images[0];
  assert.deepEqual([second.x,second.y,second.w,second.h],[0,0,640,480],'palette changes must recolor retained pixels outside the newest dirty rectangle');
  assert.equal(second.bytes[3*640+2],17);assert.equal(second.bytes[5*640+4],18);
  assert.deepEqual(Array.from(second.palette.subarray(17*4,17*4+4)),[70,80,90,255]);
  host.stop();
}
(async()=>{await scenario(true);await scenario(false);await indexedScenario(true);await indexedScenario(false);console.log('RGBA/indexed Worker-transfer and main-thread frame protocols passed.');})().catch(e=>{console.error(e);process.exitCode=1;});
