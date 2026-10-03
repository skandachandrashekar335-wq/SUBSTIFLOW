# Substitution Engine

The substitution engine turns one question — *"this faculty member is absent; who covers their classes today?"* — into a ranked, explainable, reproducible plan. This document describes the pipeline as implemented in `src/services/substitution/`.

## Pipeline

```
  inputs
    │   date · absent faculty · settings (weights, limits, policies)
    ▼
  affected activities ──────────────────────────────── multi-faculty policy:
    │                                                  TEAM_SUFFICIENT / REPLACE_ABSENT
    ▼
  candidate pool (active faculty, availability built for the date)
    │
    ▼
  hard constraints ── reject ──► (absent · busy · daily limit · break · working hours)
    │ survivors
    ▼
  priority tier  P1 → P5
    │
    ▼
  weighted score  (configurable weights, penalties)
    │
    ▼
  ranking  (tier first, then score, stable)
    │
    ▼
  assignment  (hardest activity first · whole-span reservation · day limit)
    │
    ├──► assignment: substitute + score + reasoning
    └──► uncovered:  reason + attempted candidates
    │
    ▼
  review ──► manual override (same constraints) ──► approve ──► lock
```

Entry point: `generateSubstitutionPlan(date, academicYearId)` → `findAffectedEntries` → `solveSubstitutionProblem`. Persistence and lifecycle live in `src/services/substitution/index.ts`.

## 1. Inputs

- **Date** being planned.
- **Absent faculty** — from attendance rows marked `ABSENT` for that date.
- **Configuration** — substitution score weights, maximum daily substitutions, allow-unrelated-substitutions, multi-faculty absence policy, working hours and break window (all from Settings).
- **Master timetable** — the affected day's entries with their faculty teams, sections, subjects, rooms.

## 2. Affected activities

An activity is affected when its faculty team contains at least one absent member. For multi-faculty teams the configured policy decides:

| Policy | Some of the team absent | All of the team absent |
|---|---|---|
| `TEAM_SUFFICIENT` (default) | **Not affected** — the remaining team keeps the class running (shown as "Running With Remaining Team" in the UI) | Affected |
| `REPLACE_ABSENT` | Affected — a substitute covers the absent member's part while the rest continues | Affected |

Under `REPLACE_ABSENT` the assignment's reasoning names exactly who is being covered: *"Covering for absent faculty: Mrs. Shilpa (rest of the team continues); …"*.

An absent faculty member's own non-team activities are affected in the ordinary way.

## 3. Candidate pool and availability

`buildFacultyAvailability()` constructs, for the date:

- **busySlots** — every period the faculty already teaches (span-expanded), **plus** periods already consumed by approved substitutions that date (also span-expanded). So a faculty member who is already substituting elsewhere is busy for that span.
- **substitutionCount** — how many substitutions they already hold that day.
- **consecutiveSlots** — used as a scoring penalty, not a rejection.

Inactive faculty are excluded from the pool entirely.

**Span-aware by construction:** availability is never evaluated against just the start period. A substitute for a 2-hour lab must be free in *both* hours, because `coveredSlotsOf(entry)` expands the entry's `span` into concrete periods before any check runs.

## 4. Hard constraints

These five checks reject a candidate outright (score `-Infinity`). They are absolute — scoring never compensates for them:

| # | Constraint | Why |
|---|---|---|
| 1 | Candidate is absent that day | You cannot substitute with someone who is not there |
| 2 | Candidate is teaching during any covered period (including their existing substitutions) | No double-booking, span included |
| 3 | Candidate has reached the daily substitution limit | Workload cap (per faculty, configurable) |
| 4 | The activity is inside the break period | Breaks are not teaching time |
| 5 | The activity falls outside configured working hours | The plan must be executable within the college day |

**The same checks guard manual assignment.** The manual-override validator calls the same constraint code, and the assignment picker only offers candidates that pass — so a coordinator cannot create through the UI what generation would refuse. Attempted violations produce specific messages (*"Mrs. Ranjini is marked absent on 2026-10-02."*, *"…is already teaching another class during this slot."*).

## 5. Priority tiers (P1–P5)

Every surviving candidate gets exactly one tier, derived from relationship flags (`priorityTierFor()` — a single source of truth shared by scoring and the manual validator):

| Tier | Meaning | Derived from |
|---|---|---|
| **P1** | Normally teaches the affected class/section | `faculty_sections` join |
| **P2** | Normally teaches the same semester/year | semester overlap with the affected section |
| **P3** | Same department and teaches other classes | department + has section assignments |
| **P4** | Otherwise related — subject qualification, has taught this section, or teaches this subject | qualifications + timetable history |
| **P5** | No relationship to this class | none of the above |

**P5 handling:** unrelated faculty are only considered when Settings → *allow unrelated substitutions* is enabled; otherwise they are removed from the candidate list before ranking.

**Class familiarity deliberately outranks subject qualification** — a teacher who normally teaches the affected class is preferred over a teacher of the same subject from another class. When that happens, the reasoning says so explicitly (see §8).

## 6. Scoring

Within a tier, candidates are separated by a weighted score. Defaults (`DEFAULT_SUBSTITUTION_WEIGHTS`, all configurable in Settings → Substitution Rules):

| Factor | Default weight | Reason text |
|---|---:|---|
| Normally teaches this class | +100 | `✓ Normally teaches <section>` |
| Teaches the same semester | +60 | `✓ Teaches same semester (Semester n)` |
| Same department | +40 | `✓ Same department` |
| Qualified for the subject | +30 | `✓ Qualified for <subject>` |
| Normally teaches this subject | +20 | `✓ Normally teaches this subject` |
| Free during the slot | +20 | `✓ Free at <slot>` / `✓ Free for <range>` |
| Low daily load (0 today) | +15 | `✓ No substitutions today` (half credit at 1) |
| Has taught this section before | +10 | `✓ Has taught this section before` |
| Cross-department penalty | −50 | `Cross-department substitution` |
| Near daily limit | −30 | `Near daily substitution limit (n/max)` |
| Consecutive teaching slots | −20 | `Consecutive teaching slots (n)` |

The score is arithmetic over explicit factors — no learned components, no randomness.

## 7. Ranking and assignment

1. **Rank candidates** per activity: tier ascending (P1 first), then score descending, with a stable sort over faculty ordered by name. Equal tier + score therefore keeps a fixed input order → the plan is a pure function of database state.
2. **Assign hardest activities first.** Activities are ordered by candidate count ascending (fewest options first), ties broken by entry id — scarce-coverage activities claim candidates before easy ones.
3. **Reserve whole spans.** Once a substitute is assigned, *every* period the activity covers is added to their busy set — no partial double-booking of a 2-hour lab's second hour.
4. **Enforce the day limit globally.** The running substitution count is incremented per assignment, so the configured maximum applies across all of the day's assignments, not per activity.
5. **Output in timetable order** (weekday → period) for stable display and export.

**Uncovered.** If no candidate survives, the activity is recorded as uncovered with a reason (`No eligible faculty available`) and up to five attempted candidates. Uncovered rows are persisted with the run, so *"review required"* survives restart and shows up as Uncovered counts on the dashboard.

## 8. Explainability

Every assignment carries a `score` and a `reasoning` string built from the factor reasons, plus contextual notes:

- *"Class familiarity (P1) prioritized over 2 subject-qualified candidate(s) teaching other classes, per configured rules"* — when a qualified teacher of another class was outranked by class familiarity.
- *"Covering for absent faculty: <names> (rest of the team continues)"* — partial team coverage under `REPLACE_ABSENT`.

The planner UI renders the same list as a `✓` checklist on each card, so the coordinator sees exactly why this substitute, at this score, in this tier.

## 9. Review, approval, locking

- **Review** — the plan is editable; every manual change is validated by the same constraints (§4) and recorded in the audit log as an override. Editing an APPROVED plan reopens it for review (`APPROVED → GENERATED`).
- **Approve** — run status becomes `APPROVED` with timestamp and approver.
- **Lock** — per-assignment. Regeneration reads the locked set first and only rewrites non-locked rows, so a coordinator's locked choices survive *Generate* being pressed again. The service layer refuses substitute changes on locked rows with an explicit error (*"This substitution is locked. Unlock it before changing the substitute."*), independent of the UI control being disabled.

## Determinism guarantees

- No randomness, no wall-clock input to ranking (only the date being planned).
- Tier → score → stable name order.
- Hardest-first ordering with id tie-break.
- Output sorted by timetable position.

Same database state in → same plan out. This is asserted by the engine test suite (`engine.test.ts`, `priority.test.ts`, `hard-constraints.test.ts`).
