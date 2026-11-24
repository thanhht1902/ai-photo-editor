import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from './store.ts';
import { configuredProvider, decodeBase64, validatePlan } from './providers.ts';
import type { Provider, PlanInput } from './providers.ts';
import { checksum, composite, contextBox, convert, crop, decodeMask, encodeMask, encodeRGBA, imageType, inspect, mapBox, normalize, preview, rgba, saveBytes, scaleMask, verifyChecksum, verifyProtected } from './images.ts';
import { AppError, invariant } from './types.ts';
import type { Asset, Job, Message, Project, Version } from './types.ts';

const now = () => new Date().toISOString();
const imageDetails = (width: number, height: number, name: string) => ({ width, height, mime: 'image/png', precision: 16, profile: 'sRGB', name, provenance: {} });

export class Editor {
  store: Store;
  provider: Provider;
  running = false;
  controllers = new Map<string, AbortController>();
  closed = false;
  constructor(store: Store, provider: Provider = configuredProvider()) { this.store = store; this.provider = provider; }
  async importSource(bytes: Buffer, name: string): Promise<Project> {
    const type = imageType(bytes), projectId = randomUUID();
    const source = this.store.allocate('bin'), base = this.store.allocate(), thumb = this.store.allocate('jpg');
    const files = [source, base, thumb];
    try {
      await saveBytes(source.path, bytes);
      const originalSize = await inspect(source.path, type);
      const size = await normalize(source.path, bytes, base.path);
      const thumbSize = await preview(base.path, thumb.path);
      const sourceAsset = await this.store.stage(projectId, 'source', source, { ...imageDetails(originalSize.width, originalSize.height, name), mime: type === 'png' ? 'image/png' : 'image/jpeg', precision: originalSize.depth, profile: 'original embedded profile, or untagged', provenance: { immutable: true, originalName: name } });
      const baseAsset = await this.store.stage(projectId, 'baseline', base, { ...imageDetails(size.width, size.height, 'Original · oriented working image'), provenance: { sourceId: sourceAsset.id, orientationApplied: true, workingSpace: 'encoded sRGB, straight RGBA', untaggedInputAssumption: 'sRGB' } });
      const thumbAsset = await this.store.stage(projectId, 'preview', thumb, { ...imageDetails(thumbSize.width, thumbSize.height, 'Display preview'), mime: 'image/jpeg', precision: 8, provenance: { sourceId: baseAsset.id, displayOnly: true } });
      const version: Version = { id: randomUUID(), projectId, parentId: null, imageId: baseAsset.id, previewId: thumbAsset.id, createdAt: now(), operation: { type: 'import', sourceId: sourceAsset.id } };
      const project: Project = { id: projectId, name: name.replace(/\.[^.]+$/, '') || 'Untitled photo', sourceId: sourceAsset.id, activeVersionId: version.id, width: size.width, height: size.height, createdAt: now() };
      await verifyChecksum(source.path, sourceAsset.checksum);
      this.store.transaction(() => { this.store.insertProject(project); for (const asset of [sourceAsset,baseAsset,thumbAsset]) this.store.insertAsset(asset); this.store.insertVersion(version); this.store.message(projectId, 'assistant', this.provider.mode === 'mock' ? 'Your original is saved. Demo provider is active: send a prompt to try a synthetic patch on a fixed, numbered test region. No AI detection or removal will occur.' : 'Your original is saved. Describe an object to remove. Each completed edit creates a new version.'); });
      return project;
    } catch (error) { await Promise.allSettled(files.map(file => rm(file.path, { force: true }))); throw error; }
  }
  async addReference(projectId: string, bytes: Buffer, name: string) {
    this.store.project(projectId); imageType(bytes);
    const refs = this.store.all<Asset>('assets', projectId).filter(a => a.kind === 'reference');
    invariant(refs.length < 26, 'A project can contain at most 26 named references.');
    const source = this.store.allocate('bin'), normalized = this.store.allocate(), thumbnail = this.store.allocate('jpg');
    try {
      await saveBytes(source.path, bytes);
      const size = await inspect(source.path, imageType(bytes));
      const oriented = await normalize(source.path, bytes, normalized.path), thumbSize = await preview(normalized.path, thumbnail.path);
      const asset = await this.store.stage(projectId, 'reference', source, { ...imageDetails(oriented.width, oriented.height, `Reference ${String.fromCharCode(65 + refs.length)}`), mime: imageType(bytes) === 'png' ? 'image/png' : 'image/jpeg', precision: size.depth, profile: 'original embedded profile, or untagged', provenance: { originalName: name, originalSize:size, immutable: true, insertionAvailable: false } });
      const thumb = await this.store.stage(projectId, 'preview', thumbnail, { ...imageDetails(thumbSize.width,thumbSize.height,`${asset.name} preview`),mime:'image/jpeg',precision:8,provenance:{referenceId:asset.id,displayOnly:true} });
      this.store.transaction(()=>{this.store.insertAsset(asset);this.store.insertAsset(thumb);}); return asset;
    } catch (error) { await Promise.allSettled([source,thumbnail].map(file=>rm(file.path,{force:true}))); throw error; }
    finally { await rm(normalized.path,{force:true}); }
  }
  submit(projectId: string, baseVersionId: string, prompt: string, key: string): Job {
    const project = this.store.project(projectId); this.store.version(baseVersionId, projectId);
    invariant(typeof prompt === 'string' && prompt.trim().length > 0 && prompt.length <= 4000, 'Enter an instruction of 1–4000 characters.');
    invariant(typeof key === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(key), 'Supply a stable idempotency key of 8–100 characters.');
    const existing = this.store.existingJob(projectId, key);
    if (existing) { invariant(existing.prompt === prompt.trim() && existing.baseVersionId === baseVersionId, 'This request key was already used for a different edit.', 409); return existing; }
    invariant(project.activeVersionId === baseVersionId, 'Selected version changed. Refresh before submitting.', 409);
    const pending = this.store.all<Job>('jobs').filter(j => !['ready','failed','cancelled'].includes(j.status));
    invariant(!pending.some(j => j.projectId === projectId), 'Finish or cancel the pending edit before starting another.', 409);
    invariant(pending.length < 8, 'The local job queue is full. Try again when a job finishes.', 429);
    const job: Job = { id: randomUUID(), projectId, baseVersionId, prompt: prompt.trim(), idempotencyKey: key, selectionEpoch: this.store.epoch(projectId), providerMode: this.provider.mode, status: 'queued', createdAt: now(), updatedAt: now(), warnings: [] };
    this.store.transaction(() => { this.store.insertJob(job); this.store.message(projectId, 'user', job.prompt, job.id); });
    this.kick(); return job;
  }
  clarify(projectId: string, jobId: string, targetId: string) {
    const job = this.store.job(jobId, projectId);
    invariant(job.status === 'clarification' && job.plan, 'This edit is not waiting for a target selection.', 409);
    const target = job.plan.targets.find(t => t.id === targetId); invariant(target, 'Choose one of the numbered targets.');
    job.selectedTargetId = targetId; job.status = 'queued';
    this.store.transaction(() => { this.store.updateJob(job); this.store.message(projectId, 'user', `Use ${target.label}.`, job.id); });
    this.kick(); return job;
  }
  cancel(projectId: string, jobId: string) {
    const job = this.store.job(jobId, projectId);
    invariant(!['ready','failed'].includes(job.status), 'This edit has already finished.', 409);
    if (job.status === 'cancelled') return job;
    job.status = 'cancelled';
    this.store.transaction(() => { this.store.updateJob(job); this.store.message(projectId, 'assistant', 'Edit cancelled. The previous version is safe.', jobId); });
    this.controllers.get(jobId)?.abort();
    return job;
  }
  kick() { if (!this.running && !this.closed) { this.running = true; void this.drain(); } }
  async drain() {
    try {
      while (!this.closed) {
        const job = this.store.all<Job>('jobs').find(j => j.status === 'queued'); if (!job) break;
        await this.execute(job);
      }
    } finally { this.running = false; }
  }
  ensureActive(job: Job) { invariant(!this.closed && this.store.job(job.id, job.projectId).status !== 'cancelled', 'Job cancelled.', 409); }
  status(job: Job, status: Job['status']) { this.ensureActive(job); job.status = status; this.store.updateJob(job); }
  async execute(job: Job) {
    const controller = new AbortController(); this.controllers.set(job.id, controller);
    let tmp = ''; const staged: { path: string }[] = []; let committed = false;
    try {
      tmp = await this.store.tempDir();
      this.ensureActive(job);
      invariant(job.providerMode === this.provider.mode, 'Provider mode changed since this edit was planned. Cancel this job and submit a new instruction.', 409);
      const project = this.store.project(job.projectId), version = this.store.version(job.baseVersionId, project.id);
      const base = this.store.asset(version.imageId, project.id), thumb = this.store.asset(version.previewId, project.id), original = this.store.asset(project.sourceId, project.id);
      await verifyChecksum(this.store.path(original), original.checksum); await verifyChecksum(this.store.path(base), base.checksum); await verifyChecksum(this.store.path(thumb), thumb.checksum);
      if (!job.plan) {
        this.status(job, 'planning');
        const cap = await this.provider.capabilities('planner', controller.signal);
        invariant(thumb.width * thumb.height <= cap.maxInputPixels, 'Planning preview exceeds provider pixel limit. Configure a compatible localization service.', 422);
        const input: PlanInput = { projectId: project.id, baseVersionId: version.id, prompt: job.prompt, preview: { data: (await readFile(this.store.path(thumb))).toString('base64'), mime: 'image/jpeg', width: thumb.width, height: thumb.height }, history: this.store.all<Message>('messages', project.id).slice(-12).map(m => ({ role: m.role, text: m.text })), correlationId: job.id };
        job.plan = validatePlan(await this.provider.plan(input, controller.signal), input);
        // Validate segmentation before presenting candidates as usable targets.
        for (const [index,target] of job.plan.targets.entries()) {
          const maskPath = join(tmp, `candidate-${index}.png`); await saveBytes(maskPath, decodeBase64(target.maskPngBase64, 8_000_000));
          const mask = await decodeMask(maskPath, job.plan.coordinateSpace);
          scaleMask(mask, job.plan.coordinateSpace, job.plan.coordinateSpace, target.box);
        }
        this.ensureActive(job);
        if (job.plan.uncertain || job.plan.targets.length > 1) {
          this.status(job, 'clarification');
          this.store.message(project.id, 'assistant', job.plan.question || 'Which numbered object should I remove?', job.id); return;
        }
        job.selectedTargetId = job.plan.targets[0].id;
        this.store.updateJob(job);
      }
      const target = job.plan.targets.find(t => t.id === job.selectedTargetId); invariant(target, 'No localized target was selected.', 422);
      const bounds = mapBox(target.box, job.plan.coordinateSpace, project), context = contextBox(bounds, project);
      const maskInput = join(tmp,'segmentation.png');
      await rm(maskInput, { force: true }); await saveBytes(maskInput, decodeBase64(target.maskPngBase64, 8_000_000));
      const mask = scaleMask(await decodeMask(maskInput, job.plan.coordinateSpace), job.plan.coordinateSpace, project, bounds);
      const cap = await this.provider.capabilities('editor', controller.signal);
      invariant(context.width * context.height <= cap.maxInputPixels && context.width * context.height <= cap.maxOutputPixels, `The required ${context.width} × ${context.height} context exceeds the provider's limits. Use a provider supporting this region size. No patch was enlarged.`, 422);
      const fullMask = this.store.allocate(), cropMask = join(tmp, 'crop-mask.png'), cropSource = join(tmp, 'crop-source.png'), providerSource = join(tmp, 'provider-source.png');
      staged.push(fullMask); await encodeMask(mask, project, fullMask.path); await crop(fullMask.path, context, cropMask); await crop(this.store.path(base), context, cropSource);
      await convert([`png:${cropSource}`, '-depth', '8', '-define', 'png:color-type=6', `png:${providerSource}`]);
      this.status(job, 'editing');
      const result = await this.provider.edit({ prompt: job.prompt, source: { data: (await readFile(providerSource)).toString('base64'), mime: 'image/png', bitDepth: 8, width: context.width, height: context.height }, mask: { data: (await readFile(cropMask)).toString('base64'), mime: 'image/png', semantics: 'white-is-write' }, outputSize: { width: context.width, height: context.height }, correlationId: job.id, idempotencyKey: job.idempotencyKey }, controller.signal);
      this.ensureActive(job);
      const rawPatch = join(tmp, 'provider-output.png'), bytes = decodeBase64(result.imagePngBase64);
      invariant(imageType(bytes) === 'png', 'Provider output must be PNG.', 422); await saveBytes(rawPatch, bytes);
      const rawSize = await inspect(rawPatch);
      invariant(rawSize.width === context.width && rawSize.height === context.height, `Provider returned ${rawSize.width} × ${rawSize.height}; expected ${context.width} × ${context.height}. A geometrically changed or smaller patch cannot be placed safely.`, 422);
      const patch = this.store.allocate(), full = this.store.allocate(), newThumb = this.store.allocate('jpg'); staged.push(patch, full, newThumb);
      await normalize(rawPatch, bytes, patch.path);
      const patchSize = await inspect(patch.path); invariant(patchSize.width === context.width && patchSize.height === context.height, 'Provider output orientation changed the patch geometry.', 422);
      job.warnings = [...result.warnings, 'Generated detail is synthetic. The provider receives an 8-bit sRGB crop; a 16-bit export does not add missing precision.'];
      this.status(job, 'compositing');
      const basePixels = await rgba(this.store.path(base), project), patchPixels = await rgba(patch.path, context);
      const output = composite(basePixels, patchPixels, mask, project, context);
      await encodeRGBA(output, project, full.path);
      this.status(job, 'validating');
      const actual = await inspect(full.path); invariant(actual.width === project.width && actual.height === project.height && actual.depth === 16, 'Output canvas or processing precision changed.', 422);
      verifyProtected(basePixels, await rgba(full.path, project), mask);
      await verifyChecksum(this.store.path(original), original.checksum);
      const small = await preview(full.path, newThumb.path);
      const maskAsset = await this.store.stage(project.id, 'mask', fullMask, { ...imageDetails(project.width, project.height, 'Authorized write region'), precision: 8, profile: 'grayscale coverage', provenance: { targetId: target.id, featherIncluded: true, coordinateSpace: job.plan.coordinateSpace } });
      const patchAsset = await this.store.stage(project.id, 'patch', patch, { ...imageDetails(context.width, context.height, 'Generated patch'), provenance: { providerJobId: result.providerJobId, providerOutputPrecision: rawSize.depth, actualOutputSize: rawSize, profileAssumption: 'sRGB if untagged', usage: result.usage, context } });
      const fullAsset = await this.store.stage(project.id, 'baseline', full, { ...imageDetails(project.width, project.height, 'Completed edit'), provenance: { baseVersionId: version.id, maskId: maskAsset.id, patchId: patchAsset.id, protectedPixelsVerified: true } });
      const thumbAsset = await this.store.stage(project.id, 'preview', newThumb, { ...imageDetails(small.width, small.height, 'Display preview'), mime: 'image/jpeg', precision: 8, provenance: { sourceId: fullAsset.id, displayOnly: true } });
      const next: Version = { id: randomUUID(), projectId: project.id, parentId: version.id, imageId: fullAsset.id, previewId: thumbAsset.id, createdAt: now(), operation: { type: this.provider.mode === 'mock' ? 'demo_patch' : 'remove_object', prompt: job.prompt, providerMode: this.provider.mode, targetId: target.id, targetLabel: target.label, bounds, context, transform: { previewSize: job.plan.coordinateSpace, sourceSize: {width:project.width,height:project.height}, cropOrigin: {x:context.x,y:context.y}, padding: {left:bounds.x-context.x,top:bounds.y-context.y}, modelSize: {width:context.width,height:context.height}, resampling: 'none' }, maskId: maskAsset.id, patchId: patchAsset.id } };
      this.ensureActive(job);
      this.store.transaction(() => {
        for (const asset of [maskAsset,patchAsset,fullAsset,thumbAsset]) this.store.insertAsset(asset);
        this.store.insertVersion(next);
        const canSelect = this.store.epoch(project.id) === job.selectionEpoch && this.store.project(project.id).activeVersionId === job.baseVersionId;
        if (canSelect) this.store.select(project.id, next.id);
        else job.warnings.push('Saved as a new version. Your more recently selected version remains active.');
        job.status = 'ready'; job.versionId = next.id; this.store.updateJob(job);
        this.store.message(project.id, 'assistant', `${this.provider.mode === 'mock' ? 'Demo patch applied. No AI object removal was performed.' : `Removed ${target.label}.`} Saved a full-resolution version (${project.width} × ${project.height}); pixels outside the permitted region were verified unchanged.${canSelect ? '' : ' Select the new version to view it.'}`, job.id);
      }); committed = true;
    } catch (error) {
      if (!this.closed) {
        const current = this.store.job(job.id, job.projectId);
        if (current.status !== 'cancelled') {
          job.status = 'failed'; job.error = error instanceof AppError ? error.message : 'The edit failed during local processing. The previous version is safe.';
          this.store.transaction(() => { this.store.updateJob(job); this.store.message(job.projectId, 'assistant', job.error!, job.id); });
        }
      }
    } finally {
      this.controllers.delete(job.id);
      if (tmp) await rm(tmp, { recursive: true, force: true });
      if (!committed) await Promise.allSettled(staged.map(file => rm(file.path, { force: true })));
    }
  }
  async export(projectId: string, versionId: string, format: 'png' | 'jpeg' | 'tiff', quality = 92): Promise<Asset> {
    invariant(['png','jpeg','tiff'].includes(format), 'Choose PNG, JPEG, or TIFF.');
    invariant(Number.isInteger(quality) && quality >= 1 && quality <= 100, 'JPEG quality must be 1–100.');
    const project = this.store.project(projectId), version = this.store.version(versionId, projectId), base = this.store.asset(version.imageId, projectId), original = this.store.asset(project.sourceId, projectId);
    await verifyChecksum(this.store.path(original), original.checksum); await verifyChecksum(this.store.path(base), base.checksum);
    const file = this.store.allocate(format === 'png' ? 'png' : format === 'jpeg' ? 'jpg' : 'bin');
    try {
      if (format === 'png') await saveBytes(file.path, await readFile(this.store.path(base)));
      else if (format === 'jpeg') await convert([`png:${this.store.path(base)}`, '-background', 'white', '-alpha', 'remove', '-alpha', 'off', '-depth', '8', '-quality', String(quality), `jpeg:${file.path}`]);
      else await convert([`png:${this.store.path(base)}`, '-depth', '16', '-compress', 'Zip', `tiff:${file.path}`]);
      const actual = await inspect(file.path, format);
      invariant(actual.width === project.width && actual.height === project.height && actual.depth === (format === 'jpeg' ? 8 : 16), 'Export dimensions or precision changed.', 422);
      await verifyChecksum(this.store.path(original), original.checksum);
      const asset = await this.store.stage(projectId, 'export', file, { ...imageDetails(project.width, project.height, `${project.name}.${format === 'jpeg' ? 'jpg' : format === 'tiff' ? 'tif' : 'png'}`), mime: `image/${format}`, precision: format === 'jpeg' ? 8 : 16, provenance: { versionId, sourceAssetId: base.id, quality: format === 'jpeg' ? quality : undefined, alpha: format === 'jpeg' ? 'flattened on white' : 'straight', warning: format === 'jpeg' ? 'Lossy export; pixel identity is not guaranteed.' : 'Generated regions retain their original provider precision.' } });
      this.store.insertAsset(asset); return asset;
    } catch (error) { await rm(file.path, { force: true }); throw error; }
  }
  async shutdown() { this.closed = true; for (const controller of this.controllers.values()) controller.abort(); while (this.running) await new Promise(resolve => setTimeout(resolve, 20)); }
}
