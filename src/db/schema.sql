-- SubstiFlow Database Schema
-- SQLite database for offline-first faculty timetable management

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- Academic Years
CREATE TABLE IF NOT EXISTS academic_years (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Departments
CREATE TABLE IF NOT EXISTS departments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Faculty
CREATE TABLE IF NOT EXISTS faculty (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    employee_id TEXT UNIQUE,
    department_id TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    max_daily_substitutions INTEGER NOT NULL DEFAULT 2,
    priority INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE RESTRICT
);

-- Subjects
CREATE TABLE IF NOT EXISTS subjects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    department_id TEXT NOT NULL,
    default_class_type TEXT NOT NULL DEFAULT 'LECTURE',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE RESTRICT
);

-- Sections/Classes
CREATE TABLE IF NOT EXISTS sections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    semester INTEGER NOT NULL,
    department_id TEXT NOT NULL,
    academic_year_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE RESTRICT,
    FOREIGN KEY (academic_year_id) REFERENCES academic_years(id) ON DELETE CASCADE,
    UNIQUE(name, academic_year_id)
);

-- Rooms
CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    capacity INTEGER NOT NULL DEFAULT 0,
    type TEXT NOT NULL DEFAULT 'CLASSROOM',
    department_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL
);

-- Time Slots
CREATE TABLE IF NOT EXISTS time_slots (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    is_break INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Master Timetable Entries
CREATE TABLE IF NOT EXISTS timetable_entries (
    id TEXT PRIMARY KEY,
    academic_year_id TEXT NOT NULL,
    day_of_week TEXT NOT NULL,
    time_slot_id TEXT NOT NULL,
    section_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    faculty_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    class_type TEXT NOT NULL DEFAULT 'LECTURE',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (academic_year_id) REFERENCES academic_years(id) ON DELETE CASCADE,
    FOREIGN KEY (time_slot_id) REFERENCES time_slots(id) ON DELETE RESTRICT,
    FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE RESTRICT,
    FOREIGN KEY (faculty_id) REFERENCES faculty(id) ON DELETE RESTRICT,
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE RESTRICT,
    UNIQUE(academic_year_id, day_of_week, time_slot_id, section_id),
    UNIQUE(academic_year_id, day_of_week, time_slot_id, faculty_id),
    UNIQUE(academic_year_id, day_of_week, time_slot_id, room_id)
);

-- Faculty-Subject Qualifications
CREATE TABLE IF NOT EXISTS faculty_subjects (
    faculty_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    proficiency INTEGER NOT NULL DEFAULT 3,
    PRIMARY KEY (faculty_id, subject_id),
    FOREIGN KEY (faculty_id) REFERENCES faculty(id) ON DELETE CASCADE,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
);

-- Faculty-Section Assignments (normal teaching assignments)
CREATE TABLE IF NOT EXISTS faculty_sections (
    faculty_id TEXT NOT NULL,
    section_id TEXT NOT NULL,
    PRIMARY KEY (faculty_id, section_id),
    FOREIGN KEY (faculty_id) REFERENCES faculty(id) ON DELETE CASCADE,
    FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE
);

-- Daily Attendance
CREATE TABLE IF NOT EXISTS attendance (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    faculty_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PRESENT', 'ABSENT')),
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (faculty_id) REFERENCES faculty(id) ON DELETE CASCADE,
    UNIQUE(date, faculty_id)
);

-- Substitution Rules
CREATE TABLE IF NOT EXISTS substitution_rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    weight REAL NOT NULL DEFAULT 1.0,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    config TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Substitution Runs (one per day)
CREATE TABLE IF NOT EXISTS substitution_runs (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'GENERATED', 'APPROVED', 'PUBLISHED')),
    generated_at TEXT,
    approved_at TEXT,
    approved_by TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Substitution Assignments
CREATE TABLE IF NOT EXISTS substitution_assignments (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    original_entry_id TEXT NOT NULL,
    substitute_faculty_id TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'LOCKED')),
    score REAL,
    reasoning TEXT,
    is_locked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (run_id) REFERENCES substitution_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (original_entry_id) REFERENCES timetable_entries(id) ON DELETE CASCADE,
    FOREIGN KEY (substitute_faculty_id) REFERENCES faculty(id) ON DELETE SET NULL,
    UNIQUE(run_id, original_entry_id)
);

-- Application Settings
CREATE TABLE IF NOT EXISTS application_settings (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    value TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_timetable_entries_academic_year ON timetable_entries(academic_year_id);
CREATE INDEX IF NOT EXISTS idx_timetable_entries_day_slot ON timetable_entries(day_of_week, time_slot_id);
CREATE INDEX IF NOT EXISTS idx_timetable_entries_faculty ON timetable_entries(faculty_id);
CREATE INDEX IF NOT EXISTS idx_timetable_entries_section ON timetable_entries(section_id);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date);
CREATE INDEX IF NOT EXISTS idx_attendance_faculty ON attendance(faculty_id);
CREATE INDEX IF NOT EXISTS idx_substitution_runs_date ON substitution_runs(date);
CREATE INDEX IF NOT EXISTS idx_substitution_assignments_run ON substitution_assignments(run_id);
CREATE INDEX IF NOT EXISTS idx_faculty_department ON faculty(department_id);
CREATE INDEX IF NOT EXISTS idx_sections_department_year ON sections(department_id, academic_year_id);
CREATE INDEX IF NOT EXISTS idx_faculty_subjects_faculty ON faculty_subjects(faculty_id);
CREATE INDEX IF NOT EXISTS idx_faculty_subjects_subject ON faculty_subjects(subject_id);
CREATE INDEX IF NOT EXISTS idx_faculty_sections_faculty ON faculty_sections(faculty_id);
CREATE INDEX IF NOT EXISTS idx_faculty_sections_section ON faculty_sections(section_id);

-- Triggers for updated_at
CREATE TRIGGER IF NOT EXISTS update_academic_years_updated_at
AFTER UPDATE ON academic_years
BEGIN
    UPDATE academic_years SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_departments_updated_at
AFTER UPDATE ON departments
BEGIN
    UPDATE departments SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_faculty_updated_at
AFTER UPDATE ON faculty
BEGIN
    UPDATE faculty SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_subjects_updated_at
AFTER UPDATE ON subjects
BEGIN
    UPDATE subjects SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_sections_updated_at
AFTER UPDATE ON sections
BEGIN
    UPDATE sections SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_rooms_updated_at
AFTER UPDATE ON rooms
BEGIN
    UPDATE rooms SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_timetable_entries_updated_at
AFTER UPDATE ON timetable_entries
BEGIN
    UPDATE timetable_entries SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_attendance_updated_at
AFTER UPDATE ON attendance
BEGIN
    UPDATE attendance SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_substitution_rules_updated_at
AFTER UPDATE ON substitution_rules
BEGIN
    UPDATE substitution_rules SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_substitution_runs_updated_at
AFTER UPDATE ON substitution_runs
BEGIN
    UPDATE substitution_runs SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_substitution_assignments_updated_at
AFTER UPDATE ON substitution_assignments
BEGIN
    UPDATE substitution_assignments SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_application_settings_updated_at
AFTER UPDATE ON application_settings
BEGIN
    UPDATE application_settings SET updated_at = datetime('now') WHERE id = NEW.id;
END;