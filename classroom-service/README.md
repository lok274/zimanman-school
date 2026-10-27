# Classroom service

The Worker serves the legacy teacher page and stores assignments, anonymous memberships, original handwriting and teacher reviews in D1 binding `DB`. Pages serves the student app and the new teacher entry at `teacher.html`. Assignments retain version 2 and their immutable `copy` or `listen` mode. New version 4 originals record the actual displayed mode as `presentationMode: 'copy'`; historical version 2 originals keep their original mode. New teacher choices offer 看字寫 only.

## Build and export

Run `node build.mjs` with Node 24. It produces `dist/server/index.js` without runtime dependencies. In the canonical repository it also produces tracked `../dist/teacher.html` from `src/teacher.html`. The Worker page uses relative API URLs. The Pages page uses `defaultOrigin` from `../dist/classroom.js`, shared with the student app and leaderboard. Both explicitly omit cookies. The Pages pipeline builds and checks this tracked page before publishing. Deploy the updated service before publishing the Pages entry.

Drizzle schema lives in `schema.js`. Migrations through `0002_automatic_submissions.sql`, including metadata, were generated with drizzle-kit 0.31.10 and drizzle-orm 0.45.2. The API also initializes the additive automatic table once per DB binding because Sites packaging does not apply migrations. Failed initialization retries on the next request. The inline DDL is generated from migration 0002.

The canonical shared files are in the repository's `dist/`.

- `quiz-results.js` retains legacy assignment and score behavior.
- `assessment.js` owns version 2 assignments, original validation, review scores and ties.
- `content.js` supplies the six default words.
- `character-data.js` validates and loads bounded glyph data.
- `data/characters.js` supplies the corrected assets used to generate trusted counts.
- `freehand.js` and `assessment-review.js` render and replay originals and collect teacher marks.
- `assessment.css` supplies the shared review layout.

An exported Sites source needs exact copies of all eight files under `shared/`. The presence of `shared/quiz-results.js` selects the export build. It uses only those shared copies and never writes a parent `dist/teacher.html`, even when sibling files exist. Tests build this isolated export and compare the resulting Worker byte for byte. Do not edit generated `src/quiz-results.js`, `src/assessment.js`, `src/teacher-page.js`, `src/character-data.js`, `src/target-counts.js`, `src/automatic-schema.js` or the output bundle. The export owner preserves the managed hosting manifest. Building does not deploy or change Site access.

## Direct Cloudflare hosting

The direct deployment is `https://xiezile-classroom.bwflc-school-tour-lok274.workers.dev`. `wrangler.production.jsonc` targets Worker `xiezile-classroom` and its separate D1 database in account `7171dee57a62c7406d3774457d416b27`. D1 database `xiezile-classroom` has ID `9a091c4d-c9f9-4808-8fc2-da9788ae3a9f` and binding `DB`. All three migrations, 0000 through 0002, have been applied. The checked-in `wrangler.jsonc` remains local-only with its placeholder database ID. The managed Sites export and hosting manifest remain separate.

From `classroom-service/`, build and deploy with the installed pinned tools after Cloudflare authentication:

```sh
node build.mjs
npx wrangler d1 migrations apply xiezile-classroom --remote --config wrangler.production.jsonc
npx wrangler deploy --config wrangler.production.jsonc
```

Always specify the production config for remote operations. Runtime automatic-table initialization cannot create the other tables. The first deployed bundle came from `e7b05485bd2194ac723b1b46df6dbbc2d79e4c4f`, with SHA-256 `BD6B31287013CD5907FC347719964E0D1C01A254A69FF8FBEC3989369AE6FF16` and Worker version `5607165a-5a75-44cd-ac5c-e0ba12359a26`. Changing `defaultOrigin` changes Pages output, not that Worker bundle.

`defaultOrigin` now points directly to this Worker. New class requests do not pass through ChatGPT Sites or depend on a ChatGPT account. Before publishing the Pages cutover, verify unsigned create, join, automatic submission, private originals and board access on the deployed endpoint. Confirm teacher create and student join on a phone before reporting that the sign-in problem is resolved. Regenerate the teacher page, versioned assets and standalone file for Pages publication.

Changing the API origin gives pupils and teachers separate sessionStorage state. Old unscoped keys stay untouched. Teacher owner localStorage, local practice and IndexedDB handwriting records stay intact. Existing old rooms are not migrated. Teachers create fresh rooms and pupils rejoin after refreshing Pages. Three-digit codes can repeat between databases, so the client never falls back to another endpoint. Keep the old service unchanged until its rooms expire. To roll back Worker code, retain the new D1 binding and origin. Keep an entry to new rooms reachable until expiry if Pages must be rolled back.

## Automatic HTTP contract

New v4 originals use the same immutable version 2 assignment. Every new run has `policy: 'locked-strokes-0.9-v1'`, `presentationMode: 'copy'`, ordered answers and per-word foreground time. Each answer stores `expectedStrokes`, `hintUsed`, submitted status and the exact accepted prefix as arrays of integer `[x,y]` points. Coordinates range from 0 to 10000. No per-point times are invented.

| Method and relative path | Authority | Result |
| --- | --- | --- |
| `PUT /:code/automatic-answers` | Current member | Validates v4 and stores the first automatic original. |
| `GET /:code/automatic-answers` | Current member | Returns `{answer:{run,receipt},expiresAt}` or `answer:null`. |
| `GET /:code/automatic-board` | Member with an automatic submission | Returns `{version:4,policy,expiresAt,rows}`. Rows contain member ID, alias, rounded elapsed time, rank and `isMe`. |
| `GET /:code/automatic-original/:memberId` | Trusted-origin owner | Returns the original and receipt without grading controls. |

All paths begin with `/api/v1/classes`. The receipt is `{version:4,policy,runId,official:true,elapsedMs}`. The client requires this receipt and never falls back to old answers. `GET /:code/reviews` additionally returns `automaticRunId` and `automaticElapsedMs` per member. Old scores stay behind the existing publication rule.

The server checks full counts against corrected bundled assets or the pinned external dataset. External loading is sequential per submission, has at most four concurrent fetches across requests, an eight-second timeout and a two-million-byte limit. Only up to 256 custom counts are cached. Unavailable data returns `503 DATA_UNAVAILABLE`, preserving the local retry. These checks validate structure and target counts. They do not independently recognize handwriting geometry or prevent a modified browser from forging evidence.

`automatic_submissions` has a cascading member primary key. Each member can keep one old reviewed original and one new automatic original. Both upload paths atomically sum both tables for class and global ink quotas. Identical canonical retries are idempotent; changed payloads conflict. A first-submission conflict retrieves the member's official automatic original, retains the local sealed alternative, and conditionally replaces only that active pointer.

Timing includes foreground writing, mistakes and Hint. It excludes loading, menus, background, storage failures and result waits. Same-word Next resumes time; menu visits and cold loads require Start. Ranking rounds the aggregate once to 100 ms. Stored, displayed and compared times match, so exact displayed ties share a rank. Local boards compare only matching v4 assignment, positions, actual mode and policy. They read on entry or foreground, without revision writes. Class boards poll metadata every five seconds for at most 120 successful refreshes and stop when hidden, closed or expired.

## Historical reviewed HTTP contract

The remaining reviewed endpoints preserve v2/v3 originals. New challenge UI does not use their grading or publication flow.


All routes below start with `/api/v1/classes`. Responses use JSON and `Cache-Control: no-store`. Errors have `{error:{code,message}}`. A reviewed assignment is `{version:2,mode,entries:[{text,selectedIndexes}]}`. The class fixes the assignment, including mode and selected positions.

| Method and relative path | Authority | Result |
| --- | --- | --- |
| `POST /` | Trusted-origin teacher | Accepts `{requestId,version:2,mode,entries}`; returns a three-digit code, assignment, `joinExpiresAt` and `expiresAt`. |
| `POST /:code/members` | New member capability | Accepts `{requestId,alias,memberToken}` during the first 15 minutes of a new class; returns membership and assignment. An identical saved request remains retryable after admission closes. |
| `PUT /:code/answers` | Current member | Accepts one complete sealed original; returns `{runId,official:true,version:3}` for version 3, or the legacy receipt without version. |
| `GET /:code/answers` | Current member | Returns only that member's original, marks and revision, or `answer:null`. Aggregate elapsed time is omitted. |
| `GET /:code/reviews` | Trusted-origin owner | Lists members, submission status, scores, revisions and elapsed time. |
| `GET /:code/reviews/:memberId` | Trusted-origin owner | Returns the original ink and review for that member. |
| `PUT /:code/reviews/:memberId` | Trusted-origin owner | Accepts `{revision,marks}`; updates marks, score and revision atomically. |
| `POST /:code/publication` | Trusted-origin owner | Makes completed teacher grades visible on the class board. |
| `GET /:code/board` | Member who submitted | Returns publication state and rows containing only alias, score, actual mode and rank. |
| `DELETE /:code` | Trusted-origin owner | Deletes the class and cascades memberships, originals and publication. |
| `POST /cleanup` | Public maintenance | Deletes at most 10 server-time expired classes; returns `{cleaned:true}`. |

The original has version, run ID, canonical assignment, start time, elapsed milliseconds, sealed phase, and one answer per selected position. Each answer has `occurrenceId`, `submitted` or `skipped` status, and ordered strokes. Each stroke is an ordered array of `[x,y,relativeMs]` points. Coordinates are integers from 0 to 10000. Point times must be finite, nonnegative, monotonic within the stroke and at most 24 hours. A submitted answer needs ink; a skipped answer preserves any partial ink.

Version 3 adds `presentationMode: 'copy'`, `legacyElapsedMs`, `wordProgress` and boolean `answers[].hintUsed`. Each word record has `wordId`, terminal `phase: 'submitted'`, `elapsedMs` and boolean `timeKnown`. The aggregate equals legacy time plus the word times and cannot exceed 24 hours. Historical v3 words use `START_WORD`, intermediate `NEXT_CHARACTER` and atomic `SUBMIT_WORD`; every selected character needs ink and there is no skip. Old unsealed drafts preserve ink and the old aggregate on upgrade; unknown old per-word durations stay unknown and only measured continuation is reported. Sealed originals are not upgraded. Version 3 is deliberate: an old validator must reject the payload rather than silently strip timing or hint metadata. The client requires the version 3 acknowledgement before accepting its receipt.

The pupil grid always shows a fixed pale full glyph. Hint plays cancellable stroke order using the reviewed bundled data and retains the actual ink; it never recognizes or submits an answer. Word timing runs only after explicit Start in the foreground writing page, including deliberate Hint viewing. Menu visits and cold loads require Start again. Runtime intent and wall-clock extrapolation are never stored.

A unique member key makes the first valid original official. The insert checks quotas and expiry in the same SQL statement. Exact run ID and canonical hash retries return the same receipt. A changed payload gives `409 CONFLICT`; a later run gives `409 FIRST_SUBMISSION`. Pupil ink is never changed by grading.

Marks have `occurrenceId`, `correct` of true, false or null, and a separate boolean `strokePractice`. Any null keeps the total pending and unranked. A complete review counts true shape marks only. Time, hints and stroke-order notes do not affect rank. Actual modes rank separately; equal scores share competition ranks such as 1, 1, 3. The SQL board query extracts only mode from the JSON, without loading ink into Worker memory. First publication is explicit. Later review updates immediately affect that published board. A stale review revision returns `409 REVIEW_CHANGED`.

Legacy version 1 classes keep their existing aggregate `runs/:runId` and `teacher-board` contracts for compatibility. New reviewed classes reject these routes. Legacy scores are not converted into teacher marks.

## Authority and browser recovery

The teacher browser creates a 256-bit hexadecimal capability and saves it before opening a class. The server stores only its SHA-256 hash. Every teacher route requires `X-Teacher-Capability` and a trusted teacher origin. Trusted teacher origins are the service's own origin and exactly `https://lok274.github.io`. A same-origin browser GET may omit Origin but must then send `Sec-Fetch-Site: same-origin`. CORS allows `X-Teacher-Capability` and `DELETE` only for those origins. Localhost remains a student origin and cannot manage classes. Preflights reject unknown requested headers and methods. No platform access token is embedded in either page.

GitHub Pages origin trust covers every project under the `lok274.github.io` account, not just this repository path. The two teacher origins retain separate browser capabilities. Existing rooms remain manageable through the old `/teacher` page with its saved capability. New Pages rooms use the Pages capability. Capabilities are never migrated through a URL, and neither a class code nor an assignment fragment grants teacher access.

Students create a capability before joining, retain it in sessionStorage, and send it as a Bearer token. The server also stores only its hash. Alias collisions cannot take over another membership. Cold reload requires explicit identity continuation before private reads. Request generation checks reject late responses after an identity switch.

The frontend stores handwriting and sealed retries in IndexedDB, keyed by class, member and run. An atomic scope initializer prevents concurrent tabs from replacing an active pointer. Every completed stroke and destructive navigation checkpoints the original. Failed storage keeps ink visible and blocks progress. A failed upload keeps the sealed original available for the same retry. sessionStorage contains membership and small receipts, never ink payloads.

Local v4 boards use separate scopes. Back releases only the displayed sealed run pointer and retains its history. Old local drafts remain under their original keys and are not upgraded into accepted progress.

## Capacity and retention

The reviewed request body is capped at 4 MiB. Canonical original JSON is capped at 1,800,000 bytes. This reserves space below D1's documented 2,000,000-byte maximum string, BLOB or table row for marks and metadata. See [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

The other limits are 200,000 points per original, 256 strokes per historical character or 64 per v4 character, 48 selected positions, 64 MiB of original JSON per class, and 256 MiB globally. Current draft aggregate limits are checked before each character is locked. A v4 stroke that exceeds capacity is rejected before accepted progress advances; prior accepted ink stays visible. There is no silent thinning or point truncation. A server quota rejection returns `507 INK_CAPACITY` and leaves the local sealed retry intact. Legacy bodies remain capped at 256 KiB.

Class limits remain 100 members, 10 active classes per owner and 100 active classes globally. New class codes use the decimal range 100–999 and remain reserved for 24 hours. Admission to a new code closes exactly 15 minutes after creation. `expiresAt` remains the 24-hour room access cutoff; `joinExpiresAt` is the separate admission cutoff. Existing eight-character codes retain their original admission window and data. All reads and writes require an unexpired class. Owner deletion cascades immediately. Creation and the public maintenance endpoint each delete at most 10 expired classes. Caller-supplied cutoffs and class selectors do not affect cleanup. Periodic background cleanup has not been enabled. There is no MCP endpoint. Provider backups are outside this application deletion guarantee.

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

The Worker tests apply all migrations to Node's SQLite database. They verify immutable concurrent submissions, metadata round trips, actual-mode ranking, revision conflicts, private access, CORS, byte quotas, ties, expiry and cleanup cascades. UI tests exercise locked acceptance, per-character Submit/O/Next, time boards, cancellable one-stroke hints, Undo, recovery, privacy and stale callbacks. Real pinned-vendor tests verify matching, normalized hydration and a stable listener target. They do not certify physical tablet or stylus behavior.

With the pinned development tools available, run a real local Worker and D1:

```sh
node build.mjs
npx wrangler d1 migrations apply classroom-local --local
npx wrangler dev --local --ip 127.0.0.1 --port 8788 --inspector-port 9231
```

Run `node classroom-service/smoke.mjs http://127.0.0.1:8788` from another terminal at the repository root. It refuses non-loopback hosts. It checks legacy behavior, reviewed original and grading routes, and a full 12-position, 151-stroke, 77,312-point JSON round trip. That fixture is constructed capacity evidence, not a pupil trial.

A student frontend preview can serve `dist/` at port 4173 and inject only `data-classroom-origin="http://127.0.0.1:8788"` on the two page bodies. Preview teacher management through the local Worker `/teacher`, since localhost is not a trusted cross-origin teacher. Production uses the direct Worker origin above. Source verification does not prove deployed parity, physical iPad or Android input, or scheduled cleanup.
