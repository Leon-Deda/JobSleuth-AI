function cleanText(text) {
  const normalized = typeof text === "string" ? text : text == null ? "" : String(text);
  return normalized
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

const PROMPT_VERSIONS = {
  jobTable: "JOB_TABLE_PROMPT_V1",
  motivation: "MOTIVATION_PROMPT_V1",
  jobMatch: "JOB_MATCH_PROMPT_V1",
  normalization: "JOB_NORMALIZATION_PROMPT_V1",
};

function buildJobTableExtractionPrompt({ title, company, city, descriptionText }) {
  const compactDescription = cleanText(descriptionText).slice(0, 12000);

  return [
    `Prompt-Version: ${PROMPT_VERSIONS.jobTable}`,
    "You are a precise job-data extraction engine for a job table.",
    "Return ONLY valid JSON. No markdown. No comments. No extra keys.",
    "Extract only explicitly stated facts from the provided text.",
    "If unknown, return null (or [] for arrays).",
    "Do not infer salary, degree, or years from title alone.",
    "All output values must be in English.",
    "Output schema:",
    '{"required_skills":[],"years_experience":null,"wage":null,"education_requirements":null,"employment_type":null,"required_languages":[]}',
    "Normalization rules:",
    "- required_skills: concise skill names only, each item 1-4 words.",
    "- years_experience: one string like '0-2 years of experience' | '3+ years of experience' | '5 years of experience'.",
    "- wage: output in English format; convert 'pro Stunde' to 'per hour', 'pro Monat' to 'per month', 'pro Jahr' to 'per year'. Remove 'brutto'/'netto' qualifiers. Example: '15.00 EUR per hour' not '15,00 EUR brutto pro Stunde'.",
    "- employment_type: one of Full-time, Part-time, Internship, Mini-job, Working student, Contract, Freelance, Temporary, Permanent, or null.",
    "- required_languages: language names with optional level (e.g., 'German (C1)').",
    "Few-shot example:",
    'Input: "Looking for a BI analyst with SQL and Power BI. 2+ years experience. English required. Full-time.",',
    'Output: {"required_skills":["SQL","Power BI"],"years_experience":"2+ years of experience","wage":null,"education_requirements":null,"employment_type":"Full-time","required_languages":["English"]}',
    `Title: ${cleanText(title) || ""}`,
    `Company: ${cleanText(company) || ""}`,
    `City: ${cleanText(city) || ""}`,
    "Description:",
    compactDescription,
  ].join("\n");
}

function buildEnglishNormalizationPrompt(job) {
  const compactDescription = cleanText(job?.captured_description || "").slice(0, 3500);

  return [
    `Prompt-Version: ${PROMPT_VERSIONS.normalization}`,
    "You normalize extracted job table values to English without adding new facts.",
    "Return ONLY valid JSON. No markdown. No comments. No extra keys.",
    "Translate non-English values to English while preserving meaning.",
    "Keep null values as null and arrays as arrays.",
    "Normalization rules:",
    "- wage: convert 'pro Stunde' to 'per hour', 'pro Monat' to 'per month', 'pro Jahr' to 'per year'. Remove 'brutto'/'netto'. Normalize decimal: 15,00 → 15.00.",
    "Output schema:",
    '{"title":null,"company":null,"city":null,"remote_type":null,"required_skills":[],"preferred_skills":null,"years_experience":null,"wage":null,"education_requirements":null,"employment_type":null,"required_languages":[],"captured_description":null}',
    "Input values:",,
    JSON.stringify({
      title: job?.title ?? null,
      company: job?.company ?? null,
      city: job?.city ?? null,
      remote_type: job?.remote_type ?? null,
      required_skills: job?.required_skills ?? null,
      preferred_skills: job?.preferred_skills ?? null,
      years_experience: job?.years_experience ?? null,
      wage: job?.wage ?? null,
      education_requirements: job?.education_requirements ?? null,
      employment_type: job?.employment_type ?? null,
      required_languages: job?.required_languages ?? null,
      captured_description: compactDescription || null,
    }),
  ].join("\n");
}

function buildJobMatchPrompt(cvText, jobs) {
  const compactCv = cleanText(cvText).slice(0, 10000);
  const compactJobs = jobs.map((job) => ({
    id: job.id,
    title: cleanText(job.title),
    company: cleanText(job.company),
    city: cleanText(job.city),
    required_skills: cleanText(job.required_skills),
    years_experience: cleanText(job.years_experience),
    education_requirements: cleanText(job.education_requirements),
    required_languages: cleanText(job.required_languages),
    employment_type: cleanText(job.employment_type),
    captured_description: cleanText(job.captured_description || "").slice(0, 1400),
  }));

  return [
    `Prompt-Version: ${PROMPT_VERSIONS.jobMatch}`,
    "You are a strict recruiter scoring engine.",
    "Task: score CV-to-job fit with explainable dimensions.",
    "Return ONLY valid JSON. No markdown. No comments.",
    "Use only evidence from CV text and job fields.",
    "If evidence is weak, reduce confidence.",
    "Penalize missing hard requirements more than preferred ones.",
    "Do not use naive single-letter skill matching.",
    "Output schema:",
    '{"matches":[{"job_id":0,"overallScore":0,"dimensionScores":{"skills":0,"experience":0,"domainFit":0,"language":0,"locationAndLogistics":0},"strengths":[],"gaps":[],"mustFixBeforeApplying":[],"fastImprovements":[],"reasoningSummary":"","confidence":50}]}',
    "CV text:",
    compactCv,
    "Jobs:",
    JSON.stringify(compactJobs),
  ].join("\n");
}

function buildMotivationLetterPrompt(cvText, job, profile = {}) {
  const cleanTitle = cleanText(job?.title)
    .replace(/\s*\((?:m\s*\/\s*w\s*\/\s*d|m\s*\/\s*f\s*\/\s*d|f\s*\/\s*m\s*\/\s*d)\)\s*/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  const compactCv = cleanText(cvText).slice(0, 9000);
  const jobCard = {
    title: cleanTitle,
    company: cleanText(job?.company),
    city: cleanText(job?.city),
    required_skills: cleanText(job?.required_skills),
    years_experience: cleanText(job?.years_experience),
    education_requirements: cleanText(job?.education_requirements),
    required_languages: cleanText(job?.required_languages),
    employment_type: cleanText(job?.employment_type),
    captured_description: cleanText(job?.captured_description || "").slice(0, 1800),
  };

  const profileCard = {
    applicant_name: cleanText(profile.applicant_name),
    applicant_location: cleanText(profile.applicant_location),
    applicant_email: cleanText(profile.applicant_email),
    applicant_phone: cleanText(profile.applicant_phone),
    recipient_name: cleanText(profile.recipient_name),
    company_location: cleanText(profile.company_location),
    closing_name: cleanText(profile.closing_name),
  };

  return [
    `Prompt-Version: ${PROMPT_VERSIONS.motivation}`,
    "You are an expert motivation-letter writer for job applications.",
    "Return ONLY valid JSON. No markdown. No comments.",
    "Write in English, professional and specific tone.",
    "Length target: 220-320 words.",
    "Use ONLY facts supported by CV text and job data.",
    "Do not invent employers, years, degrees, certifications, or achievements.",
    "Must mention company name and role title if present.",
    "Must include exactly 3 strongest CV-job overlap points.",
    "Do NOT include role-gender suffixes like (m/w/d), (m/f/d), or (f/m/d).",
    "Do NOT write a sentence that repeats position details like city, on-site/remote mode, or full-time/part-time in one list.",
    "When discussing experience fit, do not restate numeric years required from the job; state generally that your skills and experience match the requirement.",
    "Output schema:",
    '{"letter":"","overlapHighlights":[],"factualityChecklist":{"inventedFacts":false,"mentionsCompanyAndRole":true,"includesThreeOverlaps":true}}',
    "CV text:",
    compactCv,
    "Job data:",
    JSON.stringify(jobCard),
    "Letter profile:",
    JSON.stringify(profileCard),
  ].join("\n");
}

module.exports = {
  PROMPT_VERSIONS,
  buildJobTableExtractionPrompt,
  buildEnglishNormalizationPrompt,
  buildJobMatchPrompt,
  buildMotivationLetterPrompt,
};
