# Stillroom

A local, prompt-driven photo editor built from [plan.md](plan.md). This delivery
implements the M0/M1 foundation **with a mock provider, as requested**. It does
not yet perform real AI removal or natural-language localization.

Upload a photo, send a prompt, confirm the numbered demo region, compare the
result, restore versions, and download a full-resolution PNG, TIFF, or JPEG.
The mock applies a synthetic blurred/tinted patch to a fixed region; it never
pretends to understand the prompt. Original files are retained unchanged.

## Run locally (WSL2)

Requirements: Node **24.13+**, npm, ImageMagick **Q16** with JPEG/PNG/TIFF and LCMS,
and an sRGB ICC profile. On Ubuntu, `imagemagick` and `ghostscript` provide the
image engine and the default profile. Do not use an ImageMagick Q8 build.

```sh
node --version
convert -version
npm ci
cp .env.example .env
npm run build
npm start
```

Open **http://127.0.0.1:8787**. Mock mode needs no keys, external services, Docker,
or paid infrastructure. `npm start` and `npm run dev` load `.env` if it exists.
Set `SRGB_PROFILE` if your profile lives elsewhere, and `IM_CONVERT` /
`IM_IDENTIFY` if the executables use other paths. The commands target ImageMagick 6;
ImageMagick 7 has not been verified.

For frontend hot reload, run these in separate terminals:

```sh
npm run dev
npm run dev:web
```

Use **http://127.0.0.1:5173**; Vite proxies `/api` to port 8787. For a different
backend port, update `vite.config.ts` as well as `PORT`.

## Run with Docker

Requirements: Docker Engine and Docker Compose v2.24+ (or Docker Desktop), plus
GNU Make for the `make` shortcuts. Node and ImageMagick are included in the image.

```sh
cp .env.example .env # optional; defaults use the mock provider
make docker-up
```

Open **http://127.0.0.1:8787**. Compose publishes the port on host loopback only;
`PORT` in `.env` changes that host port. Inside the container, the server listens
on `0.0.0.0:8787` and retains the localhost Host/Origin checks. The runtime runs
as the unprivileged `node` user and includes ImageMagick 6 Q16 and the sRGB profile.
`.env` is passed to the server by Compose and excluded from the build context.

Projects persist in the `stillroom-data` named volume at `/app/data`, independently
of the host `./data` directory. Compose sets container paths for image executables,
the ICC profile, and storage, overriding their local `.env` values.

```sh
make docker-logs  # follow server logs
make docker-down # stop containers and keep the data volume
make docker-test # lint, build, and test in the Docker build environment
```

Without Make, use `docker compose up --build --detach --wait`,
`docker compose logs --follow`, `docker compose down`, and
`docker build --target checks -t stillroom-checks .`, respectively.
To back up container data, stop the service and copy the entire data volume,
following the storage and recovery guidance below.

## What works

- JPEG/PNG import up to 100 MB and 30 million pixels, including 6000 × 4000.
- EXIF orientation, ICC conversion into sRGB, separate display previews, and a
  straight-alpha, 16-bit RGBA working representation.
- Explicitly labeled mock planning/editing with numbered clarification overlays.
- Full-resolution local compositing, feather coverage, and an exact protected
  pixel check after PNG encoding, before a version commits.
- Persistent projects, messages, named reference originals, edit assets,
  immutable versions, before/after, fit, 100% view, zoom, and drag-to-pan.
- A single edit worker, bounded queue, cancellation, request idempotency,
  failure recovery, and late results that cannot replace a newer selection.
- Full-resolution lossless PNG/TIFF and lossy JPEG export. PNG/TIFF are 16-bit;
  JPEG is 8-bit, quality-controlled, and flattened onto white.

Desktop/mobile layouts are implemented. Interactive browser verification is
pending: the implementation sandbox denies local socket binding. API behavior
was verified in process, using the actual request handler.

## Connect a real service later

Set `PROVIDER_MODE=http` and configure `PLANNER_URL`, `PLANNER_API_KEY`,
`EDITOR_URL`, and `EDITOR_API_KEY` in `.env`, then restart. URLs are service base
URLs. The service must implement [the adapter contract](docs/provider-contract.md).
The planner and editor can be separate services. An existing vendor API or MCP
server needs an adapter implementing that contract; arbitrary vendor endpoints
are not automatically compatible. Settings checks the capability schema,
which is **not** proof of live editing quality.

HTTPS is required. For a trusted service on localhost, explicitly set
`ALLOW_LOCAL_PROVIDER_HTTP=true`. Arbitrary shell-based MCP launch commands are
not accepted. The browser never receives connection URLs or API keys. Only a
planning preview/history and the selected edit crop/mask are sent to services;
stored references are not sent in this milestone.

## Verification

After `npm ci`, run all pre-commit checks with GNU Make:

```sh
make pre-commit
```

This runs ESLint, the TypeScript check and Vite production build, then tests,
stopping at the first failure. It is an explicit command; it does not install a
Git hook. Individual commands are `make lint`, `make build`, and `make test`
(or `npm run lint`, `npm run build`, and `npm test`). Use `make lint-fix` to apply
available automatic lint fixes, or `make check` for type checking alone.

Tests use deterministic fakes, including real ImageMagick processing on a 24 MP
fixture. They cover dimensions, original checksums, EXIF orientation, coordinate
mapping, mask bounds, alpha/feather behavior, actual 16-bit PNG/TIFF fidelity,
version reopening/restore, retry deduplication, late results, cancellation,
restart recovery, malformed provider output, capability limits, timeout, error
redaction, API requests, downloads, and project asset ownership. They require no
network access. Allow roughly 1–2 GiB of available RAM for the large fixture and
native image processes; actual memory varies by image. See
[feasibility evidence](docs/feasibility.md) for measurements and limits.

## Storage and recovery

`DATA_DIR` defaults to `./data`. SQLite metadata lives in `metadata.sqlite`;
immutable source, reference, mask, patch, baseline, preview, and export files
live in `objects/`. Schema version 1 is installed automatically at startup
(`PRAGMA user_version=1`); there is no migration command for an earlier release.
There was no existing application or database to migrate.

Back up the **entire data directory** with the server stopped, including SQLite
WAL/SHM files if present. Metadata alone loses image dependencies. Restore the
complete directory and set `DATA_DIR` accordingly. Export downloads are images,
not portable project bundles.

After a restart, interrupted jobs become failed and are never replayed
automatically: the upstream operation may have incurred charges. Previous
versions remain usable. Clarifications survive a restart. A repeated request
with the same idempotency key returns the original job; a genuinely new attempt
uses a new key. Provider-mode changes invalidate plans from the previous mode.

Failed jobs clean staged files on normal completion. Hard process kills can
leave unreferenced temporary/object files; automated collection is deferred.
Keep the server stopped during backup/maintenance. Do not delete objects based
on active-version visibility: earlier versions depend on them.

## Scope and limitations

See [PROGRESS.md](PROGRESS.md) for the milestone checklist and review findings.
CR3/TIFF import, supported-camera claims, reference insertion/perspective,
follow-up object identity, prompt exposure/color, resizable canvases,
resumable uploads, and real MCP/vendor interoperability are pending.
References can be saved now; placement is explicitly unavailable.
The working space is sRGB only; wide-gamut/RAW development awaits M4.

Original-to-working color conversion can change pixels. Protected-pixel
identity applies between working baselines in the same space/precision at zero
mask coverage. Feathering belongs to the write region. Blending interpolates
premultiplied alpha in encoded sRGB and stores straight RGBA; this is not
presented as physically accurate linear-light blending. JPEG export is lossy.
8-bit generated detail does not become native 16-bit detail in a 16-bit export.
Smaller provider outputs are rejected rather than silently enlarged.

Local runs bind **127.0.0.1** by default; Docker Compose publishes on host
**127.0.0.1 only**. Both retain host/origin checks. It has no user
authentication and is intended for a trusted, single-owner workstation. Do not
publish it through a tunnel or reverse proxy. Authentication, credential
protection, remote endpoint controls, production migrations, resource scheduling,
and asset lifecycle management must precede public use.
