# Classroom service

The Worker serves the teacher page and stores assignments, anonymous memberships, original handwriting and teacher reviews in D1 binding `DB`. The student app is static. New teacher-created classes use assessment version 2 with `copy` or `listen` mode.

## Build and export

Run `node build.mjs` with Node 24. It produces `dist/server/index.js` without runtime dependencies. Drizzle schema lives in `schema.js`. Migrations `0000_aspiring_payback.sql` and `0001_clammy_prima.sql`, including metadata, were generated with drizzle-kit 0.31.10 and drizzle-orm 0.45.2. Apply all pending migrations before serving the updated Worker.

The canonical shared files are in the repository's `dist/`.

- `quiz-results.js` retains legacy assignment and score behavior.
- `assessment.js` owns version 2 assignments, original validation, review scores and ties.
- `content.js` supplies the six default words.
- `freehand.js` and `assessment-review.js` render and replay originals and collect teacher marks.
- `assessment.css` supplies the shared review layout.

An exported Sites source needs exact copies of all six files under `shared/`. The builder uses them when sibling canonical files are absent. Tests build this isolated export and compare the resulting Worker byte for byte. Do not edit generated `src/quiz-results.js`, `src/assessment.js`, `src/teacher-page.js` or the output bundle. The export owner preserves the managed hosting manifest. Building does not deploy or change Site access.

## Reviewed HTTP contract

All routes below start with `/api/v1/classes`. Responses use JSON and `Cache-Control: no-store`. Errors have `{error:{code,message}}`. A reviewed assignment is `{version:2,mode,entries:[{text,selectedIndexes}]}`. The class fixes the assignment, including mode and selected positions.

| Method and relative path | Authority | Result |
| --- | --- | --- |
| `POST /` | Same-origin teacher | Accepts `{requestId,version:2,mode,entries}`; returns class code, assignment and expiry. |
| `POST /:code/members` | New member capability | Accepts `{requestId,alias,memberToken}`; returns membership and assignment. |
| `PUT /:code/answers` | Current member | Accepts one complete sealed original; returns `{runId,official:true}`. |
| `GET /:code/answers` | Current member | Returns only that member's original, marks and revision, or `answer:null`. Aggregate elapsed time is omitted. |
| `GET /:code/reviews` | Same-origin owner | Lists members, submission status, scores, revisions and elapsed time. |
| `GET /:code/reviews/:memberId` | Same-origin owner | Returns the original ink and review for that member. |
| `PUT /:code/reviews/:memberId` | Same-origin owner | Accepts `{revision,marks}`; updates marks, score and revision atomically. |
| `POST /:code/publication` | Same-origin owner | Makes completed teacher grades visible on the class board. |
| `GET /:code/board` | Member who submitted | Returns publication state and rows containing only alias, score and rank. |
| `DELETE /:code` | Same-origin owner | Deletes the class and cascades memberships, originals and publication. |
| `POST /cleanup` | Public maintenance | Deletes at most 10 server-time expired classes; returns `{cleaned:true}`. |

The original has version, run ID, canonical assignment, start time, elapsed milliseconds, sealed phase, and one answer per selected position. Each answer has `occurrenceId`, `submitted` or `skipped` status, and ordered strokes. Each stroke is an ordered array of `[x,y,relativeMs]` points. Coordinates are integers from 0 to 10000. Point times must be finite, nonnegative, monotonic within the stroke and at most 24 hours. A submitted answer needs ink; a skipped answer preserves any partial ink.

A unique member key makes the first valid original official. The insert checks quotas and expiry in the same SQL statement. Exact run ID and canonical hash retries return the same receipt. A changed payload gives `409 CONFLICT`; a later run gives `409 FIRST_SUBMISSION`. Pupil ink is never changed by grading.

Marks have `occurrenceId`, `correct` of true, false or null, and a separate boolean `strokePractice`. Any null keeps the total pending and unranked. A complete review counts true shape marks only. Time and stroke-order notes do not affect rank. Equal scores share competition ranks such as 1, 1, 3. First publication is explicit. Later review updates immediately affect that published board. A stale review revision returns `409 REVIEW_CHANGED`.

Legacy version 1 classes keep their existing aggregate `runs/:runId` and `teacher-board` contracts for compatibility. New reviewed classes reject these routes. Legacy scores are not converted into teacher marks.

## Authority and browser recovery

The teacher browser creates a 256-bit hexadecimal capability and saves it before opening a class. The server stores only its SHA-256 hash. Teacher requests send `X-Teacher-Capability` and must be same-origin. A same-origin browser GET may omit Origin but must then send `Sec-Fetch-Site: same-origin`. CORS never allows the teacher capability header. Neither a class code nor an assignment fragment grants teacher access.

Students create a capability before joining, retain it in sessionStorage, and send it as a Bearer token. The server also stores only its hash. Alias collisions cannot take over another membership. Cold reload requires explicit identity continuation before private reads. Request generation checks reject late responses after an identity switch.

The frontend stores handwriting and sealed retries in IndexedDB, keyed by class, member and run. An atomic scope initializer prevents concurrent tabs from replacing an active pointer. Every completed stroke and destructive navigation checkpoints the original. Failed storage keeps ink visible and blocks progress. A failed upload keeps the sealed original available for the same retry. sessionStorage contains membership and small receipts, never ink payloads.

Local review uses separate local contexts. Only local originals appear in the local teacher list. The explicit next-pupil action is available after sealing, releases the current pointer, and preserves its original for review. It never modifies a class member or official class score.

## Capacity and retention

The reviewed request body is capped at 4 MiB. Canonical original JSON is capped at 1,800,000 bytes. This reserves space below D1's documented 2,000,000-byte maximum string, BLOB or table row for marks and metadata. See [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

The other limits are 200,000 points per original, 256 strokes per character, 48 selected positions, 64 MiB of original JSON per class, and 256 MiB globally. Current draft aggregate limits are checked before each character is locked. An overflowing current stroke stays in the editable local draft; explicit undo can remove it. There is no silent thinning or point truncation. A server quota rejection returns `507 INK_CAPACITY` and leaves the local sealed retry intact. Legacy bodies remain capped at 256 KiB.

Class limits remain 100 members, 10 active classes per owner and 100 active classes globally. Classes expire 24 hours after creation. All reads and writes require an unexpired class. Owner deletion cascades immediately. Creation and the public maintenance endpoint each delete at most 10 expired classes. Caller-supplied cutoffs and class selectors do not affect cleanup. Periodic background cleanup has not been enabled. There is no MCP endpoint. Provider backups are outside this application deletion guarantee.

Local drafts, originals and challenge cards stop displaying at their expiry and are purged when the app next runs. Clearing browser data can lose a capability or local original. A browser capability is not a verified school identity.

## Verification

From the repository root run:

```sh
node scripts/version-assets.cjs
node scripts/standalone.cjs
node classroom-service/build.mjs
node --test tests/*.test.cjs
node dist/data/self-check.mjs
```

The Worker tests apply all migrations to Node's SQLite database. They verify immutable concurrent submissions, revision conflicts, private access, CORS, byte quotas, ties, expiry and cleanup cascades. UI tests exercise pointer capture, saved drafts, retry behavior, hidden listen answers, local review and separate challenge cards through a simulated DOM. They do not certify physical tablet or stylus behavior.

With the pinned development tools available, run a real local Worker and D1:

```sh
node build.mjs
npx wrangler d1 migrations apply classroom-local --local
npx wrangler dev --local --ip 127.0.0.1 --port 8788 --inspector-port 9231
```

Run `node classroom-service/smoke.mjs http://127.0.0.1:8788` from another terminal at the repository root. It refuses non-loopback hosts. It checks legacy behavior, reviewed original and grading routes, and a full 12-position, 151-stroke, 77,312-point JSON round trip. That fixture is constructed capacity evidence, not a pupil trial.

A frontend preview can serve `dist/` at port 4173 and inject only `data-classroom-origin="http://127.0.0.1:8788"` on the two page bodies. Production keeps the existing service URL. Source verification does not prove deployed parity, physical iPad or Android input, or scheduled cleanup.
