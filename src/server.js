const express = require("express");
const cors = require("cors");
const { z } = require("zod");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const { extractJobDataFromUrl, extractJobDataFromText } = require("./extractJobData");
const { extractTextFromPdfBuffer, matchCvTextToJobs, generateMotivationLetter } = require("./jobMatch");
const {
  MAX_CVS_PER_USER,
  listUserCvProfiles,
  getUserCvProfile,
  saveUserCvProfile,
  updateUserCvMatches,
  removeUserCvProfile,
} = require("./cvStore");
const {
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
} = require("./db");

const app = express();
const port = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-jwt-secret-change-in-production";
const SALT_ROUNDS = 12;
const DEBUG_DESCRIPTION_ENABLED =
  process.env.ENABLE_DESCRIPTION_DEBUG === "true" || process.env.NODE_ENV !== "production";

function sanitizeDebugFields(job) {
  if (!job) return job;
  const hasDesc = Boolean(job.captured_description);
  if (DEBUG_DESCRIPTION_ENABLED) return { ...job, has_description: hasDesc };
  const { captured_description: _desc, captured_description_source: _source, ...rest } = job;
  return { ...rest, has_description: hasDesc };
}

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "ai-job-tracker-backend" });
});

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required" });
  }
  try {
    req.user = jwt.verify(authHeader.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ── Auth schemas ──────────────────────────────────────────────────────────────

const registerSchema = z.object({
  username: z
    .string()
    .min(3, "Username must be at least 3 characters")
    .max(20, "Username must be at most 20 characters")
    .regex(/^[a-zA-Z0-9_]+$/, "Username can only contain letters, numbers, and underscores"),
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

const loginSchema = z.object({
  identifier: z.string().min(1, "Email or username is required"),
  password: z.string().min(1, "Password is required"),
});

// ── Auth routes ───────────────────────────────────────────────────────────────

app.post("/auth/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  const { username, email, password } = parsed.data;
  try {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = createUser({ username, email, passwordHash });
    const token = jwt.sign(
      { userId: user.id, username: user.username, email: user.email },
      JWT_SECRET,
      { expiresIn: "7d" }
    );
    return res.status(201).json({ token, user });
  } catch (error) {
    if (error.message && error.message.includes("UNIQUE constraint failed")) {
      const field = error.message.includes("email") ? "email" : "username";
      return res.status(409).json({ error: `This ${field} is already taken` });
    }
    return res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/auth/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  const { identifier, password } = parsed.data;
  try {
    const user = findUserByIdentifier(identifier);
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const token = jwt.sign(
      { userId: user.id, username: user.username, email: user.email },
      JWT_SECRET,
      { expiresIn: "7d" }
    );
    return res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
  } catch {
    return res.status(500).json({ error: "Login failed" });
  }
});

// ── Jobs routes (protected) ───────────────────────────────────────────────────

const createJobSchema = z.object({
  url: z.string().url(),
});

const createJobFromTextSchema = z.object({
  description: z.string().min(30, "Description must be at least 30 characters"),
  title: z.string().optional(),
  company: z.string().optional(),
  city: z.string().optional(),
});

const updateStatusSchema = z.object({
  status: z.enum(["not_applied", "applied", "interview_process", "rejected", "accepted"]),
});

const updateStarSchema = z.object({
  isStarred: z.boolean(),
});

const updateNoteSchema = z.object({
  note: z.string().max(5000, "Note must be at most 5000 characters"),
});

const cvMatchSchema = z.object({
  cvId: z.string().min(3).optional(),
  fileName: z.string().optional(),
  fileDataBase64: z.string().min(40, "Invalid file payload").optional(),
});

const motivationProfileSchema = z.object({
  applicant_name: z.string().max(120, "Applicant name is too long").optional().default(""),
  applicant_location: z.string().max(120, "Applicant location is too long").optional().default(""),
  applicant_email: z.union([z.literal(""), z.string().email("Applicant email must be valid")]).optional().default(""),
  applicant_phone: z.string().max(60, "Applicant phone is too long").optional().default(""),
  recipient_name: z.string().max(120, "Recipient name is too long").optional().default(""),
  company_location: z.string().max(120, "Company location is too long").optional().default(""),
  closing_name: z.string().max(120, "Closing name is too long").optional().default(""),
});

const motivationLetterSchema = z.object({
  cvId: z.string().min(3, "Select a saved CV"),
  jobId: z.number().int().positive("Select a valid job"),
  profile: motivationProfileSchema.optional().default({}),
});

const saveMotivationLetterSchema = z.object({
  cvId: z.string().min(3, "Select a saved CV"),
  letter: z.string().min(120, "Generate a letter before saving").max(12000, "Letter is too long"),
  wordCount: z.number().int().min(1).max(2000),
  source: z.string().max(40).optional().default("manual"),
  profile: motivationProfileSchema.optional().default({}),
});

function decodeCvPdfBuffer(fileDataBase64) {
  try {
    return Buffer.from(fileDataBase64, "base64");
  } catch {
    return null;
  }
}

function normalizeMotivationProfile(profile = {}) {
  return {
    applicant_name: String(profile.applicant_name || "").trim() || null,
    applicant_location: String(profile.applicant_location || "").trim() || null,
    applicant_email: String(profile.applicant_email || "").trim() || null,
    applicant_phone: String(profile.applicant_phone || "").trim() || null,
    recipient_name: String(profile.recipient_name || "").trim() || null,
    company_location: String(profile.company_location || "").trim() || null,
    closing_name: String(profile.closing_name || "").trim() || null,
  };
}

app.post("/jobs/from-url", requireAuth, async (req, res) => {
  const parsed = createJobSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid payload. Expected: { url: string }",
      details: parsed.error.flatten(),
    });
  }

  try {
    const extracted = await extractJobDataFromUrl(parsed.data.url);
    const row = sanitizeDebugFields(upsertJob(extracted, req.user.userId));
    return res.status(201).json({ job: row, debugDescriptionEnabled: DEBUG_DESCRIPTION_ENABLED });
  } catch (error) {
    return res.status(422).json({
      error: "Could not parse job data from URL",
      message: error.message,
    });
  }
});

app.post("/jobs/from-text", requireAuth, async (req, res) => {
  const parsed = createJobFromTextSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid payload. Expected: { description: string, title?: string, company?: string, city?: string }",
      details: parsed.error.flatten(),
    });
  }

  try {
    const extracted = await extractJobDataFromText(parsed.data.description, {
      title: parsed.data.title,
      company: parsed.data.company,
      city: parsed.data.city,
    });
    const row = sanitizeDebugFields(upsertJob(extracted, req.user.userId));
    return res.status(201).json({ job: row, debugDescriptionEnabled: DEBUG_DESCRIPTION_ENABLED });
  } catch (error) {
    return res.status(422).json({
      error: "Could not parse job data from text",
      message: error.message,
    });
  }
});

app.get("/jobs", requireAuth, (req, res) => {
  const jobs = listJobs(req.user.userId).map(sanitizeDebugFields);
  res.json({ jobs, debugDescriptionEnabled: DEBUG_DESCRIPTION_ENABLED });
});

app.get("/jobs/deleted", requireAuth, (req, res) => {
  const jobs = listDeletedJobs(req.user.userId).map(sanitizeDebugFields);
  res.json({ jobs, debugDescriptionEnabled: DEBUG_DESCRIPTION_ENABLED });
});

app.patch("/jobs/:id/status", requireAuth, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid job id" });
  }

  const parsed = updateStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid status value" });
  }

  const updated = updateJobStatus(id, req.user.userId, parsed.data.status);
  if (!updated) {
    return res.status(404).json({ error: "Job not found" });
  }

  return res.json({ job: sanitizeDebugFields(updated), debugDescriptionEnabled: DEBUG_DESCRIPTION_ENABLED });
});

app.patch("/jobs/:id/star", requireAuth, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid job id" });
  }

  const parsed = updateStarSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid star value" });
  }

  const updated = updateJobStarred(id, req.user.userId, parsed.data.isStarred);
  if (!updated) {
    return res.status(404).json({ error: "Job not found" });
  }

  return res.json({ job: sanitizeDebugFields(updated), debugDescriptionEnabled: DEBUG_DESCRIPTION_ENABLED });
});

app.patch("/jobs/:id/note", requireAuth, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid job id" });
  }

  const parsed = updateNoteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  const updated = updateJobNote(id, req.user.userId, parsed.data.note.trim() || null);
  if (!updated) {
    return res.status(404).json({ error: "Job not found" });
  }

  return res.json({ job: sanitizeDebugFields(updated), debugDescriptionEnabled: DEBUG_DESCRIPTION_ENABLED });
});

app.delete("/jobs/:id", requireAuth, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid job id" });
  }

  const deleted = deleteJob(id, req.user.userId);
  if (!deleted) {
    return res.status(404).json({ error: "Job not found" });
  }

  return res.status(204).send();
});

app.delete("/jobs/:id/description", requireAuth, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid job id" });
  }
  clearJobDescription(req.user.userId, id);
  return res.json({ ok: true });
});

app.get("/motivation/profile", requireAuth, (req, res) => {
  const profile = getMotivationProfile(req.user.userId) || {
    applicant_name: null,
    applicant_location: null,
    applicant_email: null,
    applicant_phone: null,
    recipient_name: null,
    company_location: null,
    closing_name: null,
    updated_at: null,
  };

  return res.json({ profile });
});

app.put("/motivation/profile", requireAuth, (req, res) => {
  const parsed = motivationProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  const profile = upsertMotivationProfile(req.user.userId, normalizeMotivationProfile(parsed.data));
  return res.json({ profile });
});

app.get("/jobs/:id/motivation-letters", requireAuth, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid job id" });
  }

  const job = listJobs(req.user.userId).find((item) => Number(item.id) === id);
  if (!job) {
    return res.status(404).json({ error: "Job not found." });
  }

  const items = listMotivationLettersForJob(req.user.userId, id);
  return res.json({ items, job: sanitizeDebugFields(job) });
});

app.post("/jobs/:id/motivation-letters", requireAuth, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid job id" });
  }

  const parsed = saveMotivationLetterSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  const job = listJobs(req.user.userId).find((item) => Number(item.id) === id);
  if (!job) {
    return res.status(404).json({ error: "Job not found." });
  }

  const cvProfile = await getUserCvProfile(req.user.userId, parsed.data.cvId);
  if (!cvProfile) {
    return res.status(404).json({ error: "Saved CV not found." });
  }

  const profile = normalizeMotivationProfile(parsed.data.profile);
  const saved = createMotivationLetter(req.user.userId, id, {
    cv_id: cvProfile.id,
    cv_file_name: cvProfile.fileName || null,
    letter_text: parsed.data.letter.trim(),
    word_count: parsed.data.wordCount,
    source: parsed.data.source || "manual",
    ...profile,
  });

  return res.status(201).json({ item: saved });
});

app.delete("/jobs/:id/motivation-letters/:letterId", requireAuth, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const letterId = Number.parseInt(req.params.letterId, 10);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(letterId) || letterId <= 0) {
    return res.status(400).json({ error: "Invalid id" });
  }
  deleteMotivationLetter(req.user.userId, letterId);
  return res.status(204).send();
});

app.post("/jobs/motivation-letter", requireAuth, async (req, res) => {
  const parsed = motivationLetterSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0].message });
  }

  const { cvId, jobId } = parsed.data;
  const cvProfile = await getUserCvProfile(req.user.userId, cvId);
  if (!cvProfile?.fileDataBase64) {
    return res.status(404).json({ error: "Saved CV not found." });
  }

  const job = listJobs(req.user.userId).find((item) => Number(item.id) === Number(jobId));
  if (!job) {
    return res.status(404).json({ error: "Job not found." });
  }

  const pdfBuffer = decodeCvPdfBuffer(cvProfile.fileDataBase64);
  if (!pdfBuffer || pdfBuffer.length < 80) {
    return res.status(400).json({ error: "Saved CV file is invalid." });
  }

  try {
    const cvText = await extractTextFromPdfBuffer(pdfBuffer);
    if (!cvText || cvText.length < 60) {
      return res.status(422).json({ error: "Could not extract enough text from CV PDF" });
    }

    const profile = normalizeMotivationProfile(parsed.data.profile);
    const result = await generateMotivationLetter(cvText, job, profile);
    return res.status(200).json({
      letter: result.letter,
      wordCount: result.wordCount,
      source: result.source,
      profile,
      job: sanitizeDebugFields(job),
      cvProfile: {
        id: cvProfile.id,
        fileName: cvProfile.fileName,
      },
    });
  } catch (error) {
    return res.status(422).json({
      error: "Could not generate motivation letter",
      message: error.message,
    });
  }
});

app.patch("/jobs/:id/restore", requireAuth, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid job id" });
  }

  const restored = restoreJob(id, req.user.userId);
  if (!restored) {
    return res.status(404).json({ error: "Job not found" });
  }

  return res.status(204).send();
});

app.delete("/jobs/:id/permanent", requireAuth, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid job id" });
  }

  const deleted = permanentlyDeleteJob(id, req.user.userId);
  if (!deleted) {
    return res.status(404).json({ error: "Deleted row not found" });
  }

  return res.status(204).send();
});

app.post("/jobs/match-cv", requireAuth, async (req, res) => {
  const parsed = cvMatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid CV payload" });
  }

  const { cvId, fileName, fileDataBase64 } = parsed.data;
  if (!fileDataBase64 && !cvId) {
    return res.status(400).json({ error: "Provide either a new PDF file or a saved CV id." });
  }

  const jobs = listJobs(req.user.userId);
  if (!jobs.length) {
    return res.status(200).json({ matches: [], message: "No extracted jobs found yet.", totalJobs: 0 });
  }

  let effectiveName = fileName || "cv.pdf";
  let effectiveBase64 = fileDataBase64;
  let existingProfile = null;

  if (cvId) {
    existingProfile = await getUserCvProfile(req.user.userId, cvId);
    if (!existingProfile) {
      return res.status(404).json({ error: "Saved CV not found." });
    }
  }

  if (!effectiveBase64 && existingProfile) {
    effectiveName = existingProfile.fileName || effectiveName;
    effectiveBase64 = existingProfile.fileDataBase64;
  }

  const pdfBuffer = decodeCvPdfBuffer(effectiveBase64);
  if (!pdfBuffer) {
    return res.status(400).json({ error: "Could not decode PDF file" });
  }

  if (!pdfBuffer || pdfBuffer.length < 80) {
    return res.status(400).json({ error: "PDF file is empty or too small" });
  }

  if (pdfBuffer.length > 12 * 1024 * 1024) {
    return res.status(400).json({ error: "PDF file is too large (max 12MB)" });
  }

  try {
    const cvText = await extractTextFromPdfBuffer(pdfBuffer);
    if (!cvText || cvText.length < 60) {
      return res.status(422).json({ error: "Could not extract enough text from CV PDF" });
    }

    const matches = await matchCvTextToJobs(cvText, jobs);
    let cvProfile;

    if (effectiveBase64 && !cvId) {
      try {
        cvProfile = await saveUserCvProfile(req.user.userId, {
          fileName: effectiveName,
          fileDataBase64: effectiveBase64,
          matches,
        });
      } catch (error) {
        if (error?.code === "CV_LIMIT_REACHED") {
          return res.status(409).json({ error: `You can save up to ${MAX_CVS_PER_USER} CVs.` });
        }
        throw error;
      }
    } else if (effectiveBase64 && cvId) {
      cvProfile = await saveUserCvProfile(req.user.userId, {
        cvId,
        fileName: effectiveName,
        fileDataBase64: effectiveBase64,
        matches,
      });
    } else {
      cvProfile = await updateUserCvMatches(req.user.userId, cvId, matches);
    }

    return res.status(200).json({
      matches,
      totalJobs: jobs.length,
      cvProfile,
    });
  } catch (error) {
    return res.status(422).json({
      error: "Could not analyze CV against jobs",
      message: error.message,
    });
  }
});

app.get("/jobs/cv", requireAuth, async (req, res) => {
  const items = await listUserCvProfiles(req.user.userId);
  return res.status(200).json({
    maxCvCount: MAX_CVS_PER_USER,
    items,
  });
});

app.post("/jobs/cv/rematch-all", requireAuth, async (req, res) => {
  const jobs = listJobs(req.user.userId);
  const profiles = await listUserCvProfiles(req.user.userId);

  if (!profiles.length) {
    return res.status(200).json({ items: [], rematched: 0 });
  }

  if (!jobs.length) {
    return res.status(200).json({ items: profiles, rematched: 0, message: "No jobs to rematch." });
  }

  const updated = [];
  for (const profile of profiles) {
    const fullProfile = await getUserCvProfile(req.user.userId, profile.id);
    if (!fullProfile?.fileDataBase64) continue;

    const pdfBuffer = decodeCvPdfBuffer(fullProfile.fileDataBase64);
    if (!pdfBuffer) continue;

    try {
      const cvText = await extractTextFromPdfBuffer(pdfBuffer);
      if (!cvText || cvText.length < 60) continue;
      const matches = await matchCvTextToJobs(cvText, jobs);
      const saved = await updateUserCvMatches(req.user.userId, profile.id, matches);
      if (saved) updated.push(saved);
    } catch {
      // Best effort per CV: continue with remaining profiles.
    }
  }

  return res.status(200).json({ items: updated, rematched: updated.length });
});

app.delete("/jobs/cv/:cvId", requireAuth, async (req, res) => {
  const cvId = String(req.params.cvId || "").trim();
  if (!cvId) {
    return res.status(400).json({ error: "Invalid CV id" });
  }

  const removed = await removeUserCvProfile(req.user.userId, cvId);
  if (!removed) {
    return res.status(404).json({ error: "Saved CV not found." });
  }

  return res.status(204).send();
});

app.use((error, _req, res, next) => {
  if (error?.type === "entity.too.large") {
    return res.status(413).json({ error: "Payload too large. Max CV size is 12MB." });
  }

  if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
    return res.status(400).json({ error: "Invalid JSON payload" });
  }

  return next(error);
});

app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});
