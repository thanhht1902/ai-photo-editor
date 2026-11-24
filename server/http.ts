import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { Editor } from './editor.ts';
import { publicJob } from './store.ts';
import { AppError, invariant } from './types.ts';
import type { Project } from './types.ts';

async function body(req: IncomingMessage, limit: number): Promise<Buffer> {
  invariant(Number(req.headers['content-length'] || 0) <= limit, 'Upload exceeds the size limit.', 413);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; invariant(size <= limit, 'Request exceeds the size limit.', 413); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  invariant(req.headers['content-type']?.includes('application/json'), 'Expected application/json.', 415);
  try { const value = JSON.parse((await body(req, 32_000)).toString()); invariant(value && typeof value === 'object' && !Array.isArray(value), 'Expected a JSON object.'); return value; }
  catch (error) { if (error instanceof AppError) throw error; throw new AppError('Invalid JSON request.'); }
}
function send(res: ServerResponse, data: unknown, status = 200) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(data)); }
function text(value: unknown, field: string): string { invariant(typeof value === 'string', `${field} must be a string.`); return value; }
function filename(req: IncomingMessage) { try { return decodeURIComponent(String(req.headers['x-file-name'] || 'Untitled photo')).replace(/[\x00-\x1f/\\]/g, '_').slice(0,200); } catch { throw new AppError('Invalid file name.'); } }

export function createApp(editor: Editor, dist = resolve('dist')) {
  let heavyRequests = 0;
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      // Local deployment only: reject DNS rebinding and cross-origin writes.
      const host = req.headers.host || '';
      invariant(/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host), 'This build is restricted to localhost.', 403);
      if (req.headers.origin) {
        const origin = new URL(req.headers.origin);
        const allowed = origin.host === host || (origin.hostname === '127.0.0.1' && origin.port === '5173');
        invariant(allowed && origin.protocol === 'http:', 'Cross-origin request rejected.', 403);
      }
      invariant(req.headers['sec-fetch-site'] !== 'cross-site', 'Cross-site request rejected.', 403);
      const url = new URL(req.url || '/', `http://${host}`), parts = url.pathname.split('/').filter(Boolean);
      const method = req.method || 'GET';
      if (parts[0] === 'api') {
        if (method === 'GET' && url.pathname === '/api/health') { send(res, {status:'ok', deployment:'localhost-only', imageEngine:'ImageMagick Q16', liveProviderValidated:false}); return; }
        if (method === 'GET' && url.pathname === '/api/settings') {
          send(res, { providerMode: editor.provider.mode, plannerConfigured: !!process.env.PLANNER_URL, editorConfigured: !!process.env.EDITOR_URL, rawSupported: false, operations: ['remove_object'], maxUploadBytes: 100_000_000, maxPixels:30_000_000 }); return;
        }
        if (method === 'POST' && url.pathname === '/api/settings/check') {
          const result: Record<string, unknown> = {};
          for (const role of ['planner','editor'] as const) try { result[role] = {ok:true,capabilities:await editor.provider.capabilities(role)}; } catch (error) { result[role] = {ok:false,error:error instanceof AppError ? error.message : 'Connection check failed.'}; }
          send(res, { ...result, note: 'Schema discovery only. A real image-editing integration test is still required.' }); return;
        }
        if (parts[1] === 'projects' && parts.length === 2 && method === 'GET') { send(res, editor.store.all<Project>('projects').reverse()); return; }
        if (parts[1] === 'projects' && parts.length === 2 && method === 'POST') {
          invariant(heavyRequests < 1, 'An upload or export is already running. Try again shortly.', 429); heavyRequests++;
          try { const bytes = await body(req,100_000_000); const project = await editor.importSource(bytes, filename(req)); send(res, editor.store.snapshot(project.id),201); } finally { heavyRequests--; } return;
        }
        if (parts[1] === 'projects' && parts[2]) {
          const projectId = parts[2]; editor.store.project(projectId);
          if (parts.length === 3 && method === 'GET') { send(res, editor.store.snapshot(projectId)); return; }
          if (parts[3] === 'references' && parts.length === 4 && method === 'POST') {
            invariant(heavyRequests < 1, 'An upload or export is already running. Try again shortly.', 429); heavyRequests++;
            try { await editor.addReference(projectId,await body(req,100_000_000),filename(req)); send(res, editor.store.snapshot(projectId),201); } finally { heavyRequests--; } return;
          }
          if (parts[3] === 'jobs' && parts.length === 4 && method === 'POST') { const data = await json(req); send(res,publicJob(editor.submit(projectId,text(data.baseVersionId,'baseVersionId'),text(data.prompt,'prompt'),text(data.idempotencyKey,'idempotencyKey'))),202); return; }
          if (parts[3] === 'jobs' && parts[4]) {
            if (parts.length === 5 && method === 'GET') { send(res,publicJob(editor.store.job(parts[4],projectId))); return; }
            if (parts[5] === 'cancel' && parts.length === 6 && method === 'POST') { send(res, publicJob(editor.cancel(projectId,parts[4]))); return; }
            if (parts[5] === 'clarify' && parts.length === 6 && method === 'POST') { const data = await json(req); send(res,publicJob(editor.clarify(projectId,parts[4],text(data.targetId,'targetId'))),202); return; }
          }
          if (parts[3] === 'versions' && parts[4] && parts[5] === 'select' && parts.length === 6 && method === 'POST') { editor.store.select(projectId,parts[4]); send(res,editor.store.snapshot(projectId)); return; }
          if (parts[3] === 'exports' && parts.length === 4 && method === 'POST') {
            invariant(heavyRequests < 1, 'An upload or export is already running. Try again shortly.', 429); heavyRequests++;
            try { const data = await json(req); const format = text(data.format,'format'); invariant(format === 'png' || format === 'jpeg' || format === 'tiff', 'Choose PNG, JPEG, or TIFF.'); const asset = await editor.export(projectId,text(data.versionId,'versionId'),format,data.quality === undefined ? 92 : Number(data.quality)); send(res,{assetId:asset.id,url:`/api/projects/${projectId}/assets/${asset.id}?download=1`,width:asset.width,height:asset.height,precision:asset.precision},201); } finally { heavyRequests--; } return;
          }
          if (parts[3] === 'assets' && parts[4] && parts.length === 5 && method === 'GET') {
            const asset = editor.store.asset(parts[4],projectId), file = editor.store.path(asset);
            invariant(['source','preview','reference','export','baseline'].includes(asset.kind), 'This internal asset is not available for display.', 403);
            const info = await stat(file);
            res.setHeader('Content-Type',asset.mime); res.setHeader('Content-Length',info.size);
            if (url.searchParams.has('download')) res.setHeader('Content-Disposition',`attachment; filename="photo.${asset.mime.split('/')[1]}"; filename*=UTF-8''${encodeURIComponent(asset.name).replace(/'/g,'%27')}`);
            const stream = createReadStream(file); stream.on('error', () => res.destroy()); stream.pipe(res); return;
          }
        }
        throw new AppError('API route not found.',404);
      }
      invariant(method === 'GET', 'Method not allowed.',405);
      let decoded: string; try { decoded = decodeURIComponent(url.pathname); } catch { throw new AppError('Invalid path.'); }
      const file = resolve(dist, `.${decoded}`);
      invariant(file.startsWith(dist + sep) || file === dist, 'Path is outside the application.',403);
      const target = extname(file) ? file : resolve(dist,'index.html');
      let bytes: Buffer;
      try { bytes = await readFile(target); } catch { throw new AppError('Web app not built. Run npm run build, or open http://127.0.0.1:5173 with npm run dev:web.',404); }
      const types: Record<string,string> = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
      res.setHeader('Content-Type',types[extname(target)] || 'application/octet-stream'); res.end(bytes);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      send(res,{error:error instanceof AppError ? error.message : 'Request failed. Check local file permissions and application configuration.'},error instanceof AppError ? error.status : 500);
    }
  });
}
