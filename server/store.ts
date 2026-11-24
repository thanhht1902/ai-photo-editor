import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { checksum } from './images.ts';
import { invariant } from './types.ts';
import type { Asset, Job, Message, Project, Version } from './types.ts';

export class Store {
  root: string;
  db: DatabaseSync;
  constructor(root: string) {
    this.root = resolve(root); mkdirSync(join(this.root, 'objects'), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(this.root, 'metadata.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, request_key TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(project_id,request_key));
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS assets_project ON assets(project_id);
      CREATE INDEX IF NOT EXISTS versions_project ON versions(project_id);
      CREATE INDEX IF NOT EXISTS jobs_project ON jobs(project_id);
      PRAGMA user_version=1;`);
    // Never automatically replay a possibly paid provider call after a process crash.
    for (const job of this.all<Job>('jobs')) if (!['ready','failed','cancelled','clarification'].includes(job.status)) {
      this.updateJob({ ...job, status: 'failed', error: 'Server restarted during this job. The previous version is safe. Check provider usage before submitting a new request.' });
    }
  }
  close() { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  all<T>(table: 'projects' | 'assets' | 'versions' | 'jobs' | 'messages', projectId?: string): T[] {
    const rows = projectId ? this.db.prepare(`SELECT data FROM ${table} WHERE project_id=? ORDER BY rowid`).all(projectId) : this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all();
    return rows.map(row => JSON.parse(row.data as string) as T);
  }
  get<T>(table: 'projects' | 'assets' | 'versions' | 'jobs', id: string): T {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);
    invariant(row, 'Requested item was not found.', 404); return JSON.parse(row.data as string) as T;
  }
  project(id: string) { return this.get<Project>('projects', id); }
  asset(id: string, projectId: string) { const asset = this.get<Asset>('assets', id); invariant(asset.projectId === projectId, 'Asset does not belong to this project.', 404); return asset; }
  version(id: string, projectId: string) { const version = this.get<Version>('versions', id); invariant(version.projectId === projectId, 'Version does not belong to this project.', 404); return version; }
  job(id: string, projectId: string) { const job = this.get<Job>('jobs', id); invariant(job.projectId === projectId, 'Job does not belong to this project.', 404); return job; }
  path(asset: Pick<Asset, 'key'>) { invariant(/^[a-f0-9-]+\.(png|jpg|bin)$/.test(asset.key), 'Invalid internal storage key.', 500); return join(this.root, 'objects', asset.key); }
  allocate(extension: 'png' | 'jpg' | 'bin' = 'png') { const key = `${randomUUID()}.${extension}`; return { key, path: this.path({ key }) }; }
  async stage(projectId: string, kind: Asset['kind'], file: {key: string; path: string}, details: Omit<Asset,'id'|'projectId'|'kind'|'key'|'checksum'>): Promise<Asset> {
    return { id: randomUUID(), projectId, kind, key: file.key, checksum: checksum(await readFile(file.path)), ...details };
  }
  insertAsset(asset: Asset) { this.db.prepare('INSERT INTO assets VALUES (?,?,?)').run(asset.id, asset.projectId, JSON.stringify(asset)); }
  insertVersion(version: Version) { this.db.prepare('INSERT INTO versions VALUES (?,?,?)').run(version.id, version.projectId, JSON.stringify(version)); }
  insertProject(project: Project) { this.db.prepare('INSERT INTO projects(id,data) VALUES (?,?)').run(project.id, JSON.stringify(project)); }
  epoch(projectId: string) { return Number(this.db.prepare('SELECT epoch FROM projects WHERE id=?').get(projectId)?.epoch); }
  select(projectId: string, versionId: string) {
    this.version(versionId, projectId);
    const project = this.project(projectId);
    this.db.prepare('UPDATE projects SET data=?,epoch=epoch+1 WHERE id=?').run(JSON.stringify({ ...project, activeVersionId: versionId }), projectId);
  }
  insertJob(job: Job) { this.db.prepare('INSERT INTO jobs VALUES (?,?,?,?)').run(job.id, job.projectId, job.idempotencyKey, JSON.stringify(job)); }
  updateJob(job: Job) { job.updatedAt = new Date().toISOString(); this.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(job), job.id); }
  existingJob(projectId: string, key: string): Job | undefined { const row = this.db.prepare('SELECT data FROM jobs WHERE project_id=? AND request_key=?').get(projectId, key); return row ? JSON.parse(row.data as string) as Job : undefined; }
  message(projectId: string, role: Message['role'], text: string, jobId?: string) {
    const msg: Message = { id: randomUUID(), projectId, role, text, jobId, createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO messages VALUES (?,?,?)').run(msg.id, projectId, JSON.stringify(msg));
  }
  snapshot(projectId: string) {
    return { project: this.project(projectId), assets: this.all<Asset>('assets', projectId).map(({key: _key, ...asset}) => asset), versions: this.all<Version>('versions', projectId), jobs: this.all<Job>('jobs', projectId).map(publicJob), messages: this.all<Message>('messages', projectId) };
  }
  async tempDir() { const path = join(this.root, 'tmp', randomUUID()); await mkdir(path, { recursive: true, mode: 0o700 }); return path; }
}
export function publicJob(job: Job) {
  return { ...job, plan: job.plan ? { ...job.plan, targets: job.plan.targets.map(({maskPngBase64: _mask, ...target}) => target) } : undefined };
}
