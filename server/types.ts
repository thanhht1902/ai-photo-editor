export type Box = { x: number; y: number; width: number; height: number };
export type Size = { width: number; height: number };
export type Asset = Size & {
  id: string; projectId: string; kind: 'source' | 'baseline' | 'preview' | 'reference' | 'mask' | 'patch' | 'export';
  key: string; checksum: string; mime: string; name: string; precision: number;
  profile: string; provenance: Record<string, unknown>;
};
export type Version = { id: string; projectId: string; parentId: string | null; imageId: string; previewId: string; createdAt: string; operation: Record<string, unknown> };
export type Project = Size & { id: string; name: string; sourceId: string; activeVersionId: string; createdAt: string };
export type Target = { id: string; label: string; box: Box; maskPngBase64: string };
export type RemovalPlan = {
  operation: 'remove_object'; baseVersionId: string; coordinateSpace: Size;
  uncertain: boolean; question?: string; targets: Target[];
};
export type JobStatus = 'queued' | 'planning' | 'clarification' | 'editing' | 'compositing' | 'validating' | 'ready' | 'failed' | 'cancelled';
export type Job = {
  id: string; projectId: string; baseVersionId: string; prompt: string; status: JobStatus;
  idempotencyKey: string; selectionEpoch: number; providerMode: string; createdAt: string; updatedAt: string;
  plan?: RemovalPlan; selectedTargetId?: string; versionId?: string; error?: string; warnings: string[];
};
export type Message = { id: string; projectId: string; role: 'user' | 'assistant'; text: string; jobId?: string; createdAt: string };

export class AppError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
export function invariant(condition: unknown, message: string, status = 400): asserts condition {
  if (!condition) throw new AppError(message, status);
}
