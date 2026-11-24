import { Readable, Writable } from 'node:stream';
import type { Server } from 'node:http';

/** Exercise the real HTTP request handler without binding a socket in restricted CI. */
export async function inProcessRequest(server: Server, path: string, init: RequestInit = {}): Promise<Response> {
  const input = init.body ? Buffer.from(init.body as Uint8Array | string) : Buffer.alloc(0);
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  const req = Object.assign(Readable.from(input.length ? [input] : []), { method: init.method || 'GET', url: path, headers: { host:'127.0.0.1:8787', 'content-length':String(input.length), ...headers } });
  const chunks:Buffer[] = [], responseHeaders = new Headers(); let status=200, sent=false;
  const res = Object.assign(new Writable({write(chunk, _encoding, callback){chunks.push(Buffer.from(chunk));callback();}}), {
    setHeader(name:string,value:unknown){responseHeaders.set(name,String(value));},
    writeHead(code:number,values:Record<string,unknown>){status=code;for(const [key,value] of Object.entries(values))responseHeaders.set(key,String(value));sent=true;},
  });
  Object.defineProperty(res,'headersSent',{get:()=>sent});
  const finished = new Promise<void>((resolve,reject)=>{res.on('finish',resolve);res.on('error',reject);});
  server.emit('request',req,res); await finished;
  return new Response(Buffer.concat(chunks),{status,headers:responseHeaders});
}
