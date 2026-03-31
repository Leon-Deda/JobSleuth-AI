const fs = require("fs/promises");
const path = require("path");

const CV_DIR = path.join(__dirname, "..", "data", "cv_profiles");
const MAX_CVS_PER_USER = 3;

function getCvFilePath(userId) {
  return path.join(CV_DIR, `user-${userId}.json`);
}

async function ensureCvDirectory() {
  await fs.mkdir(CV_DIR, { recursive: true });
}

function normalizeMatches(matches) {
  if (!Array.isArray(matches)) return [];
  return matches.map((row) => ({
    job_id: Number(row?.job_id) || 0,
    suitability_score: Number(row?.suitability_score) || 0,
    summary: String(row?.summary || ""),
    strengths: Array.isArray(row?.strengths) ? row.strengths.map((s) => String(s)).filter(Boolean) : [],
    missing_skills: Array.isArray(row?.missing_skills) ? row.missing_skills.map((s) => String(s)).filter(Boolean) : [],
    recommended: Boolean(row?.recommended),
  }));
}

async function readUserCvStore(userId) {
  try {
    const raw = await fs.readFile(getCvFilePath(userId), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;

    // Backward compatibility for old single-CV payload shape.
    if (parsed.fileDataBase64) {
      return {
        userId,
        items: [
          {
            id: "cv-1",
            fileName: String(parsed.fileName || "cv.pdf"),
            fileDataBase64: String(parsed.fileDataBase64 || ""),
            updatedAt: parsed.updatedAt || new Date().toISOString(),
            lastMatchedAt: parsed.updatedAt || null,
            matches: [],
          },
        ],
      };
    }

    const items = Array.isArray(parsed.items)
      ? parsed.items
          .map((item) => ({
            id: String(item?.id || ""),
            fileName: String(item?.fileName || "cv.pdf"),
            fileDataBase64: String(item?.fileDataBase64 || ""),
            updatedAt: item?.updatedAt || null,
            lastMatchedAt: item?.lastMatchedAt || null,
            matches: normalizeMatches(item?.matches),
          }))
          .filter((item) => item.id && item.fileDataBase64)
      : [];

    return { userId, items };
  } catch {
    return null;
  }
}

async function writeUserCvStore(userId, payload) {
  await ensureCvDirectory();
  await fs.writeFile(getCvFilePath(userId), JSON.stringify(payload), "utf8");
}

function toClientCvProfile(item) {
  return {
    id: item.id,
    fileName: item.fileName,
    updatedAt: item.updatedAt || null,
    lastMatchedAt: item.lastMatchedAt || null,
    matches: normalizeMatches(item.matches),
  };
}

function generateCvId() {
  const now = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `cv-${now}-${rand}`;
}

async function listUserCvProfiles(userId) {
  const store = (await readUserCvStore(userId)) || { userId, items: [] };
  return store.items.map(toClientCvProfile);
}

async function getUserCvProfile(userId, cvId) {
  const store = await readUserCvStore(userId);
  if (!store) return null;
  const item = store.items.find((entry) => entry.id === String(cvId));
  return item || null;
}

async function saveUserCvProfile(userId, { cvId, fileName, fileDataBase64, matches }) {
  const now = new Date().toISOString();
  const store = (await readUserCvStore(userId)) || { userId, items: [] };
  const targetCvId = cvId ? String(cvId) : null;
  const existingIndex = targetCvId
    ? store.items.findIndex((entry) => entry.id === targetCvId)
    : -1;

  if (existingIndex === -1 && store.items.length >= MAX_CVS_PER_USER) {
    const error = new Error(`Maximum ${MAX_CVS_PER_USER} CVs allowed.`);
    error.code = "CV_LIMIT_REACHED";
    throw error;
  }

  if (existingIndex >= 0) {
    const previous = store.items[existingIndex];
    store.items[existingIndex] = {
      ...previous,
      fileName: String(fileName || previous.fileName || "cv.pdf"),
      fileDataBase64: String(fileDataBase64 || previous.fileDataBase64 || ""),
      updatedAt: now,
      lastMatchedAt: now,
      matches: normalizeMatches(matches),
    };
  } else {
    store.items.push({
      id: generateCvId(),
      fileName: String(fileName || "cv.pdf"),
      fileDataBase64: String(fileDataBase64 || ""),
      updatedAt: now,
      lastMatchedAt: now,
      matches: normalizeMatches(matches),
    });
  }

  await writeUserCvStore(userId, store);
  const saved = existingIndex >= 0 ? store.items[existingIndex] : store.items[store.items.length - 1];
  return toClientCvProfile(saved);
}

async function updateUserCvMatches(userId, cvId, matches) {
  const store = await readUserCvStore(userId);
  if (!store) return null;

  const index = store.items.findIndex((entry) => entry.id === String(cvId));
  if (index < 0) return null;

  const now = new Date().toISOString();
  store.items[index] = {
    ...store.items[index],
    lastMatchedAt: now,
    matches: normalizeMatches(matches),
  };

  await writeUserCvStore(userId, store);
  return toClientCvProfile(store.items[index]);
}

async function removeUserCvProfile(userId, cvId) {
  const store = await readUserCvStore(userId);
  if (!store) return false;

  const next = store.items.filter((entry) => entry.id !== String(cvId));
  if (next.length === store.items.length) return false;

  store.items = next;
  await writeUserCvStore(userId, store);
  return true;
}

module.exports = {
  MAX_CVS_PER_USER,
  listUserCvProfiles,
  getUserCvProfile,
  saveUserCvProfile,
  updateUserCvMatches,
  removeUserCvProfile,
};
