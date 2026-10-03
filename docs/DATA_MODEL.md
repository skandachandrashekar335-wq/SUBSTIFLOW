# Data Model

SubstiFlow stores everything in one local SQLite database (schema version **3**). This document explains the important concepts and why the model is shaped this way — not every column.

## Why this model exists

The core requirement is: *the master timetable must be able to answer "who teaches what, where, when" without ambiguity, while a single day's substitutions happen around it without corrupting it.* That drives three decisions:

1. **Activities are rows, not grid cells.** A timetable entry is a self-contained fact (subject + period + span + class + faculty team + rooms). Days and periods are references, so the same activity can be reasoned about, validated, and exported as one object.
2. **Substitutions never touch the master.** Attendance and substitution runs live in their own tables; the revised day view is derived by combining a run with the master entries it replaces.
3. **Relationships are explicit joins.** Faculty teams and room assignments are ordered many-to-many joins, because "the same four faculty in a different order" and "which room for this lab" are real questions the UI asks.

## Core scheduling concepts

### Academic year and terms

- `academic_years` — a named year (e.g. 2024-2025) that owns terms and to which timetable entries are scoped.
- `terms` — dated ranges within an academic year with an effective flag. The app always knows *which timetable is active today*: the dashboard and master timetable show the currently effective term, and entries are filtered through the active year.

**Why:** colleges run the same grid differently per year, and "which term is this date in" must be derived, not remembered by the user.

### Class / section

- `sections` — a class group (name, semester, department). Sections are the unit that attendance affects: a substitution covers *a section's* activity.
- `departments` — grouping for sections and faculty; feeds same-department substitution logic.

### Subject and faculty

- `subjects` — catalog entries; each has an academic year scope.
- `faculty` — staff records with department, active flag, and a per-faculty daily substitution limit.
- `faculty_subjects` — *qualifications*: which subjects a faculty member is qualified to teach.
- `faculty_sections` — which sections (and semesters) a faculty member normally teaches.

These two join tables are the raw material for the substitution priority tiers (P1–P4): "normally teaches this class" and "same semester" are queries against them, not flags someone maintains by hand.

### Rooms

- `rooms` — with type (`CLASSROOM`, `LAB`, `AUDITORIUM`, `OTHER`).
- `timetable_entry_rooms` — ordered room assignment per activity (a lab may occupy a specific room), enabling room double-booking detection.

### Time slots

- `time_slots` — the ordered periods of the day (`start_time`, `end_time`, `is_break`). Working hours and break windows used by substitution constraints come from settings plus this table.

## The timetable activity

`timetable_entries` is the centre of the model:

| Aspect | Column(s) | Meaning |
|---|---|---|
| When | `day_of_week`, `time_slot_id` | weekday + starting period |
| How long | `span` | number of consecutive periods the activity covers (1 = single period; 2 = a 2-hour lab) |
| What | `subject_id`, `type` | subject and activity type |
| Whose class | `section_id`, `academic_year_id` | which class, in which year |
| Who teaches | → `timetable_entry_faculty` | one **or several** faculty, ordered |
| Where | → `timetable_entry_rooms` | zero or more rooms, ordered |

**Class type** (`LECTURE`, `LAB`, `TUTORIAL`, `LIBRARY`, `MENTORING`, `SKILL_BUILD`, `COE`, `OTHER`) is not decoration: `LECTURE` and `LAB` require at least one faculty member, while types like library or mentoring may legitimately have none. Validation is tightened per type — never weakened globally.

**Span** is the alternative to creating two rows for a 2-hour lab. Everything that needs "all periods this occupies" expands the span through `coveredSlotsOf()` — conflict detection, a substitute's availability, working-hours checks, and the revised timetable all agree because they share that one expansion.

**Multi-faculty** is the alternative to inventing a "lab coordinator" workaround: a lab shared by four staff is one activity with four ordered faculty. Substitution logic then reasons about *teams* (who is absent, whether the remaining team is sufficient).

## Attendance

`attendance` — one row per faculty per date with `PRESENT`/`ABSENT` (plus a note).

Attendance is an *input* to substitution, never a mutation of the timetable: the master grid does not change when someone is marked absent.

## Substitution runs and assignments

- `substitution_runs` — one generated plan for a date: status (`GENERATED` → `APPROVED`, plus a review state driven by uncovered activities), generated-at metadata, and who approved it.
- `substitution_assignments` — per affected activity: the original entry, the substitute faculty (nullable → uncovered), score, reasoning text, per-assignment status (`PENDING`/`APPROVED`/`REJECTED`/`LOCKED`), and `is_locked`.

**Why `is_locked` on the assignment:** locking is a *state*, not a UI gesture. Regeneration reads the locked set first and writes only non-locked rows; the service layer refuses substitute changes on locked rows; restart persistence needs no session memory.

**Why uncovered is stored:** "no one could cover this" is a real outcome a coordinator must see after restart, not a transient UI message. Uncovered rows are persisted with their reason.

- `substitution_rules` — a registry table for named rules (weight + JSON config). The behaviour currently active is driven by settings (weights, unrelated-substitution policy, multi-faculty policy); the table exists as the schema-level home for rule configuration.

## Settings

`application_settings` — key/value rows with descriptions, including:

- institution name/address, first-run completion flag
- working hours, break window, working days
- maximum daily substitutions per faculty
- substitution score weights (JSON)
- allow-unrelated-substitutions toggle
- multi-faculty absence policy (`TEAM_SUFFICIENT` / `REPLACE_ABSENT`)

Settings are ordinary rows edited through the Settings page; a self-repair path keeps rows addressable (a row without an id cannot be updated — see CHANGELOG).

## Audit log

`audit_log` — append-only records: timestamp (UTC), action, entity type/id, and a human-readable detail. Written by services at the moment a real action happens (attendance marked, plan generated, assignment overridden, locked/unlocked, approved, timetable entry created/deleted).

**Why:** the coordinator workflow is a chain of accountability — who changed what, when, and why the revised timetable says what it says. The audit table is the evidence layer for that chain.

## Schema versioning

- Base schema: `src/db/schema.sql`.
- Changes ship as forward-only migrations in `src/db/migrations.ts`, each transactional, recorded in `schema_version`.
- Current `TARGET_SCHEMA_VERSION`: **3** (v2 introduced multi-faculty/span/dated settings; v3 introduced terms and audit).
- Older databases are upgraded automatically on open; a backup is taken each launch day before you rely on it (see [RELEASE.md](RELEASE.md)).

## Entity overview

```
academic_years ─┬─ terms
                └─ timetable_entries ─┬─ subjects
                                      ├─ sections ── departments
                                      ├─ timetable_entry_faculty ── faculty ─┬─ faculty_subjects ── subjects
                                      │                                      └─ faculty_sections ── sections
                                      └─ timetable_entry_rooms ── rooms
time_slots

attendance (faculty × date)
substitution_runs (date, status) ── substitution_assignments (entry → substitute, score, reasoning, is_locked)
application_settings (key/value)   substitution_rules (registry)
audit_log (append-only)
```
