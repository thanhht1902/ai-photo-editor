# Implementation progress

Updated 2026-11-16. User direction: **mock it first; real provider later**.
The original handoff in `plan.md` is preserved. This file records current status.

## Plan review and decisions

- The workspace contained only `plan.md`; no existing implementation, usable
  Git repository, source image, provider configuration, or CR3 fixture.
- Begin with M0/M1. A mock does not satisfy their real-provider exit criteria.
  M2–M5 are not complete merely because supporting UI elements exist.
- React/TypeScript/Vite retained. Backend adapted to Node 24, SQLite, local
  objects, and a single durable worker. Python had no pip/ensurepip or image/API
  packages; dependency downloads were unavailable. Cached npm packages and
  ImageMagick Q16/LCMS made a verifiable implementation possible. The lockfile
  uses public registry URLs rather than the host's private mirror.
- The mock confirms a fixed test region before applying a synthetic patch.
  It makes no localization, removal-quality, or aesthetic claims.
- A typed HTTP adapter separates planning/segmentation from image editing.
  A vendor-specific API/MCP bridge can implement this contract later; no actual
  provider was selected or verified in this delivery.
- Preserve the original contract: no preview export, implicit canvas resize,
  changes outside final write coverage, or silent upsampling.

## M0 — feasibility (partial)

- [x] Inspect workspace, instructions, installed development/image tools.
- [x] Verify native 16-bit PNG/TIFF round trips, EXIF, masks, and compositing.
- [x] Exercise a 24 MP mock edit and record time/memory limits.
- [x] Document architecture and normalized adapter contract.
- [ ] Select and validate a real planner/segmentation and editing provider.
- [ ] Run real removal and reference-insertion experiments; measure cost/quality.
- [ ] Obtain CR3/camera samples; verify decoder and actual RAW export.

**Exit pending:** live integration and RAW evidence. No cameras are advertised.

## M1 — localized edit foundation (mock-complete, live exit pending)

- [x] Runnable web/API/storage/durable-job skeleton.
- [x] Upload/orient JPEG/PNG, checksum source, separate preview/full raster.
- [x] Prompt submission, numbered mock clarification, explicit transforms.
- [x] Adapter-based crop/mask editing and a visible synthetic demo provider.
- [x] Full-resolution 16-bit compositing; post-encode protected-pixel checks.
- [x] Atomic versions, failed/cancelled job preservation, restart recovery.
- [x] PNG export and before/after. TIFF/JPEG exports also tested.
- [x] Meaningful 6000 × 4000 automated acceptance checks.
- [ ] Real natural-language localization, segmentation, and AI removal.
- [ ] Real-provider M1 acceptance and visual inspection at 100%.
- [ ] Interactive desktop/mobile verification on an unrestricted host.

## Later milestones (not complete)

- [ ] M2: deterministic planar reference insertion, occlusion, exact content.
  Named immutable references can be stored; no placement exists.
- [ ] M3: stable object identity and actual follow-up operations. Project/messages,
  immutable history, restore/reopen, and branching foundations exist.
- [ ] M4: CR3 camera evidence, RAW recipe/dependency invalidation, wide-gamut
  workflows, exposure/white balance/color operations. Raster PNG/TIFF/JPEG export
  is implemented for the current sRGB pipeline.
- [ ] M5: resumable upload, stronger resource controls, cleanup, auth, deployment.
  Local autosave, a bounded single-worker queue, cancellation, recovery and a
  responsive layout exist; production/browser acceptance remains pending.

## Checks and remaining risks

- `npm run check`, `npm test`, and `npm run build` verify this implementation.
- Tests use fakes/synthetic fixtures. No assertion proves aesthetic quality,
  true localization, or interoperability with an actual model.
- API tests execute the real request handler in process. Socket binding returns
  EPERM in this sandbox. Run the README startup/browser smoke test locally.
- Full-image buffers use substantial memory. The mock is not a production
  concurrency recommendation. Tiling and stronger shared scheduling await M5.
- Recovery fails interrupted calls rather than replaying possibly paid work.
  Hard-kill orphan collection and portable project packaging remain pending.
- High-precision sRGB compositing is verified. CR3 and wide-gamut behavior have
  no fixture evidence and are explicitly unsupported.
