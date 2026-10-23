# Classroom service

This Worker ESM service stores immutable assignments, anonymous memberships and terminal quiz results in the D1 binding `DB`. It serves the teacher page at `/` and `/teacher`. GitHub Pages serves the student app and its separate `leaderboard.html` page.

Build with Node 24 using `node build.mjs`. There are no runtime dependencies. The only output is `dist/server/index.js`. `schema.js` is the Drizzle source; `drizzle/0000_aspiring_payback.sql` and its metadata were generated with drizzle-kit 0.31.10 and drizzle-orm 0.45.2. The generated SQL uses foreign-key cascades, unique membership aliases and request keys, and a composite member/run primary key.

## Scorer and export

`../dist/quiz-results.js` in the GitHub repository is the canonical scorer. The build derives its Worker copy and embeds exactly that source. `../dist/content.js` supplies the default six-word assignment on an ordinary teacher URL. Optional selected scope from the student teacher tools still takes precedence. Tests verify the default scope, retained request on reload and export parity. Do not edit generated `src/quiz-results.js`, `src/teacher-page.js` or the output bundle.

A standalone Sites source checkout must contain the service files plus exact derived copies at `shared/quiz-results.js` and `shared/content.js`. When sibling canonical files are absent, the build uses these copies and fails if either is missing. The exporter must compare both hashes with the reviewed GitHub source, remove `shared/` from the exported `.gitignore`, track both derived copies in the Sites source commit, and preserve the managed `.openai/hosting.json`. This makes the service build reproducible from its recorded source commit. The Sites packaging owner supplies its Worker hosting manifest and copies it into `dist/.openai` when the platform requires it. Building this repository does not deploy or change any Site audience.

## HTTP contract

All API routes start with `/api/v1/classes`. Successful responses and errors use JSON and `Cache-Control: no-store`. Errors are `{error:{code,message}}`. Assignment is `{version:1,entries:[{text,selectedIndexes}]}`. Entry order and character positions are fixed per class. There is no separate assignment ID because every route binds to an immutable class code.

| Method and path | Request | Success |
| --- | --- | --- |
| `POST /api/v1/classes` | `{requestId,entries}` | `{code,assignment,expiresAt}` |
| `POST /api/v1/classes/:code/members` | `{requestId,alias,memberToken}` | `{code,memberId,alias,assignment,expiresAt}` |
| `PUT /api/v1/classes/:code/runs/:runId` | `{runId,attempts}` | `{runId,ranked,reason,score}` |
| `GET /api/v1/classes/:code/board` | No body | `{rows,personalBest,expiresAt}` |

Creation requires trusted Sites `oai-authenticated-user-id` and `oai-authenticated-user-email` headers, plus an exact same-origin `Origin`. Only the user ID is stored. The teacher page signs in through `/signin-with-chatgpt?return_to=%2Fteacher`, preserving the assignment and creation request in same-origin session storage. This relies on the platform stripping caller-supplied identity headers. Hosted verification is required before public use. No privileged token appears in the student app.

Students generate a 256-bit random hexadecimal capability before joining and persist it before sending. Only its SHA-256 hash reaches D1. Member routes use `Authorization: Bearer <capability>`. Alias normalization is NFC, trimming and case folding for collision checks; aliases are 1–20 Unicode characters without control or format characters. Reusing an alias does not recover or take over its membership.

Each attempt is `{id,occurrenceId,phase,outcome,mistakes,elapsedMs,help}`. Allowed phases are `quiz` and skipped `teacher`; outcomes are terminal `complete`, `abandoned`, or `skipped`. IDs are bounded to 100 ASCII word/hyphen characters. Help must be empty. Every assigned occurrence needs a completed or skipped attempt before a terminal receipt is accepted. Ranked results require complete coverage, no skips and no unknown durations. Sum all attempts, including abandoned retries and repeated completed writing. Round the aggregate once to the nearest 100 ms. A skip or unknown time produces `ranked:false`, a null score and `reason` of `skipped` or `unknown-time`; that receipt allows board viewing.

Rows are `{memberId,alias,mistakes,elapsedMs,rank,isMe}`. The service picks one best entire run per member, sorts by mistakes then elapsed milliseconds, and uses competition ties `1,1,3`. Personal best is the current member's row or null. Members cannot read the board without a terminal receipt. The class owner can read it using trusted platform identity. Student identity and browser-reported handwriting scores are not independently verified; this is an informal classroom activity.

Creation is idempotent by owner and request ID. Joining is idempotent by class and request ID. Submission is idempotent by member and run ID. A repeated key with a changed canonical payload returns `409 CONFLICT`. Each quota check and insert is one conditional SQL write, backed by unique constraints; no read-before-write capacity gate is used. Limits are 10 unexpired classes per teacher, 100 members per class, 20 terminal runs per member, 2,000 attempts per run and 256 KiB JSON. Classes expire after 24 hours. Expiry denies reads and writes immediately. Creating a new class deletes at most 10 expired classes and cascades their rows; deletion timing depends on traffic.

CORS accepts the same service origin, `https://lok274.github.io`, `http://127.0.0.1:4173` and `http://localhost:4173`. It is a browser boundary, not authentication. Private Sites may reject student requests before they reach this Worker. The frontend shows failures and retains local work; publication needs separate audience authorization.

## Verification

Run `node --test tests/*.test.cjs` from the repository root. Tests build the service and execute its Worker against actual SQLite, applying the generated migration. They cover concurrent idempotency, alias and capacity boundaries, scoring parity, terminal access, expiry, CORS, authentication, pending retry and stale identity responses. Node 24 includes the SQLite module.

After installing the pinned development tools in this directory, local D1 verification is:

```sh
node build.mjs
npx wrangler d1 migrations apply classroom-local --local
npx wrangler dev --local --ip 127.0.0.1 --port 8788 --inspector-port 9231
```

From another terminal run `node classroom-service/smoke.mjs http://127.0.0.1:8788` at the repository root. The script refuses non-loopback hosts. It creates two local members and verifies real Worker/D1 shared results, concurrent retries, receipt gates and conflicts. Its teacher headers are test inputs to the local Worker, not a production authentication bypass.

`wrangler.jsonc` is local-only configuration with a placeholder database ID and the compatibility date supported by pinned workerd. Managed Sites binding configuration remains with the hosting owner. For student browser QA, a local server may inject only `data-classroom-origin="http://127.0.0.1:8788"` on both page bodies and serve them at port 4173. The production source defaults to `https://zimanman-classroom-1023.lokyau65.chatgpt.site`.
