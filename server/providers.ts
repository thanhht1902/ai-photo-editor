import { AppError, invariant } from './types.ts';
import { convert, validateBox } from './images.ts';
import type { RemovalPlan, Size } from './types.ts';

export type Capabilities = {
  roles: string[]; operations: string[]; acceptedFormats: string[]; outputFormats: string[];
  maxInputPixels: number; maxOutputPixels: number; mask: boolean;
};
export type PlanInput = { projectId: string; baseVersionId: string; prompt: string; preview: { data: string; mime: 'image/jpeg' } & Size; history: { role: string; text: string }[]; correlationId: string };
export type EditInput = { prompt: string; source: { data: string; mime: 'image/png'; bitDepth: 8 } & Size; mask: { data: string; mime: 'image/png'; semantics: 'white-is-write' }; outputSize: Size; correlationId: string; idempotencyKey: string };
export type EditResult = { imagePngBase64: string; providerJobId?: string; warnings: string[]; usage?: Record<string, unknown> };
export interface Provider {
  mode: 'mock' | 'http' | 'test';
  capabilities(role: 'planner' | 'editor', signal?: AbortSignal): Promise<Capabilities>;
  plan(input: PlanInput, signal: AbortSignal): Promise<RemovalPlan>;
  edit(input: EditInput, signal: AbortSignal): Promise<EditResult>;
}
export function decodeBase64(value: unknown, maxBytes = 100_000_000): Buffer {
  invariant(typeof value === 'string' && value.length > 0 && value.length <= Math.ceil(maxBytes / 3) * 4 && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value), 'Provider returned invalid or oversized base64 image data.', 422);
  const bytes = Buffer.from(value, 'base64'); invariant(bytes.length <= maxBytes, 'Provider image exceeds the size limit.', 413); return bytes;
}
export function validatePlan(value: unknown, input: PlanInput): RemovalPlan {
  invariant(value && typeof value === 'object', 'Planner returned an invalid plan.', 422);
  const plan = value as RemovalPlan;
  invariant(plan.operation === 'remove_object', 'This milestone supports object removal. Reference insertion and global adjustments are not available yet.', 422);
  invariant(plan.baseVersionId === input.baseVersionId, 'Planner used the wrong base version.', 422);
  invariant(plan.coordinateSpace?.width === input.preview.width && plan.coordinateSpace?.height === input.preview.height, 'Planner coordinates do not match the planning preview.', 422);
  invariant(typeof plan.uncertain === 'boolean' && Array.isArray(plan.targets) && plan.targets.length > 0 && plan.targets.length <= 8, 'Planner must return one to eight segmented candidates, or explain that localization is unavailable.', 422);
  const ids = new Set<string>();
  for (const target of plan.targets) {
    invariant(typeof target.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(target.id) && !ids.has(target.id), 'Planner returned invalid or duplicate target identifiers.', 422); ids.add(target.id);
    invariant(typeof target.label === 'string' && target.label.length > 0 && target.label.length <= 200, 'Planner returned an invalid target label.', 422);
    validateBox(target.box, plan.coordinateSpace); decodeBase64(target.maskPngBase64, 8_000_000);
  }
  invariant(plan.question === undefined || (typeof plan.question === 'string' && plan.question.length <= 1000), 'Invalid clarification question.', 422);
  // Rebuild the schema: never retain provider-selected paths, tools, or code.
  return { operation: 'remove_object', baseVersionId: input.baseVersionId, coordinateSpace: { width: input.preview.width, height: input.preview.height }, uncertain: plan.uncertain, question: plan.question, targets: plan.targets.map(t => ({ id: t.id, label: t.label, box: { x:t.box.x, y:t.box.y, width:t.box.width, height:t.box.height }, maskPngBase64: t.maskPngBase64 })) };
}
export class HttpProvider implements Provider {
  mode = 'http' as const;
  fetcher: typeof fetch;
  constructor(fetcher: typeof fetch = fetch) { this.fetcher = fetcher; }
  endpoint(role: 'planner' | 'editor'): URL {
    const value = role === 'planner' ? process.env.PLANNER_URL : process.env.EDITOR_URL;
    invariant(value, `${role === 'planner' ? 'Target localization' : 'Image editing'} is not configured. Set ${role.toUpperCase()}_URL and ${role.toUpperCase()}_API_KEY on the backend; see Settings and docs/provider-contract.md.`, 503);
    let url: URL;
    try { url = new URL(value.endsWith('/') ? value : value + '/'); } catch { throw new AppError('Invalid provider endpoint configuration.', 503); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    invariant(!url.username && !url.password && !url.search && !url.hash && (url.protocol === 'https:' || (url.protocol === 'http:' && local && process.env.ALLOW_LOCAL_PROVIDER_HTTP === 'true')), 'Provider requires HTTPS, or explicit ALLOW_LOCAL_PROVIDER_HTTP for a trusted loopback endpoint.', 503);
    return url;
  }
  async request(role: 'planner' | 'editor', route: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const url = new URL(route, this.endpoint(role));
    const key = process.env[`${role.toUpperCase()}_API_KEY`];
    const configuredTimeout = Number(process.env.PROVIDER_TIMEOUT_MS || 120000);
    invariant(Number.isFinite(configuredTimeout) && configuredTimeout >= 100 && configuredTimeout <= 600000, 'PROVIDER_TIMEOUT_MS must be between 100 and 600000.', 503);
    const timeout = AbortSignal.timeout(configuredTimeout);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.fetcher(url, { method: body ? 'POST' : 'GET', redirect: 'error', headers: { ...(body ? {'Content-Type':'application/json'} : {}), ...(key ? {Authorization: `Bearer ${key}`} : {}) }, body: body ? JSON.stringify(body) : undefined, signal: combined });
      invariant(response.ok, `Provider ${role} request failed (HTTP ${response.status}). Check connection and service limits.`, 502);
      invariant(response.headers.get('content-type')?.includes('application/json'), 'Provider must return application/json.', 502);
      invariant(response.body, 'Provider returned an empty response.', 502);
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; invariant(size <= 140_000_000, 'Provider response exceeds the limit.', 502); chunks.push(next.value); } }
      finally { await reader.cancel(); }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('Provider returned malformed JSON.', 502); }
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (signal?.aborted) throw new AppError('Job cancelled.', 409);
      if (timeout.aborted) throw new AppError('Provider timed out. Check provider usage before retrying.', 504);
      // Do not return upstream response bodies, URLs, credentials, or network exception text.
      throw new AppError('Provider connection failed. Check backend connection settings.', 502);
    }
  }
  async capabilities(role: 'planner' | 'editor', signal?: AbortSignal): Promise<Capabilities> {
    const value = await this.request(role, 'capabilities', undefined, signal) as Capabilities;
    invariant(value && Array.isArray(value.roles) && value.roles.includes(role === 'planner' ? 'plan' : 'edit') && (role !== 'planner' || value.roles.includes('segment')), `Provider does not declare the required ${role} role.`, 422);
    invariant(Array.isArray(value.operations) && value.operations.includes('remove_object'), 'Provider does not declare object-removal support.', 422);
    invariant(Number.isSafeInteger(value.maxInputPixels) && value.maxInputPixels > 0 && Number.isSafeInteger(value.maxOutputPixels) && value.maxOutputPixels > 0, 'Provider pixel limits are unknown; verify capabilities before editing.', 422);
    invariant(Array.isArray(value.acceptedFormats) && value.acceptedFormats.includes(role === 'planner' ? 'image/jpeg' : 'image/png'), 'Provider input format is unsupported.', 422);
    invariant(Array.isArray(value.outputFormats) && value.outputFormats.includes('image/png') && value.mask === true, 'This adapter requires explicit PNG mask support.', 422);
    return value;
  }
  async plan(input: PlanInput, signal: AbortSignal) { return validatePlan(await this.request('planner', 'plan', input, signal), input); }
  async edit(input: EditInput, signal: AbortSignal) {
    const result = await this.request('editor', 'edit', input, signal) as EditResult;
    invariant(result && typeof result.imagePngBase64 === 'string', 'Provider returned no image.', 422);
    decodeBase64(result.imagePngBase64);
    invariant(result.warnings === undefined || (Array.isArray(result.warnings) && result.warnings.every(w => typeof w === 'string' && w.length <= 2000) && result.warnings.length <= 20), 'Provider returned invalid warnings.', 422);
    invariant(result.providerJobId === undefined || (typeof result.providerJobId === 'string' && result.providerJobId.length <= 200), 'Provider returned an invalid job identifier.', 422);
    return { imagePngBase64: result.imagePngBase64, warnings: result.warnings || [], providerJobId: result.providerJobId, usage: result.usage };
  }
}

/** Explicit interactive demo, never a claim of semantic localization or AI editing. */
export class MockProvider implements Provider {
  mode = 'mock' as const;
  async capabilities(_role: 'planner' | 'editor'): Promise<Capabilities> {
    return { roles:['plan','segment','edit'], operations:['remove_object'], acceptedFormats:['image/jpeg','image/png'], outputFormats:['image/png'], maxInputPixels:30_000_000, maxOutputPixels:30_000_000, mask:true };
  }
  async plan(input: PlanInput, signal: AbortSignal): Promise<RemovalPlan> {
    signal.throwIfAborted();
    const { width, height } = input.preview;
    const x = Math.floor(width * 0.35), y = Math.floor(height * 0.3), w = Math.max(1,Math.floor(width * 0.3)), h = Math.max(1,Math.floor(height * 0.4));
    const mask = await convert(['-size',`${width}x${height}`,'xc:black','-fill','white','-draw',`rectangle ${x},${y} ${x+w-1},${y+h-1}`,'-depth','8','png:-']);
    return { operation:'remove_object', baseVersionId:input.baseVersionId, coordinateSpace:{width,height}, uncertain:true, question:'Demo only: this fixed test region was not detected from your prompt. Apply a synthetic patch to the highlighted region?', targets:[{id:'demo-region',label:'Demo test region · no AI detection',box:{x,y,width:w,height:h},maskPngBase64:mask.toString('base64')}] };
  }
  async edit(input: EditInput, signal: AbortSignal): Promise<EditResult> {
    signal.throwIfAborted();
    const patch = await convert(['png:-','-blur','0x18','-fill','#a3ae8b','-colorize','35','-depth','8','png:-'],decodeBase64(input.source.data));
    signal.throwIfAborted();
    return { imagePngBase64:patch.toString('base64'), warnings:['MOCK PROVIDER: synthetic blurred/tinted test patch. No prompt interpretation, object detection, or AI object removal took place.'], providerJobId:`mock-${input.correlationId}` };
  }
}

export function configuredProvider(): Provider {
  const mode = process.env.PROVIDER_MODE || 'mock';
  invariant(mode === 'mock' || mode === 'http', 'PROVIDER_MODE must be mock or http.', 503);
  return mode === 'http' ? new HttpProvider() : new MockProvider();
}
