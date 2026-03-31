const path = require("path");
const Database = require("better-sqlite3");

const dbPath = path.join(__dirname, "..", "data", "jobs.db");
const db = new Database(dbPath);
const RECYCLE_BIN_RETENTION_DAYS = 5;

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function hasLegacyUniqueUrlConstraint() {
  const indexes = db.prepare("PRAGMA index_list(jobs)").all();
  return indexes.some((index) => {
    if (!index.unique) return false;
    const indexInfo = db.prepare(`PRAGMA index_info(${quoteIdentifier(index.name)})`).all();
    return indexInfo.length === 1 && indexInfo[0].name === "url";
  });
}

function rebuildJobsTableForCurrentSchema() {
  const existingColumns = db.pragma("table_info(jobs)").map((c) => c.name);
  const hasColumn = (name) => existingColumns.includes(name);

  const selectByColumn = {
    id: hasColumn("id") ? "id" : "NULL",
    user_id: hasColumn("user_id") ? "user_id" : "NULL",
    url: hasColumn("url") ? "url" : "NULL",
    title: hasColumn("title") ? "title" : "NULL",
    company: hasColumn("company") ? "company" : "NULL",
    city: hasColumn("city") ? "city" : "NULL",
    remote_type: hasColumn("remote_type") ? "remote_type" : "NULL",
    required_skills: hasColumn("required_skills") ? "required_skills" : "NULL",
    preferred_skills: hasColumn("preferred_skills") ? "preferred_skills" : "NULL",
    years_experience: hasColumn("years_experience") ? "years_experience" : "NULL",
    wage: hasColumn("wage") ? "wage" : "NULL",
    education_requirements: hasColumn("education_requirements") ? "education_requirements" : "NULL",
    employment_type: hasColumn("employment_type") ? "employment_type" : "NULL",
    required_languages: hasColumn("required_languages") ? "required_languages" : "NULL",
    note: hasColumn("note") ? "note" : "NULL",
    captured_description: hasColumn("captured_description") ? "captured_description" : "NULL",
    captured_description_source: hasColumn("captured_description_source") ? "captured_description_source" : "NULL",
    is_starred: hasColumn("is_starred") ? "COALESCE(is_starred, 0)" : "0",
    application_status: hasColumn("application_status")
      ? "COALESCE(NULLIF(application_status, ''), 'not_applied')"
      : "'not_applied'",
    deleted_at: hasColumn("deleted_at") ? "deleted_at" : "NULL",
    created_at: hasColumn("created_at") ? "created_at" : "CURRENT_TIMESTAMP",
  };

  const destinationColumns = Object.keys(selectByColumn).join(", ");
  const sourceColumns = Object.values(selectByColumn).join(", ");

  db.exec("BEGIN TRANSACTION");
  try {
    db.exec(`
      CREATE TABLE jobs_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        url TEXT NOT NULL,
        title TEXT,
        company TEXT,
        city TEXT,
        remote_type TEXT,
        required_skills TEXT,
        preferred_skills TEXT,
        years_experience TEXT,
        wage TEXT,
        education_requirements TEXT,
        employment_type TEXT,
        required_languages TEXT,
        note TEXT,
        captured_description TEXT,
        captured_description_source TEXT,
        is_starred INTEGER NOT NULL DEFAULT 0,
        application_status TEXT NOT NULL DEFAULT 'not_applied',
        deleted_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    db.exec(`
      INSERT INTO jobs_migrated (${destinationColumns})
      SELECT ${sourceColumns}
      FROM jobs
    `);

    db.exec("DROP TABLE jobs");
    db.exec("ALTER TABLE jobs_migrated RENAME TO jobs");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// Users table
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

// Motivation letter profile defaults per user
// Kept separate from users so the auth table remains focused and migrations stay simple.
db.exec(`
  CREATE TABLE IF NOT EXISTS motivation_profiles (
    user_id INTEGER PRIMARY KEY,
    applicant_name TEXT,
    applicant_location TEXT,
    applicant_email TEXT,
    applicant_phone TEXT,
    recipient_name TEXT,
    company_location TEXT,
    closing_name TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

// Saved motivation letter history per job
// Each saved row stores the generated letter plus the profile snapshot used for that version.
db.exec(`
  CREATE TABLE IF NOT EXISTS motivation_letters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    job_id INTEGER NOT NULL,
    cv_id TEXT,
    cv_file_name TEXT,
    letter_text TEXT NOT NULL,
    word_count INTEGER NOT NULL DEFAULT 0,
    source TEXT,
    applicant_name TEXT,
    applicant_location TEXT,
    applicant_email TEXT,
    applicant_phone TEXT,
    recipient_name TEXT,
    company_location TEXT,
    closing_name TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (job_id) REFERENCES jobs(id)
  )
`);

// Jobs table (new schema)
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    url TEXT NOT NULL,
    title TEXT,
    company TEXT,
    city TEXT,
    remote_type TEXT,
    required_skills TEXT,
    preferred_skills TEXT,
    years_experience TEXT,
    wage TEXT,
    education_requirements TEXT,
    employment_type TEXT,
    required_languages TEXT,
    note TEXT,
    captured_description TEXT,
    captured_description_source TEXT,
    is_starred INTEGER NOT NULL DEFAULT 0,
    application_status TEXT NOT NULL DEFAULT 'not_applied',
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

// Migration: legacy databases had UNIQUE(url), which blocks storing the same URL
// for multiple users. Rebuild once to remove that unique constraint safely.
if (hasLegacyUniqueUrlConstraint()) {
  rebuildJobsTableForCurrentSchema();
}

// Migration: add user_id to existing jobs table if the column is missing
const jobColumns = db.pragma("table_info(jobs)").map((c) => c.name);
if (!jobColumns.includes("user_id")) {
  db.exec("ALTER TABLE jobs ADD COLUMN user_id INTEGER REFERENCES users(id)");
}
if (!jobColumns.includes("required_skills")) {
  db.exec("ALTER TABLE jobs ADD COLUMN required_skills TEXT");
}
if (!jobColumns.includes("preferred_skills")) {
  db.exec("ALTER TABLE jobs ADD COLUMN preferred_skills TEXT");
}
if (!jobColumns.includes("years_experience")) {
  db.exec("ALTER TABLE jobs ADD COLUMN years_experience TEXT");
}
if (!jobColumns.includes("wage")) {
  db.exec("ALTER TABLE jobs ADD COLUMN wage TEXT");
}
if (!jobColumns.includes("education_requirements")) {
  db.exec("ALTER TABLE jobs ADD COLUMN education_requirements TEXT");
}
if (!jobColumns.includes("employment_type")) {
  db.exec("ALTER TABLE jobs ADD COLUMN employment_type TEXT");
}
if (!jobColumns.includes("required_languages")) {
  db.exec("ALTER TABLE jobs ADD COLUMN required_languages TEXT");
}
if (!jobColumns.includes("note")) {
  db.exec("ALTER TABLE jobs ADD COLUMN note TEXT");
}
if (!jobColumns.includes("captured_description")) {
  db.exec("ALTER TABLE jobs ADD COLUMN captured_description TEXT");
}
if (!jobColumns.includes("captured_description_source")) {
  db.exec("ALTER TABLE jobs ADD COLUMN captured_description_source TEXT");
}
if (!jobColumns.includes("is_starred")) {
  db.exec("ALTER TABLE jobs ADD COLUMN is_starred INTEGER NOT NULL DEFAULT 0");
}
if (!jobColumns.includes("application_status")) {
  db.exec("ALTER TABLE jobs ADD COLUMN application_status TEXT NOT NULL DEFAULT 'not_applied'");
}
if (!jobColumns.includes("deleted_at")) {
  db.exec("ALTER TABLE jobs ADD COLUMN deleted_at TEXT");
}
db.exec("UPDATE jobs SET application_status = 'not_applied' WHERE application_status IS NULL OR application_status = ''");
db.exec("UPDATE jobs SET is_starred = 0 WHERE is_starred IS NULL");

// ── Auth helpers ──────────────────────────────────────────────────────────────

function createUser({ username, email, passwordHash }) {
  const result = db
    .prepare("INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)")
    .run(username, email, passwordHash);
  return db
    .prepare("SELECT id, username, email FROM users WHERE id = ?")
    .get(result.lastInsertRowid);
}

function findUserByIdentifier(identifier) {
  return db
    .prepare("SELECT * FROM users WHERE email = ? OR username = ?")
    .get(identifier, identifier);
}

// ── Job helpers ───────────────────────────────────────────────────────────────

function upsertJob(job, userId) {
  const existing = db
    .prepare("SELECT id FROM jobs WHERE user_id = ? AND url = ?")
    .get(userId, job.url);

  if (existing) {
    db.prepare(
      `UPDATE jobs
       SET title = ?, company = ?, city = ?, remote_type = ?, required_skills = ?, preferred_skills = ?,
           years_experience = ?, wage = ?, education_requirements = ?, employment_type = ?, required_languages = ?,
           captured_description = ?, captured_description_source = ?,
           deleted_at = NULL
       WHERE id = ?`
    ).run(
      job.title,
      job.company,
      job.city,
      job.remote_type,
      job.required_skills,
      job.preferred_skills,
      job.years_experience,
      job.wage,
      job.education_requirements,
      job.employment_type,
      job.required_languages,
      job.captured_description,
      job.captured_description_source,
      existing.id
    );
  } else {
    db.prepare(
      `INSERT INTO jobs
       (user_id, url, title, company, city, remote_type, required_skills, preferred_skills, years_experience, wage, education_requirements, employment_type, required_languages, note, captured_description, captured_description_source, is_starred, application_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      userId,
      job.url,
      job.title,
      job.company,
      job.city,
      job.remote_type,
      job.required_skills,
      job.preferred_skills,
      job.years_experience,
      job.wage,
      job.education_requirements,
      job.employment_type,
      job.required_languages,
      null,
      job.captured_description,
      job.captured_description_source,
      0,
      "not_applied"
    );
  }

  return db
    .prepare("SELECT * FROM jobs WHERE user_id = ? AND url = ?")
    .get(userId, job.url);
}

function purgeExpiredDeletedJobs(userId) {
  db.prepare(
    `DELETE FROM jobs
     WHERE user_id = ?
       AND deleted_at IS NOT NULL
       AND datetime(deleted_at) <= datetime('now', ?)`
  ).run(userId, `-${RECYCLE_BIN_RETENTION_DAYS} days`);
}

function listJobs(userId) {
  purgeExpiredDeletedJobs(userId);

  return db
    .prepare(
      `SELECT id, url, title, company, city, remote_type, created_at
        , required_skills, preferred_skills, years_experience, wage, education_requirements, employment_type, required_languages, note, captured_description, captured_description_source, is_starred, application_status, deleted_at
       FROM jobs
       WHERE user_id = ?
       AND deleted_at IS NULL
       ORDER BY is_starred DESC, datetime(created_at) DESC`
    )
    .all(userId);
}

function listDeletedJobs(userId) {
  purgeExpiredDeletedJobs(userId);

  return db
    .prepare(
      `SELECT id, url, title, company, city, remote_type, created_at, deleted_at
        , required_skills, preferred_skills, years_experience, wage, education_requirements, employment_type, required_languages, note, captured_description, captured_description_source, is_starred, application_status
       FROM jobs
       WHERE user_id = ?
       AND deleted_at IS NOT NULL
       ORDER BY datetime(deleted_at) DESC`
    )
    .all(userId);
}

function updateJobStatus(jobId, userId, status) {
  const result = db
    .prepare("UPDATE jobs SET application_status = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL")
    .run(status, jobId, userId);

  if (result.changes === 0) {
    return null;
  }

  return db
    .prepare(
      "SELECT id, url, title, company, city, remote_type, required_skills, preferred_skills, years_experience, wage, education_requirements, employment_type, required_languages, note, captured_description, captured_description_source, is_starred, application_status, created_at FROM jobs WHERE id = ? AND user_id = ?"
    )
    .get(jobId, userId);
}

function updateJobStarred(jobId, userId, isStarred) {
  const result = db
    .prepare("UPDATE jobs SET is_starred = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL")
    .run(isStarred ? 1 : 0, jobId, userId);

  if (result.changes === 0) {
    return null;
  }

  return db
    .prepare(
      "SELECT id, url, title, company, city, remote_type, required_skills, preferred_skills, years_experience, wage, education_requirements, employment_type, required_languages, note, captured_description, captured_description_source, is_starred, application_status, created_at FROM jobs WHERE id = ? AND user_id = ?"
    )
    .get(jobId, userId);
}

function updateJobNote(jobId, userId, note) {
  const result = db
    .prepare("UPDATE jobs SET note = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL")
    .run(note, jobId, userId);

  if (result.changes === 0) {
    return null;
  }

  return db
    .prepare(
      "SELECT id, url, title, company, city, remote_type, required_skills, preferred_skills, years_experience, wage, education_requirements, employment_type, required_languages, note, captured_description, captured_description_source, is_starred, application_status, created_at FROM jobs WHERE id = ? AND user_id = ?"
    )
    .get(jobId, userId);
}

function deleteJob(jobId, userId) {
  const result = db
    .prepare("UPDATE jobs SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND deleted_at IS NULL")
    .run(jobId, userId);
  return result.changes > 0;
}

function restoreJob(jobId, userId) {
  const result = db
    .prepare("UPDATE jobs SET deleted_at = NULL WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL")
    .run(jobId, userId);
  return result.changes > 0;
}

function permanentlyDeleteJob(jobId, userId) {
  const result = db
    .prepare("DELETE FROM jobs WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL")
    .run(jobId, userId);
  return result.changes > 0;
}

function getMotivationProfile(userId) {
  return db
    .prepare(
      `SELECT applicant_name, applicant_location, applicant_email, applicant_phone,
              recipient_name, company_location, closing_name, updated_at
       FROM motivation_profiles
       WHERE user_id = ?`
    )
    .get(userId) || null;
}

function upsertMotivationProfile(userId, profile) {
  db.prepare(
    `INSERT INTO motivation_profiles (
       user_id, applicant_name, applicant_location, applicant_email, applicant_phone,
       recipient_name, company_location, closing_name, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) DO UPDATE SET
       applicant_name = excluded.applicant_name,
       applicant_location = excluded.applicant_location,
       applicant_email = excluded.applicant_email,
       applicant_phone = excluded.applicant_phone,
       recipient_name = excluded.recipient_name,
       company_location = excluded.company_location,
       closing_name = excluded.closing_name,
       updated_at = CURRENT_TIMESTAMP`
  ).run(
    userId,
    profile.applicant_name,
    profile.applicant_location,
    profile.applicant_email,
    profile.applicant_phone,
    profile.recipient_name,
    profile.company_location,
    profile.closing_name
  );

  return getMotivationProfile(userId);
}

function listMotivationLettersForJob(userId, jobId) {
  return db
    .prepare(
      `SELECT id, job_id, cv_id, cv_file_name, letter_text, word_count, source,
              applicant_name, applicant_location, applicant_email, applicant_phone,
              recipient_name, company_location, closing_name, created_at
       FROM motivation_letters
       WHERE user_id = ? AND job_id = ?
       ORDER BY datetime(created_at) DESC, id DESC`
    )
    .all(userId, jobId);
}

function createMotivationLetter(userId, jobId, letter) {
  const result = db
    .prepare(
      `INSERT INTO motivation_letters (
         user_id, job_id, cv_id, cv_file_name, letter_text, word_count, source,
         applicant_name, applicant_location, applicant_email, applicant_phone,
         recipient_name, company_location, closing_name
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      jobId,
      letter.cv_id,
      letter.cv_file_name,
      letter.letter_text,
      letter.word_count,
      letter.source,
      letter.applicant_name,
      letter.applicant_location,
      letter.applicant_email,
      letter.applicant_phone,
      letter.recipient_name,
      letter.company_location,
      letter.closing_name
    );

  return db
    .prepare(
      `SELECT id, job_id, cv_id, cv_file_name, letter_text, word_count, source,
              applicant_name, applicant_location, applicant_email, applicant_phone,
              recipient_name, company_location, closing_name, created_at
       FROM motivation_letters
       WHERE id = ? AND user_id = ?`
    )
    .get(result.lastInsertRowid, userId);
}

function deleteMotivationLetter(userId, letterId) {
  return db
    .prepare(`DELETE FROM motivation_letters WHERE id = ? AND user_id = ?`)
    .run(letterId, userId);
}

function clearJobDescription(userId, jobId) {
  return db
    .prepare(
      `UPDATE jobs SET captured_description = NULL, captured_description_source = NULL
       WHERE id = ? AND user_id = ?`
    )
    .run(jobId, userId);
}

module.exports = {
  createUser,
  findUserByIdentifier,
  upsertJob,
  listJobs,
  listDeletedJobs,
  updateJobStatus,
  updateJobStarred,
  updateJobNote,
  deleteJob,
  restoreJob,
  permanentlyDeleteJob,
  getMotivationProfile,
  upsertMotivationProfile,
  listMotivationLettersForJob,
  createMotivationLetter,
  deleteMotivationLetter,
  clearJobDescription,
};
