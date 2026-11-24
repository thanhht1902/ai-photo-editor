import { resolve } from 'node:path';
import { Store } from './store.ts';
import { Editor } from './editor.ts';
import { createApp } from './http.ts';

const store = new Store(resolve(process.env.DATA_DIR || 'data'));
const editor = new Editor(store);
const server = createApp(editor);
const port = Number(process.env.PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
server.requestTimeout = 120_000;
server.headersTimeout = 15_000;
server.listen(port, '127.0.0.1', () => console.log(`Stillroom is running at http://127.0.0.1:${port} (local-only).`));
server.once('error', () => { console.error('Cannot start the local server. Check that PORT is available and local socket access is permitted.'); void editor.shutdown().then(() => {store.close();process.exitCode=1;}); });
async function shutdown() { server.close(); await editor.shutdown(); store.close(); }
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
