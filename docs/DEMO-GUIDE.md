# SubstiFlow Demo Environment Guide

A disposable, isolated BCA demo you can run in one terminal window. It creates
its own database under `<repo>/.substiflow-demo/`, seeds it with a fixture
derived from a real college exam timetable, and launches the **real** SubstiFlow
app against it — the production profile in
`~/Library/Application Support/SubstiFlow` is never read or written.

Every workflow claim in this guide was executed against the demo environment
(see [Verified results](#verified-results)); nothing here is aspirational.

---

## 1. Quick start

```bash
npm install          # once, as for normal development
npm run demo:setup   # create/reset the isolated demo database + seed the fixture
npm run demo:launch  # open the real app on the demo database (DEMO DATA banner)
```

Close the app window when you are done exploring. To start over:

```bash
npm run demo:reset   # wipe and re-seed the demo database (repeatable, no duplicates)
```

To remove the demo completely:

```bash
npm run demo:remove  # deletes ONLY <repo>/.substiflow-demo
```

Other commands:

```bash
npm run demo:status  # print the resolved demo database path + seeded record counts
npm run demo:verify  # automated end-to-end walkthrough of every workflow below
npm run demo:audit   # read-only timetable audit (text)
npm run build:electron && node scripts/demo/audit.js --json --out /tmp/substiflow-demo-audit.json
```

> `demo:setup`, `demo:reset`, `demo:status` and `demo:remove` flip the native
> module ABI to Electron for their duration (`scripts/ensure-abi.js` handles
> this, same convention as `npm run e2e`); `npm test` flips it back, so you can
> alternate freely. `demo:launch` restores the node ABI when the app closes.

---

## 2. Data safety model

| Guarantee | How it is enforced |
| --- | --- |
| Demo database lives only under `<repo>/.substiflow-demo/database/substiflow.db` | Single resolver: `src/db/demoPaths.ts`. Every demo command forces `SUBSTIFLOW_DATA_DIR` to the demo directory; an ambient value pointing elsewhere is ignored **with a printed warning** — there is no fallback to the production profile. |
| The demo refuses to touch the production profile | `assertSafeDemoPaths()` runs before **any** write and throws if the resolved demo path is non-canonical, resolves inside the production data directory, or contains it. |
| `demo:remove` deletes only demo-created data | `assertRemovableDemoDir()` requires the marker file `.substiflow-demo-root` (written by `demo:setup`); it refuses missing directories, unmarked directories and symlinks. |
| `demo:launch` never silently falls back to production | The launcher aborts if the demo database is missing (it tells you to run `demo:setup`) and always passes `SUBSTIFLOW_DATA_DIR` + `SUBSTIFLOW_DEMO=1` explicitly. |
| Demo and dev/e2e can coexist | The single-instance lock is scoped per data directory, so a running demo app only blocks demo tasks, never `npm run dev` or `npm run e2e`. |
| Mutating demo tasks refuse while the demo app is open | `setup`/`reset`/`remove` take the same per-data-directory single-instance lock as the app. |

The demo directory is git-ignored (`.substiflow-demo/`). Nothing in the demo
environment is ever committed.

---

## 3. What the fixture contains

Counts printed by `npm run demo:status` (verified by `src/__tests__/demoFixture.test.ts`):

| Entity | Count | Notes |
| --- | --- | --- |
| Academic year | 1 | `2026-2027`, active |
| Sections | 6 | `I BCA A/B`, `III BCA A/B`, `V BCA A/B` |
| Subjects | 27 | 21 from exam timetable + 6 practicals/tutorials (see §6) |
| Faculty | 14 | `Demo Faculty 01…12` (TEACHING) + `Demo Staff 01/02` (NON_TEACHING) |
| Rooms | 7 | `Demo Room 101…104` (classrooms) + `Demo Lab 1…3` (labs) |
| Time slots | 7 | 6 teaching periods 09:00–16:00 + break 13:00–14:00 |
| Weekly requirements | 54 | 8+9+10 subject-rows per semester × 2 sections |
| Teaching allocations | 66 | includes TEAM and ALTERNATE arrangements |
| Qualifications | 51 | primary teachers + backup staff for substitution |

Weekly load per section: I Sem 20 sessions (23 periods), III Sem 21 sessions
(24 periods), V Sem 21 sessions (23 periods) — realistic 60–67% weekly load across
the 6 days × 6 periods = 36-period week. Working days are Monday–Saturday.

The fixture deliberately exercises every engine feature:

- **TEAM teaching** — all four IL/GE lab courses, V Sem `ML & NN` lecture,
  and V Sem `ML Lab` list two teachers; every session shows both.
- **ALTERNATE teaching** — III Sem `AI` splits its 3 weekly sessions 2+1
  between `Demo Faculty 05` and `Demo Faculty 08`; I Sem `Tutorial` splits 1+1.
- **Contiguous multi-period labs** — every LAB subject uses a 2-period span.
- **Non-teaching staff** — `Demo Staff 01/02` exist with zero allocations,
  zero qualifications and zero section assignments; the engine must never
  schedule them, and substitution must never pick them.
- **Per-faculty substitution caps** — `Demo Faculty 07` allows 1 substitution
  per day, `Demo Faculty 09` allows 3, everyone else 2 (institution default 2).

---

## 4. Screen-by-screen walkthrough

Launch with `npm run demo:launch`. An amber **DEMO DATA** banner sits at the
top of every page (and a red DEMO DATA badge in the sidebar footer) showing the
exact demo database path; it appears only when the app is started through
`demo:launch` and never in production or E2E runs.

### 4.1 Generate, validate and publish a weekly timetable

1. **Timetable Generation** → click **Generate Timetable**. The real solver
   runs against the seeded requirements/allocations; you get
   “Draft generated: …” and run status **COMPLETED**.
2. Open the **Draft Grid** tab to inspect sessions by day (section, subject,
   faculty, room, type, duration).
3. Click **Validate Draft** — the independent validator re-checks faculty /
   section / room conflicts (span-aware), breaks, working days and TEAM
   semantics. Expect “Validation passed”.
4. Click **Publish** and confirm. The draft becomes the master timetable
    (**124 sessions** [140 occupied periods] across Monday–Saturday for the six demo sections). A session is one timetable activity row; an occupied period is one hourly grid cell, so a two-period lab contributes one session and two occupied periods.

### 4.2 Scenario A — an absence is covered

Pick any weekday published in the demo (e.g. Monday).

1. **Today's Attendance** → set the date → click a teacher's row to mark them
   **ABSENT** (e.g. `Demo Faculty 03`, who teaches 4 classes on Monday).
2. **Substitution Planner** → same date → **Generate Plan**. Every affected
   class is covered by a substitute who is teaching staff, present, free at
   that period, and within their daily substitution cap.
3. Review the plan cards (affected classes, substitutes, reasoning), then
   **Approve Plan** → status becomes **APPROVED**.
4. Click **Open Full Timetable** to see the revised timetable for that date;
   the Reports page and the run history keep the audit trail.
5. To reset just this scenario: `npm run demo:reset`.

### 4.3 Scenario B — no substitute available

The demo also shows what happens when nobody can cover: mark **all** teaching
staff absent for a date (same Attendance page), then **Generate Plan**. The
planner reports every class as **uncovered** — it never silently assigns an
ineligible substitute. Clicking **Approve Anyway** asks for an explicit
confirmation that names the uncovered class count before recording the run.

The automated walkthrough (`npm run demo:verify`) exercises exactly these two
scenarios and leaves the published timetable in place.

---

## 5. Reset, remove and diagnostics

```bash
npm run demo:status  # resolved paths, schema version, seeded counts, health
npm run demo:reset   # full wipe + re-seed (deletes only .substiflow-demo)
npm run demo:remove  # reset's big brother: delete the whole demo environment
```

- **setup/reset** always delete and recreate the demo directory (marker-checked)
  before seeding, so runs are repeatable by construction — re-running never
  duplicates records.
- **status** is read-only and safe even while the demo app is open.
- **remove** refuses while the demo app or another demo task holds the
  per-directory lock, refuses directories without the setup marker, and never
  touches anything outside `.substiflow-demo/`.
- If you ever find a `.substiflow-demo/` directory the tooling did not create
  (no marker file), the commands refuse to delete it and print the exact
  `rm -rf` to run yourself.

There is intentionally **no reset button inside the app UI** — resetting is a
CLI operation so a demo presenter cannot destroy the environment by accident.

---

## 6. Derived from the source image vs. invented

The fixture was built from an uploaded exam timetable image: **Dayananda Sagar
College of Arts, Science and Commerce — BCA examination timetable, 21–24
September 2026, I/III/V Semester** (9:00–10:30, 11:00–12:30, 2:00–3:30).

| Value | Provenance |
| --- | --- |
| Subject catalogue: `24BCA11` DMS, `24BCA13` CA, `24BCACC1` EVS, `24BCAL11` GE, `24BCAL12` IL, `24BCA12` PST, `24BCA31` DBMS, `24BCA32` P&S, `24BCA33` AI, `24BCAL31` GE, `24BCAE1` FE/WP/BDA, `24BCAL32` IL, `24BCACC2` IC-1, `24BCA51` ML & NN, `24BCA52` FED, `24BCASEC2` QT, `24BCA53` BED, `24BCA54` DIP, `24BCA55` NLP/CC, `24BCA56` IOT, `24BCA57` CS | **Standard NEP BCA catalogue** derived from college curriculum (clean codes + names) |
| Section structure: I/III/V Semester, sections A and B | **Derived** from the image's semester grouping |
| Practical & tutorial additions: `24BCAL13` DMS Lab, `24BCAT11` Tutorial, `24BCAL33` DBMS Lab, `24BCAT31` AI Tutorial, `24BCAL51` ML Lab, `24BCAL52` NLP Lab | **Added** to reflect realistic full-week Indian BCA college curriculum with lab practicals in every semester |
| Clean subject codes | **Standardized** — V Sem courses carry unique NEP BCA course codes `24BCA51` through `24BCA57` without artificial `-DUP` suffixes |
| Weekly session counts, span, teaching arrangements | **Invented** (realistic college scheduling values: ~60–67% weekly load across 36 periods) |
| Exam dates/periods (21–24 Sep 2026, three exam slots) | **Not converted** to weekly sessions — used only for the subject catalogue |
| Faculty names, rooms, labs, weekly configuration (Mon–Sat, 09:00–16:00, break 13:00–14:00) | **Invented** fictional demo values (Demo Faculty 01…12, Demo Rooms 101…104, Demo Labs 1…3) |

**Subject Codes.** All subjects use clean, unique NEP BCA course codes.
V Semester subjects are assigned consecutive course numbers (`24BCA51` ML & NN,
`24BCA52` FED, `24BCA53` BED, `24BCA54` DIP, `24BCA55` NLP/CC, `24BCA56` IOT,
`24BCA57` CS, plus `24BCASEC2` QT and labs `24BCAL51`/`24BCAL52`) ensuring
complete uniqueness and realistic college labels throughout the application.

---

## 7. Verified results

Everything below was executed in this repository (macOS, Electron 31,
Node 20.17) against the isolated demo database:

| Check | Result |
| --- | --- |
| `npm run demo:setup` (×3, including after `demo:remove`) | identical seeded counts each time; no duplicates |
| `npm run demo:status` | path + schema v8 + all counts match expectations (54 requirements, 66 allocations, 51 qualifications) |
| Real generation in the app (`npm run demo:verify`) | run **COMPLETED**, 124 sessions scheduled, 0 uncovered |
| Independent draft validation | passed, 0 errors |
| Publish | 124 sessions and 140 occupied periods written to the master timetable |
| TEAM / ALTERNATE / lab spans / breaks / no double-booking | verified in-app and by the unit suite |
| Scenario A (one teacher absent) | covered by eligible substitutes; run **APPROVED**; revised timetable renders |
| Scenario B (all 12 teachers absent) | covered = 0, all classes reported uncovered; confirmation dialog names them; run **APPROVED** on confirmation |
| `npm run typecheck` + electron tsc + `npm run build` | all pass; production build keeps the strict CSP |
| Production database | byte-identical (same SHA-256, same mtime) before and after the whole demo exercise |

The read-only audit (`node scripts/demo/audit.js`) reports section totals using
the same distinction: required/scheduled **sessions** and required/scheduled
**occupied periods**. It also prints one row for every section/subject
requirement with required sessions, required occupied periods, eligible teaching
faculty, effective arrangement (`TEAM` or `ALTERNATE`), span, scheduled sessions,
scheduled occupied periods, and missing sessions. Its occupied-period counts
expand each activity's span over the configured non-break slots; they are not
derived from the number of activity rows or from the slot start alone.

---

## 8. What this demo does *not* prove

- **Real college data.** The fixture is synthetic sample data. It does not
  demonstrate a production migration, a real timetable, or real staff.
- **Windows runtime.** The demo was exercised on macOS. Windows *packaging*
  is covered by the release pipeline, but the demo commands were not run on a
  Windows machine.
- **Scale.** The fixture is a single department with six sections. It does not
  measure solver performance at full college scale.
- **Multi-user/collaborative use.** SubstiFlow is a single-user desktop app;
  the demo does not exercise concurrent editing.

---

## 9. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `demo: launch` says no demo database | `npm run demo:setup` |
| `Refusing to operate: … production data directory` | You moved the repo or overrode env vars; run from the repository root with the stock `demo:*` scripts |
| `Refusing: … not created by the demo tooling (no marker)` | A stray `.substiflow-demo/` exists; the CLI prints the exact `rm -rf` to run, then re-run `demo:setup` |
| Mutating task refuses: demo app is running | Close the demo app window, re-run the command |
| `npm test` complains about the native module | `node scripts/ensure-abi.js node` (pretest usually does this for you) |
