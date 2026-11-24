# HTTP provider adapter contract v1

`server/providers.ts` defines the interface. The default `MockProvider` performs
no AI. `HttpProvider` connects a service implementing this document; no existing
vendor or MCP server is claimed to already support this format.

Set `PROVIDER_MODE=http`, `PLANNER_URL`, `EDITOR_URL`. The client appends
`capabilities`, `plan`, or `edit` to each base URL, retaining its path prefix.
Backend-only `PLANNER_API_KEY` / `EDITOR_API_KEY` use Bearer authorization when
present. JSON requests/responses; redirects rejected; response limit 140 MB;
per-image fields have smaller limits. HTTPS required, except explicitly approved
loopback HTTP with `ALLOW_LOCAL_PROVIDER_HTTP=true`.

## Discovery

Each role implements `GET {base}/capabilities`:

```json
{
  "roles": ["plan", "segment", "edit"],
  "operations": ["remove_object"],
  "acceptedFormats": ["image/jpeg", "image/png"],
  "outputFormats": ["image/png"],
  "mask": true,
  "maxInputPixels": 24000000,
  "maxOutputPixels": 24000000
}
```

Example numbers are **not** real provider capabilities. Planning requires
`plan`/`segment` roles and JPEG input; editing requires `edit` and PNG input.
This first adapter requires explicit PNG mask support and positive, known pixel
limits. Unknown capabilities fail. Settings checks schemas, not real editing
quality. Extend dimension/reference/async capabilities for the selected vendor.

## Planning and segmentation

`POST {plannerBase}/plan` receives `PlanInput`:

```json
{
  "projectId": "...",
  "baseVersionId": "immutable-version-id",
  "prompt": "Remove the person on the left",
  "preview": {"data": "BASE64_JPEG", "mime": "image/jpeg", "width": 1400, "height": 933},
  "history": [{"role": "user", "text": "..."}],
  "correlationId": "job-id"
}
```

Return:

```json
{
  "operation": "remove_object",
  "baseVersionId": "immutable-version-id",
  "coordinateSpace": {"width": 1400, "height": 933},
  "uncertain": false,
  "question": "Which numbered person do you mean?",
  "targets": [{
    "id": "person-left",
    "label": "Person beside the doorway",
    "box": {"x": 150, "y": 120, "width": 90, "height": 300},
    "maskPngBase64": "BASE64_GRAYSCALE_PNG"
  }]
}
```

Coordinates refer to the supplied oriented preview, never guessed source
positions. Each mask matches its coordinate space, with zero values outside its
candidate bounds. White means fully permitted to write; black means protected;
gray means feather coverage. All nonzero feather values belong to the write
region. Supply opaque grayscale PNGs; alpha is not coverage.

Localize against image content and return 1–8 segmented candidates. `uncertain`
or multiple candidates trigger numbered clarification. If segmentation is
unavailable, return an actionable non-2xx error rather than invented targets.
Only `remove_object` executes now; insertion/global adjustments fail explicitly.

The backend validates geometry/masks, maps masks to source pixels using
nearest-neighbor scaling, and records transforms. Plans cannot select filesystem
paths, commands, or arbitrary tools.

## Editing

`POST {editorBase}/edit` receives:

```json
{
  "prompt": "Remove the person on the left",
  "source": {"data": "BASE64_PNG", "mime": "image/png", "bitDepth": 8, "width": 1200, "height": 1600},
  "mask": {"data": "BASE64_PNG", "mime": "image/png", "semantics": "white-is-write"},
  "outputSize": {"width": 1200, "height": 1600},
  "correlationId": "job-id",
  "idempotencyKey": "stable-request-key"
}
```

Source/mask are a padded context crop, not the full original. Source is oriented
8-bit sRGB PNG; the stored full baseline remains 16-bit. Only the selected
crop/mask is transmitted. Return a single-frame PNG with the exact geometry:

```json
{
  "imagePngBase64": "BASE64_PNG",
  "providerJobId": "optional-provider-id",
  "warnings": [],
  "usage": {"optional": "provider-specific nonsecret usage data"}
}
```

The backend records actual precision/geometry, converts embedded ICC into sRGB
(untagged output is assumed sRGB), and composites through its authoritative
mask. It re-decodes the final PNG and checks protected pixels before atomically
committing a version. Reading context does not authorize modifying it. Smaller
or misaligned outputs fail instead of silently resizing the canvas/patch.

## Cancellation and retries

Synchronous contract, timeout 100–600000 ms (default 120000). Implement upstream
idempotency using the supplied key if supported. Cancellation aborts HTTP and
prevents local commit; it **does not guarantee upstream termination or avoid
charges**. Async polling/cancellation needs a later adapter extension.

Duplicate local keys return the stored job without repeating paid calls.
Interrupted jobs fail on restart; they are not replayed. Error bodies/network
exception details are not sent to the browser. No provider credentials are
stored in project metadata. Changing provider mode invalidates earlier plans.

## MCP mapping later

Discover/validate selected tool schemas, then map planning/segmentation/editing
and normalize returned assets. Unknown tools/capabilities remain unsupported.
Reachable HTTP MCP can sit behind a bridge. A stdio server must run beside a
trusted backend bridge; arbitrary browser-supplied shell commands are forbidden.
No MCP bridge or live interoperability is claimed in this delivery.
