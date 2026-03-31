const pdfParse = require("pdf-parse");
const { generateJsonWithSchema } = require("./aiClient");
const { jobMatchSchema, motivationLetterSchema } = require("./aiSchemas");
const {
  buildJobMatchPrompt: buildJobMatchPromptV1,
  buildMotivationLetterPrompt: buildMotivationPromptV1,
  PROMPT_VERSIONS,
} = require("./aiPrompts");

const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.1:8b";
const OLLAMA_ENABLED = process.env.OLLAMA_ENABLED !== "false";
const OLLAMA_TIMEOUT_MS = Number.parseInt(process.env.OLLAMA_TIMEOUT_MS || "30000", 10);

function cleanText(text) {
  const normalized = typeof text === "string" ? text : text == null ? "" : String(text);
  return normalized
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function clampScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cleanText(item)).filter(Boolean);
  }
  const text = cleanText(value);
  if (!text) return [];
  return text
    .split(",")
    .map((item) => cleanText(item))
    .filter(Boolean);
}

function countWords(text) {
  const words = cleanText(text).match(/\S+/g);
  return words ? words.length : 0;
}

function truncateToWordLimit(text, maxWords) {
  const raw = String(text || "").trim();
  if (!raw) return "";

  const tokens = raw.split(/\s+/);
  if (tokens.length <= maxWords) {
    return raw;
  }

  return `${tokens.slice(0, maxWords).join(" ").replace(/[,:;\-\s]+$/, "").trim()}.`;
}

function sanitizeRoleTitleForLetter(title) {
  return cleanText(title)
    .replace(/\s*\((?:m\s*\/\s*w\s*\/\s*d|m\s*\/\s*f\s*\/\s*d|f\s*\/\s*m\s*\/\s*d)\)\s*/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function sanitizeMotivationLetterOutput(letter, job = {}) {
  let text = String(letter || "");

  // Never include gendered shortcodes like (m/w/d) in the letter body.
  text = text.replace(/\s*\((?:m\s*\/\s*w\s*\/\s*d|m\s*\/\s*f\s*\/\s*d|f\s*\/\s*m\s*\/\s*d)\)\s*/gi, " ");

  // Remove generic location/work-mode detail sentence when present.
  text = text.replace(
    /After reviewing the position details for[^.]*\.(\s*)/gi,
    " "
  );

  // Avoid repeating numeric years requirements from the job ad.
  text = text.replace(
    /I also appreciate the expectation around[^.]*\.(\s*)/gi,
    "My skills and experience align well with the role's expectations. "
  );

  // Normalize horizontal spacing but preserve paragraph/newline structure.
  text = text.replace(/\r\n/g, "\n");
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

function summarizeCvProfile(cvText, job) {
  const cvLower = cleanText(cvText).toLowerCase();
  const skills = normalizeList(job?.required_skills).filter((skill) => cvLower.includes(skill.toLowerCase()));
  const languages = normalizeList(job?.required_languages).filter((lang) => cvLower.includes(lang.toLowerCase()));
  const strengths = [];

  if (skills.length) {
    strengths.push(`hands-on experience with ${skills.slice(0, 4).join(", ")}`);
  }
  if (job?.years_experience && cvLower.includes("experience")) {
    strengths.push("an experience level aligned with the role requirements");
  }
  if (languages.length) {
    strengths.push(`language capability in ${languages.slice(0, 3).join(", ")}`);
  }
  if (job?.education_requirements && /(bachelor|master|degree|university|college|education|diploma)/i.test(cvText)) {
    strengths.push(`education that supports the role requirements`);
  }

  return strengths;
}

function fallbackMotivationLetter(cvText, job, profile = {}) {
  const title = sanitizeRoleTitleForLetter(job?.title) || "the role";
  const company = cleanText(job?.company) || "your company";
  const city = cleanText(job?.city);
  const remoteType = cleanText(job?.remote_type);
  const employmentType = cleanText(job?.employment_type);
  const education = cleanText(job?.education_requirements);
  const experience = cleanText(job?.years_experience);
  const languages = normalizeList(job?.required_languages);
  const skills = normalizeList(job?.required_skills);
  const matchedStrengths = summarizeCvProfile(cvText, job);
  const applicantName = cleanText(profile?.applicant_name) || "Applicant";
  const applicantLocation = cleanText(profile?.applicant_location);
  const applicantEmail = cleanText(profile?.applicant_email);
  const applicantPhone = cleanText(profile?.applicant_phone);
  const recipientName = cleanText(profile?.recipient_name) || "Hiring Manager";
  const companyLocation = cleanText(profile?.company_location) || city;
  const closingName = cleanText(profile?.closing_name) || applicantName;
  const openingContext = [title, company].filter(Boolean).join(" at ");
  const skillsText = skills.length
    ? `The role's emphasis on ${skills.slice(0, 5).join(", ")} is especially compelling to me, and my CV reflects practical experience that aligns well with those priorities.`
    : "The responsibilities outlined in the job description align well with the profile and experience presented in my CV.";
  const strengthsText = matchedStrengths.length
    ? `I can contribute with ${matchedStrengths.slice(0, 3).join(", ")}, which would allow me to add value quickly in this position.`
    : "My background shows a consistent ability to adapt quickly, contribute reliably, and translate experience into measurable value for the team.";
  const requirementText = [
    experience ? "My skills and experience align well with the role's expectations." : "",
    education ? `The academic foundation referenced in the posting, including ${education}, also fits the direction of my profile.` : "",
    languages.length ? `In addition, the communication requirements, particularly ${languages.join(", ")}, match the profile presented in my CV.` : "",
  ].filter(Boolean).join(" ");

  const headerLines = [applicantName, applicantLocation, applicantEmail, applicantPhone].filter(Boolean).join("\n");
  const intro = `I am writing to express my strong interest in ${openingContext}. I am confident that the combination of my background, motivation, and professional focus would allow me to make a meaningful contribution to ${company}. What stands out most to me is the clear alignment between the needs of the role and the experience highlighted in my CV, particularly where the position requires someone who can contribute with both ownership and consistency from the start.`;
  const body = `${skillsText} ${strengthsText} ${requirementText}`.trim();
  const closingParagraph = `Beyond technical and professional alignment, I am drawn to this opportunity because it offers the chance to contribute in a setting where quality, reliability, and continuous development matter. I approach new responsibilities with a practical mindset, a willingness to learn quickly, and a strong sense of accountability for the work I deliver. I would welcome the opportunity to bring that approach to ${company} and to support the team in achieving its goals. Thank you for your time and consideration. I would be pleased to discuss my application further.`;

  const letter = [
    headerLines,
    `Dear ${recipientName},`,
    intro,
    body,
    closingParagraph,
    `Sincerely,\n${closingName}`,
  ].filter(Boolean).join("\n\n");

  const sanitized = sanitizeMotivationLetterOutput(letter, job);
  return truncateToWordLimit(sanitized, 390);
}

async function generateMotivationLetter(cvText, job, profile = {}) {
  if (!job) {
    throw new Error("Job data is required to generate a motivation letter.");
  }

  if (!OLLAMA_ENABLED) {
    const fallback = fallbackMotivationLetter(cvText, job, profile);
    return { letter: fallback, wordCount: countWords(fallback), source: "fallback" };
  }

  const parsed = await generateJsonWithSchema({
    prompt: buildMotivationPromptV1(cvText, job, profile),
    schema: motivationLetterSchema,
    schemaLabel: "MotivationLetter",
    url: OLLAMA_URL,
    model: OLLAMA_MODEL,
    timeoutMs: OLLAMA_TIMEOUT_MS,
    temperature: 0.35,
  });

  if (!parsed) {
    const fallback = fallbackMotivationLetter(cvText, job, profile);
    return { letter: fallback, wordCount: countWords(fallback), source: "fallback" };
  }

  if (parsed?.factualityChecklist?.inventedFacts) {
    const fallback = fallbackMotivationLetter(cvText, job, profile);
    return { letter: fallback, wordCount: countWords(fallback), source: "fallback" };
  }

  let letter = sanitizeMotivationLetterOutput(String(parsed.letter || "").trim(), job);
  letter = truncateToWordLimit(letter, 340);

  const wc = countWords(letter);
  const overlaps = Array.isArray(parsed.overlapHighlights) ? parsed.overlapHighlights.filter(Boolean) : [];
  if (wc < 200 || overlaps.length < 3) {
    const fallback = fallbackMotivationLetter(cvText, job, profile);
    return { letter: fallback, wordCount: countWords(fallback), source: "fallback" };
  }

  return { letter, wordCount: wc, source: `ollama:${PROMPT_VERSIONS.motivation}` };
}

function fallbackMatch(cvText, jobs) {
  const cvLower = cleanText(cvText).toLowerCase();

  return jobs
    .map((job) => {
      const skills = normalizeList(job.required_skills);
      const matched = skills.filter((skill) => cvLower.includes(skill.toLowerCase()));
      const missing = skills.filter((skill) => !cvLower.includes(skill.toLowerCase()));

      const score = skills.length
        ? Math.round((matched.length / skills.length) * 100)
        : 45;

      return {
        job_id: job.id,
        suitability_score: clampScore(score),
        summary: matched.length
          ? `Matched ${matched.length} of ${skills.length || 0} listed skills.`
          : "Limited direct skill overlap detected from extracted fields.",
        strengths: matched.slice(0, 6),
        missing_skills: missing.slice(0, 6),
        recommended: score >= 65,
      };
    })
    .sort((a, b) => b.suitability_score - a.suitability_score);
}

function normalizeAiMatches(rawMatches, jobs) {
  const byId = new Map(jobs.map((job) => [Number(job.id), job]));
  const parsed = Array.isArray(rawMatches) ? rawMatches : [];

  const normalized = parsed
    .map((item) => {
      const jobId = Number(item?.job_id);
      if (!byId.has(jobId)) return null;

      return {
        job_id: jobId,
        suitability_score: clampScore(item?.overallScore ?? item?.suitability_score),
        summary: cleanText(item?.reasoningSummary || item?.summary) || "No summary provided.",
        strengths: normalizeList(item?.strengths).slice(0, 8),
        missing_skills: normalizeList(item?.gaps || item?.missing_skills).slice(0, 8),
        recommended: typeof item?.recommended === "boolean" ? item.recommended : clampScore(item?.overallScore) >= 65,
      };
    })
    .filter(Boolean);

  const coveredIds = new Set(normalized.map((item) => item.job_id));
  const missingJobs = jobs.filter((job) => !coveredIds.has(Number(job.id)));

  if (!missingJobs.length) {
    return normalized.sort((a, b) => b.suitability_score - a.suitability_score);
  }

  const fallbackRows = fallbackMatch("", missingJobs).map((row) => ({
    ...row,
    summary: "AI response did not include this job; fallback score used.",
    suitability_score: Math.max(0, row.suitability_score - 20),
    recommended: false,
  }));

  return [...normalized, ...fallbackRows].sort((a, b) => b.suitability_score - a.suitability_score);
}

async function extractTextFromPdfBuffer(buffer) {
  const parsed = await pdfParse(buffer);
  return cleanText(parsed?.text || "");
}

async function matchCvTextToJobs(cvText, jobs) {
  if (!Array.isArray(jobs) || !jobs.length) return [];

  if (!OLLAMA_ENABLED) {
    return fallbackMatch(cvText, jobs);
  }

  const parsed = await generateJsonWithSchema({
    prompt: buildJobMatchPromptV1(cvText, jobs.slice(0, 80)),
    schema: jobMatchSchema,
    schemaLabel: "JobMatch",
    url: OLLAMA_URL,
    model: OLLAMA_MODEL,
    timeoutMs: OLLAMA_TIMEOUT_MS,
    temperature: 0.1,
  });

  if (!parsed || !parsed.matches) {
    return fallbackMatch(cvText, jobs);
  }

  const normalized = normalizeAiMatches(parsed.matches, jobs);
  if (!normalized.length) {
    return fallbackMatch(cvText, jobs);
  }

  return normalized;
}

module.exports = {
  extractTextFromPdfBuffer,
  matchCvTextToJobs,
  generateMotivationLetter,
};
