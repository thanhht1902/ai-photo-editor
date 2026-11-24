# Feasibility evidence

Date: 2026-11-16. Scope: deterministic **mock** pipeline; no real model or CR3.

## Observed environment

- WSL/Linux: `/home/thanhht/Projects/Internal/ai-photo-editor`.
- Node 24.19.0, npm 11.17.0, Python 3.12.3.
- Python pip/ensurepip, FastAPI, NumPy, Pillow, OpenCV, rawpy unavailable.
- ImageMagick 6.9.12-98 **Q16**, LCMS, JPEG/PNG/TIFF delegates.
- sRGB profile: `/usr/share/color/icc/ghostscript/srgb.icc`.
- Network/DNS restricted; Python packages could not be downloaded. Frontend
  dependencies came from cache. No credentials were supplied or invented.
- Binding 127.0.0.1 returns EPERM. API tests invoke the real HTTP handler with
  in-process streams. Browser, mobile, and real-network checks are not claimed.

## Measured 24 MP run

Synthetic 6000 × 4000 JPEG, imported to oriented 16-bit RGBA sRGB; mock
segmentation highlights a fixed region, then a deterministic blurred/tinted
crop is composited only through its mask.

One run took **12.40 s** for fixture import, edit, post-encode validation and PNG
export. Node `process.resourceUsage().maxRSS` reported **953 MiB**. This includes
test-side raster comparisons and excludes simultaneous native-process memory;
it is not total peak RAM or a production capacity estimate. Tests print fresh
measurements. Timing depends on hardware/cache/image.

- Original SHA-256 remained identical through editing/export.
- Complete PNG remained 6000 × 4000.
- Every 16-bit RGBA pixel at zero mask coverage matched the baseline exactly
  after decoding the committed lossless PNG.
- PNG export was the complete committed raster, byte-for-byte, not a preview.
- Exactly one fake edit call; paid provider usage/cost: **zero**.
- The effect was a synthetic test patch, not AI object removal.

## Precision and geometry

- Actual channel values not divisible by 257 catch accidental 16-to-8-bit
  reduction, including alpha and transparent RGB. PNG and ZIP-compressed TIFF
  round trips preserve those values.
- Explicit PNG `bit-depth=16` is necessary: ImageMagick otherwise optimizes simple
  images into 8-bit PNGs despite the requested processing depth. The pipeline
  forces bit depth and checks the result.
- A JPEG APP1/EXIF orientation-6 fixture verifies an 80 × 40 source becomes a
  40 × 80 baseline while original bytes remain unchanged.
- Non-integer coordinate mapping, bounded/padded crops, feather coverage,
  premultiplied-alpha interpolation, and protected pixels are tested.
- Provider output must match the context crop exactly. Smaller/geometrically
  changed results fail; no native-high-resolution claim is fabricated.

## Pending live experiments

1. Select real localization and editing services; verify their HTTP/MCP mapping.
2. Run simple/complex removal and readable poster insertion on real photographs.
   Inspect seams, lighting, perspective, fidelity, and sharpness.
3. Record model geometry/precision, latency, total process-tree memory, cost,
   timeout, cancellation, and idempotency semantics.
4. Obtain CR3 fixtures/camera identities. Verify LibRaw, camera coverage,
   sensor-derived processing, and actual high-precision export.
5. Run desktop/mobile browser acceptance and memory stress on the owner's host.

These block full M0/M1/RAW exits. Mock checks prove pipeline mechanics only.
