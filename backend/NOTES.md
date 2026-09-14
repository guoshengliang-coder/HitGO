# Implementation notes / deviations from CONTRACT.md

Decisions taken where the contract was silent or ambiguous. Everything else follows the contract literally.

## EditSpec validation (`PUT /api/videos/{id}/spec`)
- Unknown keys on the top level, layers and outputs are **ignored** (not rejected) so the frontend can carry
  UI-only fields; the raw JSON as received is stored, so those fields round-trip. `layer_overrides` entries are
  strict: only `anchor | margin | width | rotate | opacity` (unknown key → 400).
- `text.style` is loosely typed (extra keys allowed) because the worker never reads it; only the PNG matters.
- Trim ranges are validated against the video duration (`b <= duration`) and rejected if they would remove the
  whole video. `layers[].t` is not checked against the post-trim duration (frontend only warns, per contract).
- `layer_overrides` may reference layer ids that no longer exist; they are silently unused at render time.
- `width` is limited to `(0, 1]` of the canvas width; `opacity` to `[0, 1]`; `rotate` to `[-360, 360]`.
- Validation errors return `400 {detail, errors:[{field, message}]}`; FastAPI's default 422 for malformed bodies
  is also mapped to 400 to match the contract's error shape.
- Saving a spec requires the video to be `ready` (duration is needed for trim validation). `edit_spec: null`
  clears the spec on any video.

## Batch apply
- The "empty spec" created for a spec-less target is `{spec_version:1, trim:{remove:[]}, layers:[], outputs:[]}`.
  It has **no outputs**, so `POST /api/render` will answer 400 for that video until outputs are applied/edited.
- The source video is silently dropped from `target_video_ids`; duplicates are collapsed. Returned videos are
  ordered by `order`.
- `trim` onto a shorter target: ranges starting past the target duration are dropped, ranges crossing it are clamped.

## Jobs / render
- `render_status` looks at the **latest job per variant_key** over *all* variants that ever had a job for the
  video (not only variants in the current spec). Priority: failed > running > queued > done(all) > idle.
- `status_counts.failed` counts both preprocessing failures and videos whose latest render failed.
- `POST /api/render` validates every requested video first and creates nothing if any is invalid
  (404 unknown id, 400 not ready / no spec / spec invalid), then checks conflicts (409 `{detail, conflicts}`).
- Layer warnings (missing sticker asset, text layer without `image_url`, missing PNG) leave the job `done` with
  `error = "警告：…"`, as the contract asks. The frontend should treat `error` on a `done` job as a warning.
- Retry bumps `attempt`, which is the last component of `idempotency_key`.
- `output.codec` is `h264/aac` when the output has audio, `h264` otherwise.
- Progress writes are throttled to one DB commit per second and capped at 99 until ffmpeg exits successfully.

## Filter graph
- Still-image layer inputs use plain `-i img.png` and `overlay=…:eof_action=repeat` (no `-loop`), so the image
  frame is held for the whole main stream.
- Rotation: `rotate=<rad>:c=none:ow='rotw(<rad>)':oh='roth(<rad>)'` on the RGBA image; the overlay x/y is shifted so
  the rotated bounding box stays centred on the un-rotated box centre (contract: rotation about the layer centre).
- Layer size uses explicit `scale=w:h` (h from the image aspect) instead of `scale=w:-1` so the layout math and
  ffmpeg agree to the pixel. Text layers prefer the spec's `image_size` over the PNG's real size when present.
- `fill=color` colors are passed as `0xRRGGBB` (same as `#RRGGBB`, avoids any `#` quoting concerns).
- With no `trim.remove`, audio is mapped straight from the input (`-map 0:a:0`) instead of going through the graph.

## Preprocessing
- Sprite tiles are `scale=90:-2` for vertical sources and `scale=160:-2` for horizontal ones; the real tile size is
  read back from the produced JPEG with Pillow (`image width / 10`, `image height / rows`).
- Poster time is `min(0.5, duration / 2)`.
- Rotation metadata (`tags.rotate` / `side_data_list.rotation` of 90/270) swaps the reported width/height, matching
  what ffmpeg does when it autorotates during decoding.

## Uploads
- Multipart parsing goes through Starlette's `UploadFile` (spooled to a temp file past 1 MiB), then copied to
  `source.mp4` in 1 MiB chunks. Nothing is held whole in memory, but the request is spooled once by the parser.
- `POST /api/batches/{id}/videos` is all-or-nothing: an invalid file or a failed enqueue (503) removes the files and
  rows written for that request.
- Source files keep their original extension (`source.mp4` / `source.mov`); `source_url` reflects it.

## Misc
- Builtin assets: on startup, files in `samples/stickers` and `samples/fonts` (or `SAMPLES_DIR`) are imported once as
  `source=builtin`. Set `SAMPLES_DIR=-` to disable.
- `/media/hitgo.db*` and `/media/tmp/*` return 404 from the access-gate middleware before StaticFiles sees them.
- Cookie `hitgo_access` is `Secure` only when `PUBLIC_BASE_URL` starts with `https://`.
- Timestamps are stored as naive UTC and serialised as `YYYY-MM-DDTHH:MM:SSZ` (works on SQLite and PostgreSQL).
- Extra endpoints: `GET /api/health` (compose healthcheck) and `GET /api/docs`.
