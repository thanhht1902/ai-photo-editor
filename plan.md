# Prompt-driven AI Photo Editor - Build Plan

Status: implementation handoff; no application has been built or verified yet.
Target development environment: WSL2, `/home/thanhht/projects/internal`.
Audience: the developer and GitHub Copilot working in that repository.

## 1. Product objective

Build a web application where users edit large photographs through text prompts
and optional reference images. The primary workflows are object removal and
image insertion/replacement. Users should not need to draw masks, manage layers,
or use a Photoshop-style toolbox to complete these workflows.

Example request:

> Remove the person on the left. Replace the poster on the wall with reference
> image A, preserving its text, the frame, the perspective, and the room lighting.

Users can continue with requests such as "make the poster smaller", "keep its
original colors", and "go back to the previous version".

Accept large raster images such as 6000 x 4000 and supported Canon CR3 files.
Unless the user explicitly requests a canvas-size change, export at the original
oriented image dimensions. Keep original source files unchanged.

Users supply their own model/service connection through MCP or a provider API.
Do not hardcode a single provider throughout the application.

## 2. Agreed scope and deferred work

### MVP

- Upload JPEG, PNG, reference images, and CR3 from verified camera models.
- Perform localized object removal from natural-language instructions.
- Insert reference images into described regions, including planar perspective.
- Apply basic exposure and color adjustments through prompts.
- Resolve ambiguous targets through a short chat clarification with numbered
  image overlays; do not require manual masking as the standard workflow.
- Support conversational follow-up edits, before/after comparison, and versions.
- Save and reopen projects with all source dependencies available.
- Connect one real image-editing provider or MCP server end to end, with an
  adapter architecture for additional connections.
- Export PNG, TIFF, and JPEG with explicit dimensions and color settings.
- Preserve a high-precision processing path for supported RAW/TIFF workflows.

### Deferred

- Advanced AI enhancement, super-resolution, detail recovery, and multi-pass
  refinement. Discuss these with the owner in a later phase.
- A full Photoshop tool suite, PSD compatibility, arbitrary RAW camera coverage,
  advanced CMYK printing workflows, collaborative editing, and batch processing.
- Training or self-hosting an image model unless explicitly requested.
- A local MCP bridge for cloud deployments unless the selected provider requires it.

Normal resampling needed to place an image is not AI enhancement. Disclose when
an AI-generated region must be enlarged; do not label it native high-resolution.

## 3. Output and quality contract

For an oriented 6000 x 4000 source, an edit without cropping or resizing returns
a complete 6000 x 4000 image, not just an edited patch or a preview.

The project retains the original, reference assets, edit operations, generated
patches, masks, RAW settings, and version history. A CR3 remains a source asset;
the edited result is exported as TIFF/PNG/JPEG, not as a newly edited CR3.

### Guarantees the application must enforce

1. Original files are immutable. Store a content checksum and verify preservation.
2. Canvas dimensions cannot change implicitly because a model returns a smaller
   image or a different aspect ratio.
3. Export uses full-resolution sources and stored edit assets, never a preview.
4. A local generative edit changes only its declared write mask. The mask includes
   any feathered transition area. Reading surrounding context does not authorize
   modifying that context in the final composite.
5. Pixels outside the write mask are identical to the baseline for a local edit
   when tested in the same color space, bit depth, and lossless representation,
   with no global adjustment or export color conversion.
6. Global color adjustments and lossy JPEG export have different guarantees;
   do not promise byte/pixel identity for those operations.
7. Retain reference content through deterministic compositing when text, logos,
   faces, or product details must remain exact. Geometric resampling can still
   alter pixel values; exact content preservation is not pixel identity.
8. Avoid repeated lossy encoding. Retain original layer assets and transforms.
9. Track ICC profiles, alpha conventions, processing precision, and actual model
   output resolution throughout the pipeline.
10. Unsupported capabilities must produce an actionable error or an explicitly
    explained alternative, not a fabricated successful edit.

### Limits that must remain visible

- AI-generated detail is synthetic and depends on the model and supplied context.
- Output dimensions alone do not establish detail quality.
- Upsampling an AI patch does not recover real missing detail.
- A 16-bit export does not turn an 8-bit generated patch into true 16-bit detail.
- Technical validation can verify dimensions and protected pixels; it cannot
  guarantee aesthetic correctness or factual accuracy of generated content.

## 4. User experience

Provide a large image canvas, a conversation panel, and a compact asset/version
panel. Show reference thumbnails with stable names such as Reference A and B.

Core interactions:

- Create project, upload source, add references, send prompt.
- Show meaningful states: uploading, decoding, planning, editing, compositing,
  validating, ready, failed, or cancelled.
- Display a quick preview without confusing it with the completed export.
- Support pan, fit-to-screen, 100% zoom, and before/after inspection.
- Preserve earlier versions until a new version has completed successfully.
- Allow follow-up prompts to refer to previously edited objects and versions.
- Provide export format and quality controls, also accessible through chat.

Keep technical terms such as masks, workers, and provider schemas out of the
normal editing flow. Put connection details and diagnostics in settings.
Desktop is the primary editing layout; mobile must support upload, prompting,
review, and download without broken layout.

## 5. Architecture

```text
Web client
  -> API: projects, assets, conversation, versions, jobs, exports
  -> Planner: prompt + selected version + references -> structured edit plan
  -> Target localization / segmentation
  -> Operation executor
       -> deterministic image tools
       -> image model through MCP/API adapter
  -> full-resolution compositor
  -> output validation
  -> committed version + preview + export

Storage: PostgreSQL metadata + object storage for image assets
Jobs: background queue for RAW decoding, editing, and export
```

### Proposed stack

| Component | Initial choice |
| --- | --- |
| Frontend | React, TypeScript, Vite |
| Image viewport | Canvas/WebGL with resolution levels and region loading |
| Backend | Python, FastAPI, Pydantic |
| Image processing | NumPy/OpenCV and pyvips/libvips where suitable |
| RAW | LibRaw through a maintained binding, validated with real CR3 fixtures |
| Color management | Explicit ICC conversion through a suitable color engine |
| Background jobs | Celery and Redis |
| Metadata | PostgreSQL |
| Assets | S3-compatible storage; local development implementation allowed |
| Development | WSL2; Docker Compose for supporting services where available |

These choices are proposals, not compatibility claims. Validate native library
support, precision, licensing, and RAW camera coverage during the first milestone.
If an existing repository already has a suitable stack, reuse it and document
the adaptation instead of replacing it unnecessarily.

## 6. Structured planning and execution

Separate the reasoning/planning role from the image-editing role. One service
may implement both, but do not assume every image endpoint can plan or segment.

The planner produces a schema-validated plan containing:

- Project ID and immutable base version ID.
- Requested operation and referenced assets.
- Target description, resolved region/object ID, and uncertainty.
- Canvas-space coordinates, context region, and write-mask asset ID.
- Preservation constraints and permitted global changes.
- Required provider capabilities.
- Export dimensions inherited from the project unless explicitly changed.

Supported initial operations: `remove_object`, `insert_reference`,
`adjust_exposure`, and `adjust_color`.

The backend validates bounds, asset ownership, supported operations, and provider
capabilities. The planner must not execute arbitrary code or choose arbitrary
filesystem paths. Use typed image tools and validated parameters.

Do not invent target coordinates from text alone. Validate localization against
image content. If several targets plausibly match, ask a short clarification.

### Local object-removal pipeline

1. Load the selected full-resolution baseline and derive a planning preview.
2. Resolve the target and generate a mask in known image coordinates.
3. Extract the target plus enough context for coherent generation.
4. Record every crop, resize, orientation, and padding transform.
5. Invoke a compatible inpainting/editing provider.
6. Validate output dimensions, decodeability, orientation, and mapping back to
   source coordinates. Reject unresolvable geometric changes.
7. Match color and composite only through the declared write mask.
8. Verify protected pixels and store the new version atomically.

A provider without mask support may only be used if its output can be reliably
aligned and locally composited. It must pass the same preservation tests.

### Reference insertion pipeline

1. Identify the destination plane/region and any foreground occlusion.
2. Transform the original reference image into that region.
3. Apply clipping/occlusion masks and controlled light/color adjustments.
4. Use generative processing only for requested content that needs it.
5. Keep reference geometry, masks, and adjustments editable internally.

Full-resolution coordinates are authoritative. Preview coordinates must be
mapped through explicit transforms, never treated as source pixel positions.

## 7. MCP and API integration

MCP connects tools; it does not guarantee an image-editing model or compatible
input/output semantics. Discover tools and validate their schemas, then map
supported tools through an adapter rather than blindly executing arbitrary tools.

Each adapter exposes a normalized contract:

- `capabilities`: roles, mask support, reference count, pixel/dimension limits,
  accepted formats, output formats, and job/cancellation behavior.
- `edit`: prompt, source asset, optional mask, references, requested output size,
  and correlation/idempotency identifiers where supported.
- `result`: validated image asset, actual dimensions, available color/precision
  metadata, provider job ID, warnings, and available usage information.

Treat unknown capability values as unknown; verify with a small integration test.
Keep credentials on the backend, redact logs, and authorize access to project
assets. Remote services receive only the assets needed for the selected operation.

Transport constraints:

- A reachable HTTP MCP service can be connected through a backend MCP client.
- A local `stdio` MCP service must run beside a trusted backend/bridge process;
  a cloud backend cannot directly access the user's local process.
- In a personal WSL development deployment, the backend and an approved local
  MCP process may run in the same environment.
- Never allow untrusted web clients to supply arbitrary shell commands for
  starting local MCP servers.

Start with one actual provider selected by the owner. Do not pretend that a mock
adapter proves model quality or live interoperability. Automated tests may use
clearly labeled fakes for error handling and reproducible pipeline checks.

## 8. RAW, precision, and color

Keep the CR3 immutable. Decode sensor data through the RAW engine and apply a
versioned development recipe: white balance, exposure, and basic tone controls.
Do not use the embedded JPEG as the authoritative editing/export source.

Use an explicit high-precision working representation for RAW and compositing.
Create display previews separately with documented display color conversion.
Define alpha handling and blending space consistently across preview and export.

CR3 support is camera- and decoder-dependent. Maintain a tested support list,
report unsupported inputs clearly, and do not advertise all CR3 files as supported.
Do not promise color identical to Canon DPP or Lightroom without matching and
validating their processing behavior.

Generated patches may have lower precision or an assumed color profile; record
those assumptions. Test actual 16-bit export fidelity, not just file metadata.

If a later RAW adjustment invalidates existing patch lighting or appearance,
retain the prior version and invalidate/recompute dependent work or explain
that the patch requires regeneration. Never silently claim that a generated
patch is reversible RAW data.

## 9. Persistence and jobs

Suggested entities:

- Project: oriented dimensions, working color settings, active version.
- Asset: source/reference/mask/patch/preview/export, checksum, storage key,
  dimensions, precision, profile, and provenance.
- Version: parent version, operations, asset dependencies, RAW recipe.
- Message: conversation text, referenced assets, associated version/plan.
- EditPlan: structured operations and preservation constraints.
- Job: operation, status, attempts, progress, provider ID, error, timestamps.
- ProviderConnection: adapter configuration and protected credential reference.

Version state is immutable once committed. A new job always targets a specific
base version; concurrent edits must branch or be queued explicitly. A late result
must not overwrite a newer selected version.

Commit a new version only after its assets and validations succeed. Failed or
cancelled jobs keep the previous version usable. Retry must not create duplicate
versions; avoid duplicate paid provider calls where provider semantics allow.

Cache previews using source/version/settings identifiers, not filenames alone.
Use bounded worker concurrency and measure memory before setting production limits.

## 10. Implementation milestones

### M0 - Inspect and validate feasibility

- Inspect the existing WSL repository and its instructions; preserve existing work.
- Establish an application subdirectory if `internal` is a shared parent folder.
- Confirm a real provider/MCP connection and the relevant CR3 camera samples.
- Decode a CR3, create a preview, and produce a verified high-precision export.
- Run a real localized edit and reference-insertion experiment on a 24 MP image.
- Measure latency, peak memory, provider output limits, and available cost data.

Exit: documented feasibility results, provider contract, RAW support evidence,
and known limitations. Missing credentials/fixtures remain explicit blockers for
live validation, not fabricated successes.

### M1 - End-to-end localized edit

- Create the minimal web/API/storage/job skeleton.
- Upload JPEG/PNG and produce an oriented baseline plus preview.
- Accept an object-removal prompt, localize it, call the real provider, and
  composite the result at full resolution.
- Export PNG and show before/after results.

Exit: a real prompt-driven edit produces the complete 6000 x 4000 output and
passes protected-region pixel checks under the stated lossless conditions.

### M2 - Reference insertion

- Upload named references and interpret reference roles from the prompt.
- Implement planar positioning, perspective, masking, and occlusion.
- Preserve lettering/logos with deterministic placement where requested.

Exit: a reference poster is inserted into an angled frame with correct content,
geometry, and protected-region behavior.

### M3 - Conversation and versions

- Persist projects, conversation, stable object references, and asset dependencies.
- Implement follow-up edits, restore, comparison, and project reopening.
- Ensure modifying a placed image reuses its source asset and transform.

Exit: multiple edit rounds and restore/reopen work without source loss or
accumulating unintended changes outside authorized regions.

### M4 - Complete RAW and export workflows

- Integrate the validated CR3 pipeline into the UI and prompt operations.
- Add exposure/white balance/color changes and dependency handling.
- Add TIFF/PNG/JPEG exports with explicit profile and precision behavior.

Exit: supported CR3 fixtures complete the editing workflow and produce verified
exports; unsupported files fail clearly and safely.

### M5 - Usable alpha

- Add resumable uploads, timeouts, retry/cancellation, autosave, and recovery.
- Test mobile layout and desktop zoom/inspection.
- Add bounded resource usage, asset lifecycle handling, and deployment instructions.
- For access beyond localhost, add authentication, project authorization,
  credential protection, and controlled remote endpoint access before exposure.

Exit: representative workflows survive interruptions without corrupt projects;
the owner can run and evaluate the application from documented WSL commands.

## 11. Acceptance tests

### Deterministic automated checks

- Exact dimensions and orientation for 6000 x 4000 fixtures.
- Source checksum preservation across editing and export.
- Pixel equality outside the final write mask under lossless, same-space tests.
- Preview/source coordinate mapping, including orientation and padded crops.
- Mask bounds, feather boundaries, alpha handling, and perspective geometry.
- Round-trip export tests that detect accidental precision reduction.
- Version restore, late job results, duplicate retry, cancellation, and failed jobs.
- Provider errors: malformed images, unsupported mask/reference inputs,
  unexpected dimensions/aspect ratio, and timeout.

### Real-provider and visual validation

- Remove an object against simple and complex backgrounds.
- Insert a poster with readable text into a perspective frame.
- Use a low-resolution reference and verify honest quality messaging.
- Inspect seams, local sharpness, lighting, and color at 100% zoom.
- Process representative CR3 files from each claimed supported camera model.
- Compare several conversational edit rounds and restore a previous version.
- Record peak RAM, elapsed time, and known provider usage for representative jobs.

Do not equate passing automated checks with visually perfect AI output. Report
both technical validation and observed visual limitations.

## 12. Instructions for the coding agent

1. Read this plan and applicable repository instructions before editing files.
2. Inspect the repository and environment; do not assume the target folder is empty.
3. Work in small, runnable milestones. Start with M0 and M1 rather than building
   an elaborate interface ahead of the image pipeline.
4. Keep normal user interaction prompt-driven. Internal masks/layers must not
   become mandatory manual steps to make the advertised workflow succeed.
5. Do not add advanced enhancement in this iteration.
6. Preserve unrelated changes and never overwrite source images or secrets.
7. Do not invent credentials, provider capabilities, or CR3 test results.
8. Ask for actual provider configuration and samples when needed; continue
   independent infrastructure work while those inputs are pending.
9. Use real integration checks before marking live AI editing complete.
10. Document setup, environment variable names, migration commands, tests,
    limitations, and the completed milestone after each substantial delivery.
11. Keep a progress checklist in the repository. Do not mark a milestone done
    merely because the UI exists or a fake response passes a test.
12. Do not deploy publicly or introduce paid infrastructure without an explicit
    deployment decision from the owner.

## 13. Initial prompt for Copilot

```text
Read plan.md and the repository's applicable instructions. Implement the
prompt-driven photo editor described in the plan, starting with M0 and M1.
First inspect this repository and the WSL development tools. Preserve existing
work; if this is a shared parent directory, create a dedicated app subdirectory.
Build a runnable vertical slice: upload a large image, submit an object-removal
prompt, localize the target, call a configured image provider, composite only
within the authorized mask, and export at the original dimensions.
Keep source assets immutable. Do not export from a preview. Add meaningful
tests for dimensions, coordinate mapping, and protected-region preservation.
Use a provider adapter architecture for MCP/API, and ask me for the actual
connection details when necessary. Do not claim a mock demonstrates live AI
editing. Validate CR3 support with actual camera samples during feasibility work.
Defer advanced enhancement. Record progress, startup commands, verification
results, and unresolved blockers so we can continue milestone by milestone.
```
