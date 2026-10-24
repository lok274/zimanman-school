# Reviewed assessment implementation record

Implementation date is 2026-10-24. Base was `b520f1cd4e9eb4409e3383e92a42857e1383763f`. Domain and API unit is `59135e5`; capture, UI and regression unit is `4499aa3`. Publishing and native tablet viewport review belong to the release owner.

## Implemented behavior

## Release correction ownership plan

The exclusive correction checkout starts at `58fdf1d`. Each open gets an immutable context containing its scope, member and expiry. Async continuations and store transactions must still own that context before mutating storage or the view. Expiry and close invalidate it. Historical review changes the displayed record without changing the active local pupil pointer.

IndexedDB owns a per-record revision. Checkpoints compare and increment it in the same read-write transaction. A context tracks only revisions returned by its own successful writes, so queued strokes from one tab serialize while a stale second tab gets a visible conflict without replacing either original. Failed undo changes the visible draft first, and destructive navigation alone requires a successful checkpoint.

The canonical assessment envelope owns its byte calculation, including worst-case terminal statuses and teacher timer space before locking a character. Publication uses one conditional SQL insert requiring at least one submitted original and no unmarked submitted originals. Existing publication remains live on regrade.

The correction units are persistence and lifecycle, capacity and publication, then full-word challenge and tablet controls. Each unit gets ordering or boundary regressions before its commit. The final unit regenerates pages and service, runs the full suite and isolated real D1 smoke, and releases ownership for independent native verification. No new framework, dependency, plugin endpoint, background schedule or deployment is part of this correction checkout.

New quizzes use the independent version 2 assessment model. Teacher choices are 看字寫 and 聽詞寫. Both accept actual free strokes, explicit per-character submission and skip with retained ink. Listen mode keeps the standard answer out of the visible and accessible pupil UI. It can speak the whole word, situation and ordinal. Submission remains pending until teacher shape marks exist.

IndexedDB checkpoints original strokes and a sealed retry outbox. Keys include class, member and run. Navigation waits for storage. Failed storage leaves the current ink visible. Failed upload leaves the same sealed original for retry. Cold class visits require membership confirmation. Local resume restores the exact saved assignment and mode. Local next-pupil switching is explicit after sealing, preserves prior originals for teacher review, and excludes class caches from the local list.

The first complete class-member original is immutable. Same-content retries return its receipt; changed payloads and later runs conflict. Owner-only review permits shape marks, independent stroke-order practice notes and revision-checked regrading. Only complete marks can rank. The initial board publication is explicit; later revisions update the published board. The board exposes only aliases, correct-character counts and competition ranks. Elapsed time is teacher-only and never breaks a tie.

Post-submission guided practice retains the existing practice path. The optional six-word context challenge stores separate original ink and produces picture, purpose and original-ink work cards. It never changes the formal original or score.

Expiry remains class creation plus 24 hours. Owner deletion cascades class members, original ink, review state and publication. Public HTTP cleanup uses server time only and deletes at most ten already-expired classes per invocation. The application does not expose MCP tools or enable a background schedule.

## Reconciled architecture choices

Model the Domain kept the assessment state separate from legacy `session.js` and the old aggregate scorer. No version 5 practice flags or legacy score conversion were added.

Ordinary JSON remains the transport and storage format. The planned 4 MiB maximum is retained as the reviewed HTTP body bound, but canonical originals are limited to 1,800,000 bytes. [D1 documents a 2,000,000-byte maximum string, BLOB or row](https://developers.cloudflare.com/d1/platform/limits/). The smaller original budget leaves 200 KB for marks and row metadata. The draft is checked against this budget before any character becomes immutable. Points remain bounded at 200,000 per original, with 256 strokes per character. Overflow retains the editable current stroke and requires explicit undo; it never thins or silently truncates ink.

The normalized capture grid is 10000 by 10000. All captured points inside the writing area are retained in order. Boundary clipping follows the visible writing area. Replay shows the captured paths and stroke order; it does not replace them with a font or recognition outline.

Reviews and original ink share one reviewed-submission row. The member primary key protects the first original. Grading updates only review columns with an atomic revision condition. A separate publication row controls initial visibility. Live board reads therefore reflect each committed regrade without a second publish step.

Standalone first-original protection applies to a local context, not every user of the same assignment. An explicit next-pupil action releases its pointer while retaining the sealed original for 24-hour review.

## Verification evidence

- `node --test tests/*.test.cjs` passed all 175 tests with no skips or failures.
- `node dist/data/self-check.mjs` passed 11 unique glyphs, 140 strokes, geometry, Hong Kong ordering, notices and provenance hashes.
- `node scripts/version-assets.cjs`, `node scripts/standalone.cjs` and `node classroom-service/build.mjs` succeeded. Standalone HTML is 2,519,560 bytes; the generated Worker is 64,649 bytes.
- Standalone service export tests copied all six shared sources and produced a byte-identical Worker.
- Pinned Wrangler 4.92.0 applied both generated migrations to the isolated local D1 database.
- The actual local Worker and D1 smoke passed legacy regressions, private reviewed originals, concurrent immutable submission, revision conflict, explicit publication, equal-score/different-time ties, regrading and owner deletion.
- The actual local service round-tripped all 77,312 points of the constructed 12-position, 151-stroke, 512-samples-per-stroke fixture. Canonical JSON was 1,284,165 bytes. This is a capacity fixture, not an observed pupil trial.
- Additional tests cover near-1.8 MB originals, aggregate pre-lock point and byte overflow, concurrent class and global quotas, bounded cleanup, pointer cancellation, storage failure, reload, upload retry and member isolation.

The Drizzle migration and metadata were generated with the existing pinned 0.31.10 toolkit and 0.45.2 ORM. Migration 0000 and its snapshot were preserved. The local npm install attempt was cancelled without adding dependencies. Local development processes were stopped before ownership handoff.

## Release inputs

The exported service `shared/` list is `quiz-results.js`, `content.js`, `assessment.js`, `freehand.js`, `assessment-review.js` and `assessment.css`. The frontend additionally embeds `assessment-store.js` and `assessment-ui.js`. The service builder derives `src/quiz-results.js`, `src/assessment.js`, `src/teacher-page.js` and `dist/server/index.js`. The two page asset versions and `dist/standalone.html` are generated from their canonical inputs.

For a static local preview, run `python -m http.server 4173 --bind 127.0.0.1 --directory dist` from the repository root. For local class testing, use a preview copy that injects `data-classroom-origin="http://127.0.0.1:8788"` on the two page bodies. The production files retain the existing service URL.

For the local Worker, run `node build.mjs`, `npx wrangler d1 migrations apply classroom-local --local`, then `npx wrangler dev --local --ip 127.0.0.1 --port 8788 --inspector-port 9231` inside `classroom-service`. The existing pinned installation can also be invoked directly if this checkout has no node_modules. The root-level smoke command is `node classroom-service/smoke.mjs http://127.0.0.1:8788`.

Native browser layout verification, physical Android and iPad testing, publication and deployed-source parity were not performed by this implementation owner. Periodic cleanup remains unconfigured. Server expiry and the bounded cleanup operation are implemented and tested, but provider backup erasure is not promised.
