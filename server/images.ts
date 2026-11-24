import { spawn } from 'node:child_process';
import { readFile, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { AppError, invariant } from './types.ts';
import type { Box, Size } from './types.ts';

export const MAX_PIXELS = 30_000_000;
const MAX_BYTES = MAX_PIXELS * 8 + 1_000_000;
const profile = process.env.SRGB_PROFILE || '/usr/share/color/icc/ghostscript/srgb.icc';
const limits = ['-limit', 'thread', '2', '-limit', 'memory', '256MiB', '-limit', 'map', '512MiB', '-limit', 'disk', '1GiB'];

export async function command(executable: string, args: string[], input?: Buffer, maxBytes = MAX_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, OMP_NUM_THREADS: '2' } });
    const chunks: Buffer[] = []; let size = 0; let error = ''; let stopped = false;
    const timer = setTimeout(() => { stopped = true; proc.kill('SIGKILL'); reject(new AppError('Image processing timed out.', 422)); }, 120_000);
    proc.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) { stopped = true; proc.kill('SIGKILL'); reject(new AppError('Decoded image exceeds the processing limit.', 413)); } else chunks.push(chunk); });
    proc.stderr.on('data', (chunk: Buffer) => { error = (error + chunk.toString()).slice(-2000); });
    proc.stdin.on('error', () => {});
    proc.on('error', () => { clearTimeout(timer); reject(new AppError('Image engine unavailable. Install ImageMagick Q16 and configure IM_CONVERT / IM_IDENTIFY.', 503)); });
    proc.on('close', code => { clearTimeout(timer); if (stopped) return; if (code !== 0) reject(new AppError(`Image could not be processed${error.includes('cache resources exhausted') ? ': resource limit reached' : ''}. Check that the file is a supported, undamaged JPEG or PNG.`, 422)); else resolve(Buffer.concat(chunks)); });
    proc.stdin.end(input);
  });
}
export function convert(args: string[], input?: Buffer, maxBytes?: number) { return command(process.env.IM_CONVERT || 'convert', [...limits, ...args], input, maxBytes); }
export function checksum(data: Buffer) { return createHash('sha256').update(data).digest('hex'); }
export function imageType(bytes: Buffer): 'png' | 'jpeg' {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  throw new AppError('Upload a JPEG or PNG. CR3 and TIFF import await verified RAW/precision fixtures (M4).', 415);
}
export async function inspect(path: string, type: 'png' | 'jpeg' | 'tiff' = 'png'): Promise<Size & { depth: number }> {
  const output = await command(process.env.IM_IDENTIFY || 'identify', [...limits, '-ping', '-format', '%w %h %z\n', `${type}:${path}`], undefined, 10000);
  const frames = output.toString().trim().split('\n');
  invariant(frames.length === 1, 'Multi-frame images are not supported.', 415);
  const [width, height, depth] = frames[0].split(' ').map(Number);
  invariant(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0 && width * height <= MAX_PIXELS, 'Image must contain at most 30 million pixels.', 413);
  return { width, height, depth };
}
export async function normalize(path: string, original: Buffer, output: string) {
  const type = imageType(original); await inspect(path, type); await access(profile);
  // LCMS converts an embedded profile; an untagged image is explicitly assumed sRGB.
  // Auto-orientation happens once. Stored versions use straight RGBA, encoded sRGB, 16-bit.
  await convert([`${type}:${path}`, '-auto-orient', '-profile', profile, '-colorspace', 'sRGB', '-alpha', 'on', '-strip', '-profile', profile, '-depth', '16', '-define', 'png:bit-depth=16', '-define', 'png:color-type=6', `png:${output}`]);
  return inspect(output);
}
export async function preview(path: string, output: string) {
  await convert([`png:${path}`, '-resize', '1400x1400>', '-background', '#141b17', '-alpha', 'remove', '-alpha', 'off', '-strip', '-quality', '88', `jpeg:${output}`]);
  return inspect(output, 'jpeg');
}
export async function rgba(path: string, size: Size) {
  const result = await convert([`png:${path}`, '-alpha', 'on', '-depth', '16', '-endian', 'MSB', 'rgba:-']);
  invariant(result.length === size.width * size.height * 8, 'Invalid raster length.', 422);
  return result;
}
export async function encodeRGBA(data: Buffer, size: Size, path: string) {
  await convert(['-size', `${size.width}x${size.height}`, '-depth', '16', '-endian', 'MSB', 'rgba:-', '-set', 'colorspace', 'sRGB', '-profile', profile, '-define', 'png:color-type=6', '-define', 'png:bit-depth=16', '-depth', '16', `png:${path}`], data);
}
export function mapBox(box: Box, from: Size, to: Size): Box {
  const x = Math.floor(box.x * to.width / from.width), y = Math.floor(box.y * to.height / from.height);
  return { x, y, width: Math.ceil((box.x + box.width) * to.width / from.width) - x, height: Math.ceil((box.y + box.height) * to.height / from.height) - y };
}
export function validateBox(box: Box, size: Size) {
  invariant(box && ['x','y','width','height'].every(key => Number.isInteger(box[key as keyof Box])), 'Target coordinates must be integers.');
  invariant(box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0 && box.x + box.width <= size.width && box.y + box.height <= size.height, 'Target is outside the image.');
}
export function contextBox(box: Box, size: Size): Box {
  const padding = Math.max(32, Math.ceil(Math.max(box.width, box.height) * 0.3));
  const x = Math.max(0, box.x - padding), y = Math.max(0, box.y - padding);
  return { x, y, width: Math.min(size.width, box.x + box.width + padding) - x, height: Math.min(size.height, box.y + box.height + padding) - y };
}
export async function crop(path: string, box: Box, output: string) {
  await convert([`png:${path}`, '-crop', `${box.width}x${box.height}+${box.x}+${box.y}`, '+repage', '-depth', '16', `png:${output}`]);
}
export async function decodeMask(path: string, expected: Size): Promise<Buffer> {
  const size = await inspect(path);
  invariant(size.width === expected.width && size.height === expected.height, 'Localization mask dimensions do not match the supplied preview.', 422);
  // Grayscale values express the entire permitted write region, including feathering.
  return convert([`png:${path}`, '-alpha', 'off', '-colorspace', 'Gray', '-depth', '8', 'gray:-'], undefined, MAX_PIXELS);
}
export function scaleMask(mask: Buffer, from: Size, to: Size, bounds: Box): Buffer {
  const scaled = Buffer.alloc(to.width * to.height); let nonzero = 0;
  for (let y = 0; y < to.height; y++) for (let x = 0; x < to.width; x++) {
    const value = mask[Math.min(from.height - 1, Math.floor(y * from.height / to.height)) * from.width + Math.min(from.width - 1, Math.floor(x * from.width / to.width))];
    if (!value) continue;
    invariant(x >= bounds.x && y >= bounds.y && x < bounds.x + bounds.width && y < bounds.y + bounds.height, 'Localization mask writes outside its declared target bounds.', 422);
    scaled[y * to.width + x] = value; nonzero++;
  }
  invariant(nonzero > 0, 'Localization returned an empty mask.', 422);
  return scaled;
}
export async function encodeMask(mask: Buffer, size: Size, output: string) {
  await convert(['-size', `${size.width}x${size.height}`, '-depth', '8', 'gray:-', `png:${output}`], mask);
}
export function composite(base: Buffer, patch: Buffer, mask: Buffer, size: Size, context: Box): Buffer {
  invariant(base.length === size.width * size.height * 8 && mask.length === size.width * size.height && patch.length === context.width * context.height * 8, 'Composite inputs have inconsistent dimensions.', 422);
  validateBox(context, size);
  const output = Buffer.from(base);
  for (let y = 0; y < context.height; y++) for (let x = 0; x < context.width; x++) {
    const pixel = (context.y + y) * size.width + context.x + x, weight = mask[pixel] / 255;
    if (!weight) continue;
    const b = pixel * 8, p = (y * context.width + x) * 8;
    const ba = base.readUInt16BE(b + 6) / 65535, pa = patch.readUInt16BE(p + 6) / 65535;
    const alpha = ba * (1 - weight) + pa * weight;
    for (let channel = 0; channel < 3; channel++) {
      const value = alpha === 0 ? 0 : (base.readUInt16BE(b + channel * 2) * ba * (1 - weight) + patch.readUInt16BE(p + channel * 2) * pa * weight) / alpha;
      output.writeUInt16BE(Math.round(value), b + channel * 2);
    }
    output.writeUInt16BE(Math.round(alpha * 65535), b + 6);
  }
  return output;
}
export function verifyProtected(base: Buffer, output: Buffer, mask: Buffer) {
  invariant(base.length === output.length && base.length === mask.length * 8, 'Validation raster sizes differ.', 422);
  for (let pixel = 0; pixel < mask.length; pixel++) {
    if (mask[pixel]) continue;
    const offset = pixel * 8;
    invariant(base.readUInt32BE(offset) === output.readUInt32BE(offset) && base.readUInt32BE(offset + 4) === output.readUInt32BE(offset + 4), 'Protected pixels changed. Version was not committed.', 422);
  }
}
export async function verifyChecksum(path: string, expected: string) { invariant(checksum(await readFile(path)) === expected, 'Stored asset checksum mismatch. Restore the original asset before continuing.', 409); }
export async function saveBytes(path: string, bytes: Buffer) { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
