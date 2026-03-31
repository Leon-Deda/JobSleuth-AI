const cheerio = require("cheerio");
const { chromium } = require("playwright");
const { generateJsonWithSchema } = require("./aiClient");
const { jobTableExtractionSchema, englishNormalizationSchema } = require("./aiSchemas");
const {
  buildJobTableExtractionPrompt,
  buildEnglishNormalizationPrompt: buildNormalizationPrompt,
} = require("./aiPrompts");

const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.1:8b";
const OLLAMA_ENABLED = process.env.OLLAMA_ENABLED !== "false";
const OLLAMA_TIMEOUT_MS = Number.parseInt(process.env.OLLAMA_TIMEOUT_MS || "20000", 10);
const OLLAMA_ENGLISH_NORMALIZATION = process.env.OLLAMA_ENGLISH_NORMALIZATION !== "false";

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim() || null;
}

function cleanText(text) {
  const normalized = typeof text === "string" ? text : text == null ? "" : String(text);
  return normalized
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function sanitizeAiTextValue(value) {
  const cleaned = cleanText(value);
  if (!cleaned) return null;
  if (/^(null|none|n\/a|na|unknown|not specified|not mentioned|not provided)$/i.test(cleaned)) {
    return null;
  }
  return cleaned;
}

function sanitizeAiListValue(value) {
  if (Array.isArray(value)) {
    const items = value
      .map((item) => sanitizeAiTextValue(item))
      .filter(Boolean);
    return items.length ? items.join(", ") : null;
  }

  return sanitizeAiTextValue(value);
}

function buildOllamaPrompt({ title, company, city, descriptionText }) {
  const compactDescription = cleanText(descriptionText).slice(0, 12000);

  return [
    "You extract job data into table-ready JSON.",
    "All output values must be in English.",
    "Return ONLY valid JSON. No markdown. No comments. No extra keys.",
    "Use only facts explicitly stated in the provided job text.",
    "If a field is not clearly stated, return null (or [] for list fields).",
    "Do not infer salary, degree, or years from job title alone.",
    "",
    "Column rules:",
    "1) required_skills:",
    "- Return an array of short skill names only.",
    "- Keep each item concise (1-4 words), no sentences.",
    "- Exclude soft-generic phrases unless explicitly listed as requirement.",
    "- Good: ['Python','SQL','Power BI']; Bad: ['Must be a team player and flexible']",
    "",
    "2) years_experience:",
    "- Return one normalized string only.",
    "- Allowed styles: '0-2 years of experience', '3+ years of experience', '5 years of experience'.",
    "- If unclear, return null.",
    "",
    "3) wage:",
    "- Return salary/pay exactly as stated in text (currency + number/range + unit if available).",
    "- Examples: 'EUR 55,000 - 70,000 per year', '16,35 EUR per hour'.",
    "- Do not invent market ranges.",
    "",
    "4) education_requirements:",
    "- Return one short phrase only when explicitly required/preferred.",
    "- Examples: \"Bachelor's degree in Computer Science\", 'Completed vocational training'.",
    "- If not explicitly stated, return null.",
    "",
    "5) employment_type:",
    "- Return exactly one of:",
    "  Full-time, Part-time, Internship, Mini-job, Working student, Contract, Freelance, Temporary, Permanent",
    "- If no clear match, return null.",
    "",
    "6) required_languages:",
    "- Return an array of language requirements only.",
    "- Use short normalized values, optionally with level in same string.",
    "- Examples: ['English'], ['German (C1)','English (B2)']",
    "",
    "Output schema (must match exactly):",
    '{"required_skills":[],"years_experience":null,"wage":null,"education_requirements":null,"employment_type":null,"required_languages":[]}',
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
    "You normalize extracted job table values into English.",
    "Return ONLY valid JSON. No markdown. No comments. No extra keys.",
    "Translate non-English values to English while preserving meaning.",
    "Do not invent missing facts. Keep null values as null.",
    "Keep proper nouns (company/city names) unchanged unless a standard English name exists.",
    "Keep skill/tool names as standard English labels (e.g., SQL, Power BI, Git).",
    "Keep required_skills and required_languages as arrays.",
    "Use employment_type values from: Full-time, Part-time, Internship, Mini-job, Working student, Contract, Freelance, Temporary, Permanent, or null.",
    "Use years_experience in English like: '0-2 years of experience', '3+ years of experience', '5 years of experience'.",
    "Use wage in English formatting when possible, preserving currency and amount.",
    "Output schema (must match exactly):",
    '{"title":null,"company":null,"city":null,"remote_type":null,"required_skills":[],"preferred_skills":null,"years_experience":null,"wage":null,"education_requirements":null,"employment_type":null,"required_languages":[],"captured_description":null}',
    "Input values:",
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

async function normalizeJobDataToEnglishWithOllama(job) {
  if (!OLLAMA_ENABLED || !OLLAMA_ENGLISH_NORMALIZATION || !job) return job;

  const parsed = await generateJsonWithSchema({
    prompt: buildNormalizationPrompt(job),
    schema: englishNormalizationSchema,
    schemaLabel: "EnglishNormalization",
    url: OLLAMA_URL,
    model: OLLAMA_MODEL,
    timeoutMs: OLLAMA_TIMEOUT_MS,
    temperature: 0.1,
  });

  if (!parsed) return job;

  const translatedSkills = firstNonEmpty(
    sanitizeAiSkills(sanitizeAiListValue(parsed.required_skills)),
    sanitizeSkills(sanitizeAiListValue(parsed.required_skills)),
    sanitizeSkills(job.required_skills),
    job.required_skills
  );

  const translatedLanguages = firstNonEmpty(
    sanitizeAiListValue(parsed.required_languages),
    job.required_languages
  );

  return {
    ...job,
    title: firstNonEmpty(sanitizeAiTextValue(parsed.title), job.title),
    company: firstNonEmpty(sanitizeAiTextValue(parsed.company), job.company),
    city: firstNonEmpty(sanitizeAiTextValue(parsed.city), job.city),
    remote_type: normalizeRemoteType(firstNonEmpty(parsed.remote_type, job.remote_type)),
    required_skills: translatedSkills,
    preferred_skills: firstNonEmpty(sanitizeAiListValue(parsed.preferred_skills), job.preferred_skills),
    years_experience: firstNonEmpty(sanitizeYearsExperience(parsed.years_experience), job.years_experience),
    wage: firstNonEmpty(sanitizeWage(parsed.wage), job.wage),
    education_requirements: firstNonEmpty(sanitizeAiTextValue(parsed.education_requirements), job.education_requirements),
    employment_type: firstNonEmpty(sanitizeEmployment(parsed.employment_type), job.employment_type),
    required_languages: translatedLanguages,
    captured_description: firstNonEmpty(sanitizeAiTextValue(parsed.captured_description), job.captured_description),
  };
}

async function extractFieldsWithOllama({ title, company, city, descriptionText }) {
  if (!OLLAMA_ENABLED) return null;

  const cleanDescription = cleanText(descriptionText);
  if (!cleanDescription || cleanDescription.length < 80) return null;

  const parsed = await generateJsonWithSchema({
    prompt: buildJobTableExtractionPrompt({ title, company, city, descriptionText: cleanDescription }),
    schema: jobTableExtractionSchema,
    schemaLabel: "JobTableExtraction",
    url: OLLAMA_URL,
    model: OLLAMA_MODEL,
    timeoutMs: OLLAMA_TIMEOUT_MS,
    temperature: 0.1,
  });

  if (!parsed) return null;

  return {
    required_skills: sanitizeAiListValue(parsed.required_skills),
    years_experience: sanitizeAiTextValue(parsed.years_experience),
    wage: sanitizeAiTextValue(parsed.wage),
    education_requirements: sanitizeAiTextValue(parsed.education_requirements),
    employment_type: sanitizeAiTextValue(parsed.employment_type),
    required_languages: sanitizeAiListValue(parsed.required_languages),
  };
}

async function renderPageInBrowser(url) {
  let browser;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      locale: "en-US",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1440, height: 1600 },
    });

    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForTimeout(2500);
    await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => null);

    const snapshot = await page.evaluate(() => {
      const pickHtml = (selectors) => {
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          if (node && node.innerHTML.trim()) return node.innerHTML;
        }
        return null;
      };

      const pickText = (selectors) => {
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          if (node && node.textContent.trim()) return node.textContent;
        }
        return null;
      };

      const listItems = Array.from(document.querySelectorAll("li"))
        .map((item) => item.textContent.replace(/\s+/g, " ").trim())
        .filter(Boolean);

      return {
        html: document.documentElement.outerHTML,
        bodyText: document.body ? document.body.innerText : "",
        descriptionHtml: pickHtml([
          ".show-more-less-html__markup",
          ".description__text",
          ".description",
          "#jobDescriptionText",
          "[data-testid='jobsearch-JobComponent-description']",
          "[data-at='job-ad-description']",
          "[data-job-description]",
          "[class*='job-description']",
          "[id*='job-description']",
          "article",
          "main",
        ]),
        descriptionText: pickText([
          ".show-more-less-html__markup",
          ".description__text",
          ".description",
          "#jobDescriptionText",
          "[data-testid='jobsearch-JobComponent-description']",
          "[data-at='job-ad-description']",
          "[data-job-description]",
          "[class*='job-description']",
          "[id*='job-description']",
          "article",
          "main",
        ]),
        listItems,
      };
    });

    await context.close();
    return snapshot;
  } finally {
    if (browser) {
      await browser.close().catch(() => null);
    }
  }
}

function normalizeRemoteType(rawText) {
  const text = (rawText || "").toLowerCase();

  if (/\b(hybrid|hybrides?)\b/i.test(text)) return "Hybrid";
  if (/\b(remote|home ?office|telearbeit|fernarbeit)\b/i.test(text)) return "Remote";
  if (/\b(on[- ]?site|on site|onsite|vor ort|praesenz|prasenz|office based)\b/i.test(text)) {
    return "On-site";
  }

  return "On-site";
}

function normalizeEmploymentType(rawText) {
  const text = (rawText || "").toLowerCase();

  if (/\b(vollzeit|full[ -]?time)\b/i.test(text)) return "Full-time";
  if (/\b(teilzeit|part[ -]?time)\b/i.test(text)) return "Part-time";
  if (/\b(praktikum|internship|intern)\b/i.test(text)) return "Internship";
  if (/\b(minijob|mini[ -]?job)\b/i.test(text)) return "Mini-job";
  if (/\b(werkstudent|working student|studentische hilfskraft|student assistant)\b/i.test(text)) return "Working student";
  // German indicators: "immatrikuliert" (enrolled in university) suggests student employment
  if (/\b(immatrikuliert|studium|hochschul)\b/i.test(text)) return "Working student";

  return null;
}

function flattenJsonLdNode(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) {
    node.forEach((child) => flattenJsonLdNode(child, out));
    return out;
  }
  if (typeof node !== "object") return out;

  out.push(node);
  if (node["@graph"]) flattenJsonLdNode(node["@graph"], out);
  return out;
}

function getJobPostingFromJsonLd($) {
  const scripts = $("script[type='application/ld+json']")
    .map((_i, el) => $(el).html())
    .get();

  const nodes = [];
  for (const raw of scripts) {
    const parsed = safeJsonParse(raw);
    flattenJsonLdNode(parsed, nodes);
  }

  for (const node of nodes) {
    const type = node["@type"];
    if (Array.isArray(type) && type.includes("JobPosting")) return node;
    if (type === "JobPosting") return node;
  }

  return null;
}

function readJobPostingCity(jobPosting) {
  const locations = Array.isArray(jobPosting?.jobLocation)
    ? jobPosting.jobLocation
    : [jobPosting?.jobLocation];

  for (const loc of locations) {
    const city = firstNonEmpty(loc?.address?.addressLocality, loc?.addressLocality);
    if (city) return cleanText(city);
  }
  return null;
}

function inferCity($, fullText) {
  const locationLabel = $("*:contains('Location'), *:contains('Standort')").first().text();
  const combined = `${locationLabel} ${fullText}`;

  const cityMatch = combined.match(/\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s*,\s*([A-Z]{2}|[A-Z][a-z]+)\b/);
  if (cityMatch) {
    return cityMatch[1];
  }

  return null;
}

function inferCompany($, pageTitle) {
  const ogSiteName = $("meta[property='og:site_name']").attr("content");
  if (ogSiteName && ogSiteName !== "LinkedIn") return cleanText(ogSiteName);

  if (pageTitle) {
    const hiringMatch = pageTitle.match(/^([^|]+?)\s+hiring\s+/i);
    if (hiringMatch) return cleanText(hiringMatch[1]);

    const pipeParts = pageTitle.split("|");
    if (pipeParts.length > 1) {
      const beforePipe = pipeParts[0].trim();
      const parts = beforePipe.split(/\s+(?:at|in)\s+/i);
      if (parts.length > 0) return cleanText(parts[0]);
    }
  }

  return null;
}

const KNOWN_SKILLS = [
  "R",
  "AI",
  "LLM",
  "Python",
  "JavaScript",
  "TypeScript",
  "React",
  "Node.js",
  "Next.js",
  "Vue.js",
  "Angular",
  "SQL",
  "PostgreSQL",
  "MySQL",
  "MongoDB",
  "AWS",
  "Azure",
  "GCP",
  "Docker",
  "Kubernetes",
  "Git",
  "Linux",
  "Terraform",
  "CI/CD",
  "Bash",
  "Quarto",
  "Typst",
  "LLMs",
  "Prompt engineering",
  "Chaining",
  "Chaining techniques",
  "Analytical thinking",
  "Problem solving",
  "Structured outputs",
  "Tidyverse",
  "data.table",
  "httr2",
  "Shiny",
  "targets",
  "Jenkins",
  "Power BI",
  "Tableau",
  "Excel",
  "SAP",
  "Salesforce",
  "Figma",
  "Photoshop",
  "Illustrator",
  "Canva",
  "Django",
  "Flask",
  "FastAPI",
  "Java",
  "C#",
  "C++",
  "Go",
  "Ruby",
  "PHP",
  "HTML",
  "CSS",
  "Tailwind",
  "REST",
  "GraphQL",
  "Jira",
  "Confluence",
  "Slack",
  "Project management",
  "Change management",
  "Organizational change management",
  "Stakeholder management",
  "Consulting",
  "Facilitation",
  "Workshop facilitation",
  "Communication",
  "Teamwork",
  "Transformation",
  "Customer service",
];
const KNOWN_SKILLS_LOWER = new Set(KNOWN_SKILLS.map((skill) => skill.toLowerCase()));

const REQUIREMENT_LABELS = [
  "required skills",
  "skills",
  "requirements",
  "basic qualifications",
  "minimum qualifications",
  "required qualifications",
  "preferred qualifications",
  "must have",
  "what you bring",
  "what you'll bring",
  "what you will bring",
  "about you",
  "your background",
  "what we're looking for",
  "your profile",
  "qualifications",
  "experience",
  "anforderungen",
  "voraussetzungen",
  "dein profil",
  "ihr profil",
  "qualifikationen",
  "was du mitbringst",
  "was sie mitbringen",
];

const PREFERRED_LABELS = [
  "preferred skills",
  "nice to have",
  "bonus skills",
  "plus",
  "preferred qualifications",
  "wunschqualifikationen",
  "von vorteil",
  "nice-to-have",
];

const LANGUAGE_LABELS = [
  "required languages",
  "language requirements",
  "languages required",
  "language skills",
  "sprachkenntnisse",
  "sprachen",
  "fremdsprachen",
  "language",
];

const WAGE_LABELS = [
  "salary",
  "compensation",
  "pay range",
  "wage",
  "gehalt",
  "vergutung",
  "verguetung",
  "jahresgehalt",
  "stundenlohn",
  "brutto",
];

function getTextLines(text) {
  return cleanText(text)
    .split(/(?:\u2022|•|\*|-|\n|\r)+/)
    .map((line) => cleanText(line))
    .filter(Boolean);
}

function extractSectionTextFromHtml(html, labels) {
  if (!html) return null;

  const $ = cheerio.load(`<div id="root">${html}</div>`);
  const sections = [];
  $("#root").find("h1,h2,h3,h4,strong,b,p").each((_index, element) => {
    const heading = cleanText($(element).text()).toLowerCase();
    if (!heading) return;

    const matches = labels.some((label) => heading.includes(label));
    if (!matches) return;

    const collected = [];
    let sibling = $(element).next();
    while (sibling.length) {
      const tagName = sibling.get(0)?.tagName?.toLowerCase();
      if (["h1", "h2", "h3", "h4"].includes(tagName)) break;
      const text = cleanText(sibling.text());
      if (text) collected.push(text);
      sibling = sibling.next();
    }

    if (collected.length) {
      sections.push(collected.join(" "));
    }
  });

  return sections.length ? sections.join(" ") : null;
}

function extractListItemsFromHtml(html) {
  if (!html) return [];
  const $ = cheerio.load(`<div id="root">${html}</div>`);
  return $("#root li")
    .map((_index, item) => cleanText($(item).text()))
    .get()
    .filter(Boolean);
}

function hasSkillInText(text, skill) {
  const normalizedText = cleanText(text);
  const lowerText = normalizedText.toLowerCase();
  const lowerSkill = skill.toLowerCase();

  if (lowerSkill === "r") {
    if (/\b(?:knowledge of|experience with|proficient in|using|kenntnisse in|erfahrung mit)\s+r\b/i.test(normalizedText)) {
      return true;
    }
    if (/\br\s*(?:language|package|packages|script|studio|markdown)\b/i.test(normalizedText)) {
      return true;
    }
    if (/\b(tidyverse|data\.table|httr2|shiny|targets)\b/i.test(normalizedText)) {
      return true;
    }
    return false;
  }

  if (lowerSkill === "go") {
    // Avoid matching the verb "go"; only match the programming language context.
    if (/\bgolang\b/i.test(normalizedText)) return true;
    if (/\bgo\s*(?:language|developer|engineer|backend|api|service|microservice|codebase|programming)\b/i.test(normalizedText)) {
      return true;
    }
    // Match Go only if the token "go" itself appears in a language list.
    if (/(?:\bgo\b\s*[,/]|[,/]\s*\bgo\b)/i.test(normalizedText)) {
      return true;
    }
    return false;
  }

  if (lowerSkill === "ai") {
    return /\bai\b|artificial intelligence/i.test(normalizedText);
  }

  if (lowerSkill === "llm" || lowerSkill === "llms") {
    return /\bllms?\b|large language model/i.test(normalizedText);
  }

  const escaped = skill
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\./g, "(?:\\.|\\s)?");

  return new RegExp(`\\b${escaped}\\b`, "i").test(lowerText);
}

function skillMatches(line) {
  const matches = KNOWN_SKILLS.filter((skill) => {
    if (skill.length === 1) {
      return hasSkillInText(line, skill);
    }

    const escaped = skill
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\\\./g, "(?:\\.|\\s)?");
    return new RegExp(`\\b${escaped}\\b`, "i").test(line);
  });
  return [...new Set(matches)];
}

function extractSkillsFromSources(text, html, labels) {
  const candidates = [];
  const sectionFromHtml = extractSectionTextFromHtml(html, labels);
  const sectionFromText = findSnippetByLabels(text, labels);
  if (sectionFromHtml) candidates.push(sectionFromHtml);
  if (sectionFromText) candidates.push(sectionFromText);
  candidates.push(text);

  const found = [];
  for (const candidate of candidates) {
    for (const line of getTextLines(candidate)) {
      if (line.length > 520) continue;
      found.push(...skillMatches(line));
    }
  }

  const unique = [...new Set(found)];
  return unique.length ? unique.join(", ") : null;
}

function extractLanguageLines(text, html) {
  const lines = [];
  const sectionFromHtml = extractSectionTextFromHtml(html, LANGUAGE_LABELS);
  const listItems = extractListItemsFromHtml(html);
  if (sectionFromHtml) lines.push(...getTextLines(sectionFromHtml));
  lines.push(...listItems.filter((line) => /(english|englisch|german|deutsch|french|franz|spanish|spanisch|italian|italienisch|dutch|niederl|portuguese|portugiesisch|c1|c2|b1|b2|a1|a2|fluent|native|grundkenntnisse|verhandlungssicher)/i.test(line)));
  lines.push(...text
    .split(/[.!?;]\s+/)
    .map((line) => cleanText(line))
    .filter((line) => /(english|englisch|german|deutsch|french|franz|spanish|spanisch|italian|italienisch|dutch|niederl|portuguese|portugiesisch)/i.test(line)));
  return [...new Set(lines.filter(Boolean))];
}

function findSnippetByLabels(text, labels) {
  for (const label of labels) {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`${escapedLabel}\\s*[:\\-]?\\s*([^\\n\\r.;|]{5,220})`, "i");
    const match = text.match(regex);
    if (match && match[1]) {
      return cleanText(match[1]);
    }
  }
  return null;
}

function extractSkillsFromText(text, labels) {
  const snippet = findSnippetByLabels(text, labels);
  if (snippet) return snippet;

  const found = KNOWN_SKILLS.filter((skill) => hasSkillInText(text, skill));
  const unique = [...new Set(found)];

  return unique.length ? unique.join(", ") : null;
}

function extractKnownSkillsFromCorpus(text) {
  const source = cleanText(text);
  if (!source) return null;

  const matches = KNOWN_SKILLS.filter((skill) => hasSkillInText(source, skill));
  const unique = [...new Set(matches)];
  return unique.length ? unique.join(", ") : null;
}

function extractProfileSkillLines(text) {
  return cleanText(text)
    .split(/[.!?;]\s+/)
    .map((line) => cleanText(line))
    .filter(Boolean)
    .filter((line) => /\b(knowledge of|experience with|tools like|packages such as|understanding of|bring|you have|good knowledge|basic understanding|kenntnisse|erfahrung mit|tools wie|grundverstandnis|grundverständnis|sehr gute kenntnisse)\b/i.test(line));
}

function extractExplicitSkillsFromProfile(text) {
  const lines = extractProfileSkillLines(text);
  const found = [];

  for (const line of lines) {
    found.push(...KNOWN_SKILLS.filter((skill) => hasSkillInText(line, skill)));

    if (/\banalytical thinking\b/i.test(line)) found.push("Analytical thinking");
    if (/\bproblem[\s-]?solving\b/i.test(line)) found.push("Problem solving");
    if (/\bprompt engineering\b/i.test(line)) found.push("Prompt engineering");
    if (/\bstructured outputs\b/i.test(line)) found.push("Structured outputs");
    if (/\bchaining techniques?\b/i.test(line)) found.push("Chaining techniques");
  }

  const unique = [...new Set(found.map((skill) => cleanText(skill)).filter(Boolean))];
  return unique.length ? unique.join(", ") : null;
}

function normalizeExplicitSkillToken(token) {
  const cleaned = cleanText(token)
    .replace(/^(and|or|und|oder)\s+/i, "")
    .replace(/^for example\s+/i, "")
    .replace(/^such as\s+/i, "")
    .replace(/^like\s+/i, "")
    .replace(/\s+(is|are|was|were|kenntnisse|required|required\.?|preferred|plus|essential|helpful|advantage|nice to have|von vorteil).*$/i, "")
    .replace(/[().:]+$/g, "")
    .trim();

  if (!cleaned) return null;

  const aliases = new Map([
    ["git", "Git"],
    ["sql", "SQL"],
    ["python", "Python"],
    ["bash", "Bash"],
    ["quarto", "Quarto"],
    ["typst", "Typst"],
    ["r", "R"],
    ["tidyverse", "Tidyverse"],
    ["data.table", "data.table"],
    ["httr2", "httr2"],
    ["shiny", "Shiny"],
    ["targets", "targets"],
    ["llm", "LLM"],
    ["llms", "LLMs"],
    ["prompt engineering", "Prompt engineering"],
    ["structured outputs", "Structured outputs"],
    ["chaining techniques", "Chaining techniques"],
    ["ai", "AI"],
  ]);

  const lower = cleaned.toLowerCase();
  if (aliases.has(lower)) {
    return aliases.get(lower);
  }

  const dictionaryMatch = KNOWN_SKILLS.find((skill) => skill.toLowerCase() === lower);
  if (dictionaryMatch) {
    return dictionaryMatch;
  }

  return null;
}

function extractSkillListsFromPhrases(text) {
  const source = cleanText(text);
  if (!source) return null;

  const patterns = [
    /(?:packages\s+such\s+as|tools\s+like|experience\s+with|knowledge\s+of|basic\s+understanding\s+of|for example)\s+([^.!?\n]{3,320})/gi,
    /(?:pakete\s+wie|tools\s+wie|erfahrung\s+mit|kenntnisse\s+in|grundverstandnis\s+von|grundverständnis\s+von)\s+([^.!?\n]{3,320})/gi,
  ];

  const extracted = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const rawList = cleanText(match[1]);
      if (!rawList) continue;

      const tokens = rawList
        .split(/,|;|\/|\||\bor\b|\band\b|\boder\b|\bund\b/i)
        .map((token) => normalizeExplicitSkillToken(token))
        .filter(Boolean);

      extracted.push(...tokens);
    }
  }

  const unique = [...new Set(extracted)];
  return unique.length ? unique.join(", ") : null;
}

function mergeSkillValues(...values) {
  const parts = [];

  for (const value of values) {
    if (!value) continue;
    const items = String(value)
      .split(",")
      .map((item) => cleanText(item))
      .filter(Boolean);
    parts.push(...items);
  }

  const unique = [...new Set(parts)];
  return unique.length ? unique.join(", ") : null;
}

function inferYearsExperience(text) {
  const direct = findSnippetByLabels(text, [
    "years of experience",
    "experience required",
    "minimum experience",
    "berufserfahrung",
    "jahre erfahrung",
  ]);
  if (direct) return direct;

  const rangeMatch = text.match(/(\d+\+?\s*(?:-|to)\s*\d+\+?\s*(?:years?|yrs?)\s+(?:of\s+)?experience)/i);
  if (rangeMatch) return cleanText(rangeMatch[1]);

  const rangeMatchDe = text.match(/(\d+\+?\s*(?:-|bis)\s*\d+\+?\s*jahre\s+berufserfahrung)/i);
  if (rangeMatchDe) return cleanText(rangeMatchDe[1]).replace(/jahre berufserfahrung/i, "years of experience");

  const singleMatch = text.match(/(\d+\+?\s*(?:years?|yrs?)\s+(?:of\s+)?experience)/i);
  if (singleMatch) return cleanText(singleMatch[1]);

  const singleMatchDe = text.match(/(\d+\+?\s*jahre\s+berufserfahrung)/i);
  if (singleMatchDe) return cleanText(singleMatchDe[1]).replace(/jahre berufserfahrung/i, "years of experience");

  return null;
}

function inferEducationRequirements(text) {
  // 1. Try English section headers first (snippet after the label is likely full enough)
  const direct = findSnippetByLabels(text, [
    "education requirements",
    "education",
    "degree required",
    "qualifications",
  ]);
  if (direct) return direct;

  // 2. Sentence-based extraction: find sentences that explicitly mention a degree/qualification
  const sentences = text
    .split(/[.!?;]\s+/)
    .map((sentence) => cleanText(sentence))
    .filter(Boolean)
    .filter((sentence) =>
      /(bachelor|master|ph\.?d|degree|studium|ausbildung|abschluss)/i.test(sentence) &&
      (/(required|requirement|erforderlich|must|minimum|qualif)/i.test(sentence) ||
       /\b(abgeschlossenes|abgeschlossener|abgeschlossene)\b/i.test(sentence))
    );
  if (sentences.length) return sentences[0];

  // 3. Fallback: German section label snippets (studium/abschluss label captures text after keyword)
  return findSnippetByLabels(text, ["ausbildung", "studium", "abschluss"]);
}

function extractRelevantSentence(text, includePattern, excludePattern) {
  const sentences = cleanText(text)
    .split(/[.!?;]\s+/)
    .map((sentence) => cleanText(sentence))
    .filter(Boolean)
    .filter((sentence) => sentence.length >= 8 && sentence.length <= 180)
    .filter((sentence) => includePattern.test(sentence))
    .filter((sentence) => !excludePattern || !excludePattern.test(sentence));

  return sentences.length ? sentences[0] : null;
}

function inferEmploymentTypeFromRole(title, text) {
  const source = `${cleanText(title)} ${cleanText(text)}`.toLowerCase();
  if (!source) return null;

  // Full-time is default for most professional roles
  if (/\b(senior|junior|manager|engineer|developer|analyst|specialist|officer|consultant|technician|administrator)\b/.test(source)) {
    return "Full-time";
  }
  
  // Part-time indicators
  if (/\b(part[- ]?time|hourly|hourly rate|hourly wage)\b/.test(source)) {
    return "Part-time";
  }

  return null;
}

function inferWageFromRole(title, text) {
  const source = `${cleanText(title)} ${cleanText(text)}`.toLowerCase();
  if (!source) return null;

  // Some roles may have typical salary ranges
  if (/\b(senior|lead|principal|staff|head)\b/.test(source)) {
    return "Typically €50k - €80k per year";
  }
  if (/\b(junior|entry|graduate|internship|trainee)\b/.test(source)) {
    return "Typically €25k - €35k per year";
  }

  return null;
}

function inferEducationFromRole(title, text, employmentType) {
  const source = `${cleanText(title)} ${cleanText(text)} ${cleanText(employmentType)}`.toLowerCase();
  if (!source) return null;

  if (/\b(werkstudent|working student|student job|student assistant)\b/.test(source)) {
    return "Currently enrolled in a Bachelor's or Master's degree program";
  }

  if (/\b(internship|intern|praktikum|trainee)\b/.test(source)) {
    return "Currently enrolled in or recently completed a Bachelor's or Master's degree program";
  }

  // Technical roles typically require some formal education
  if (/\b(engineer|developer|architect|analyst|technician|programmer)\b/.test(source)) {
    return "Bachelor's degree or equivalent professional experience in a related field";
  }

  return null;
}

function inferEmploymentType(text) {
  const direct = findSnippetByLabels(text, [
    "employment type",
    "job type",
    "contract type",
    "work type",
    "anstellungsart",
    "beschaftigungsart",
    "vertragsart",
    "arbeitszeit",
  ]);

  const fromDirect = normalizeEmploymentType(direct);
  if (fromDirect) return fromDirect;

  return normalizeEmploymentType(text);
}

function toEnglishLanguageName(raw) {
  const trimmed = cleanText(raw);
  const lower = trimmed.toLowerCase();
  if (/^(en|en-us|en-gb)$/.test(lower)) return "English";
  if (/^(de|de-de)$/.test(lower)) return "German";
  if (/^(fr|fr-fr)$/.test(lower)) return "French";
  if (/^(es|es-es)$/.test(lower)) return "Spanish";
  if (/^(it|it-it)$/.test(lower)) return "Italian";
  if (/^(nl|nl-nl)$/.test(lower)) return "Dutch";
  if (/^(pt|pt-pt|pt-br)$/.test(lower)) return "Portuguese";

  if (/englisch|english/.test(lower)) return "English";
  if (/deutsch|german/.test(lower)) return "German";
  if (/franzosisch|french/.test(lower)) return "French";
  if (/spanisch|spanish/.test(lower)) return "Spanish";
  if (/italienisch|italian/.test(lower)) return "Italian";
  if (/niederlandisch|dutch/.test(lower)) return "Dutch";
  if (/portugiesisch|portuguese/.test(lower)) return "Portuguese";
  return cleanText(raw);
}

function toEnglishLanguageLevel(raw) {
  const lower = (raw || "").toLowerCase();
  const cefr = lower.match(/\b(a1|a2|b1|b2|c1|c2)\b/i);
  if (cefr) return cefr[1].toUpperCase();

  if (/muttersprach|native/.test(lower)) return "Native";
  if (/verhandlungssicher|professional working proficiency/.test(lower)) return "Professional working proficiency";
  if (/fliessend|fluent/.test(lower)) return "Fluent";
  if (/fortgeschritten|advanced/.test(lower)) return "Advanced";
  if (/intermediate|mittelstufe/.test(lower)) return "Intermediate";
  if (/basic|grundkenntnisse|basic knowledge/.test(lower)) return "Basic";

  return null;
}

function inferLanguageRequirements(text) {
  return inferLanguageRequirementsFromHtml(text, null);
}

function inferLanguageRequirementsFromHtml(text, html) {
  const direct = findSnippetByLabels(text, [
    ...LANGUAGE_LABELS,
  ]);

  const sources = [];
  if (direct) sources.push(direct);
  sources.push(...extractLanguageLines(text, html));
  const source = sources.join(" ");
  if (!source.trim()) return null;
  const languageRegexes = [
    /\b(english|englisch)\b[^.,;|\n]{0,45}/gi,
    /\b(german|deutsch)\b[^.,;|\n]{0,45}/gi,
    /\b(french|franzosisch)\b[^.,;|\n]{0,45}/gi,
    /\b(spanish|spanisch)\b[^.,;|\n]{0,45}/gi,
    /\b(italian|italienisch)\b[^.,;|\n]{0,45}/gi,
    /\b(dutch|niederlandisch)\b[^.,;|\n]{0,45}/gi,
    /\b(portuguese|portugiesisch)\b[^.,;|\n]{0,45}/gi,
  ];

  const results = [];
  for (const regex of languageRegexes) {
    const matches = source.match(regex) || [];
    for (const match of matches) {
      const name = toEnglishLanguageName(match);
      const level = toEnglishLanguageLevel(match);
      results.push(level ? `${name} (${level})` : name);
    }
  }

  const unique = [...new Set(results.map((value) => cleanText(value)))];
  return unique.length ? unique.join(", ") : null;
}

function inferLanguageFromDocumentLanguage(text) {
  const normalized = cleanText(text).toLowerCase();
  if (!normalized) return null;

  const germanKeywords = (normalized.match(/\b(und|oder|mit|fur|für|der|die|das|nicht|sind|eine|einen|deutsch|kenntnisse|anforderungen|aufgaben|berufserfahrung|standort|arbeitgeber)\b/g) || []).length;
  const englishKeywords = (normalized.match(/\b(and|with|for|the|you|your|required|requirements|experience|skills|location|benefits|responsibilities|company|position)\b/g) || []).length;
  const hasUmlaut = /[äöüß]/i.test(normalized);

  if (germanKeywords >= 4 && germanKeywords >= englishKeywords) {
    return "German (Professional working proficiency)";
  }
  if (hasUmlaut && germanKeywords >= 2) {
    return "German (Professional working proficiency)";
  }
  if (englishKeywords >= 4 && englishKeywords > germanKeywords) {
    return "English (Professional working proficiency)";
  }

  return null;
}

function inferYearsExperienceFromSeniority(text, title) {
  const source = `${cleanText(title)} ${cleanText(text)}`.toLowerCase();
  if (!source) return null;

  if (/\b(senior|lead|principal|staff|head of|leiter|teamlead)\b/.test(source)) {
    return "5+ years of experience";
  }
  if (/\b(mid|intermediate|experienced|professional)\b/.test(source)) {
    return "3+ years of experience";
  }
  if (/\b(junior|entry[ -]?level|associate|graduate|trainee|internship|intern|werkstudent)\b/.test(source)) {
    return "0-2 years of experience";
  }

  return null;
}

function isWorkingStudentRole(title, text, employmentType) {
  const source = `${cleanText(title)} ${cleanText(text)} ${cleanText(employmentType)}`.toLowerCase();
  return /\b(werkstudent|working student|student assistant|student job|working[- ]student)\b/.test(source);
}

function inferRoleBasedSkills(title, text) {
  const source = `${cleanText(title)} ${cleanText(text)}`.toLowerCase();
  if (!source) return null;

  const byRole = [
    { pattern: /\b(front[ -]?end|frontend|ui|react|angular|vue)\b/, skills: ["JavaScript", "TypeScript", "React", "HTML", "CSS"] },
    { pattern: /\b(back[ -]?end|backend|api|node|server)\b/, skills: ["Node.js", "JavaScript", "SQL", "REST", "Git"] },
    { pattern: /\b(full[ -]?stack)\b/, skills: ["JavaScript", "TypeScript", "React", "Node.js", "SQL"] },
    { pattern: /\b(data|analytics|bi|business intelligence)\b/, skills: ["SQL", "Python", "Power BI", "Excel", "Tableau"] },
    { pattern: /\b(devops|platform|sre|cloud)\b/, skills: ["Docker", "Kubernetes", "AWS", "Linux", "CI/CD"] },
  ];

  for (const role of byRole) {
    if (role.pattern.test(source)) {
      return role.skills.join(", ");
    }
  }

  return null;
}

function inferSoftSkills(text) {
  const source = cleanText(text).toLowerCase();
  if (!source) return [];

  const signals = [
    { regex: /\b(kundenservice|customer service|serviceorientiert|service oriented)\b/, label: "Customer service" },
    { regex: /\b(verkauf|sales|vertrieb)\b/, label: "Sales" },
    { regex: /\b(kommunikation|communication)\b/, label: "Communication" },
    { regex: /\b(teamfahig|teamfähig|teamwork|team player)\b/, label: "Teamwork" },
    { regex: /\b(flexibel|flexibility|schichtbereit|shift work|schichtdienst)\b/, label: "Flexibility" },
    { regex: /\b(zuverlassig|zuverlässig|reliable|reliability)\b/, label: "Reliability" },
    { regex: /\b(fuhrerschein|führerschein|driver'?s license|driving license)\b/, label: "Driving license" },
    { regex: /\b(ms office|excel|word|powerpoint)\b/, label: "MS Office" },
    { regex: /\b(organisation|organizational|organisational)\b/, label: "Organization" },
  ];

  return signals.filter((signal) => signal.regex.test(source)).map((signal) => signal.label);
}

function inferRequiredSkillsFallback(title, text) {
  const combined = `${cleanText(title)} ${cleanText(text)}`;
  const roleBased = inferRoleBasedSkills(title, text);
  const soft = inferSoftSkills(combined);
  const highSignalSoft = new Set(["Customer service", "Sales", "Driving license", "MS Office"]);

  const merged = [];
  if (roleBased) {
    merged.push(...roleBased.split(",").map((skill) => cleanText(skill)).filter(Boolean));
  }

  // Keep fallback stable: only include high-signal soft skills.
  // Exclude generic soft labels like Flexibility/Teamwork/Communication from required_skills.
  merged.push(...soft.filter((label) => highSignalSoft.has(label)));

  const unique = [...new Set(merged)];
  return unique.length ? unique.join(", ") : null;
}

function extractExperienceFromCorpus(text) {
  const patterns = [
    /(\d+\+?\s*(?:-|to|bis)\s*\d+\+?\s*(?:years?|yrs?|jahre)\s+(?:of\s+)?(?:experience|erfahrung|experience\s+required|required|within|im))/gi,
    /(\d+\+?\s*(?:years?|yrs?|jahre)\s+(?:of\s+)?(?:experience|berufserfahrung|experience\s+required|professional|im bereich))/gi,
    /(?:minimum\s+)?(\d+\s*(?:years?|yrs?|jahre))\s+(?:of\s+)?(?:professional\s+)?(?:experience|erfahrung)/gi,
  ];

  const matches = [];
  for (const pattern of patterns) {
    const found = text.match(pattern);
    if (found) matches.push(...found);
  }

  if (matches.length) {
    return cleanText(matches[0]);
  }
  return null;
}

function extractEducationFromCorpus(text) {
  const patterns = [
    /(?:education|qualification|degree|requirement|required education)[:=]?\s*([^.!?\n]{15,180}?(?:bachelor|master|degree|studium|ausbildung|abschluss|hbo|university|universiteit|hogeschool))/gi,
    /(?:bachelor|master|degree|phd|hbo|mbo|vwo|universiteit|hogeschool|university|studium|ausbildung|abschluss)\b[^.!?\n]{0,150}(?:required|erforderlich|vereist|essential|desired|voorkeur|preferable|preferred)/gi,
    /(?:minimum qualification|formal education|educational requirement)[:=]?\s*([^.\n]{10,150})/gi,
    /(?:you (have|need|must have|should have|possess))[:=]?\s*(?:.*?)(?:bachelor|master|degree|diploma|qualification|certification)/gi,
  ];

  const matches = [];
  for (const pattern of patterns) {
    const found = text.matchAll(pattern);
    for (const match of found) {
      const candidate = cleanText((match[0] || match[1] || "").trim());
      if (candidate.length > 12) {
        matches.push(candidate);
      }
    }
  }

  // Try to find education-related sentences
  if (!matches.length) {
    const sentences = text.split(/[.!?;]\s+/);
    for (const sentence of sentences) {
      if (/(bachelor|master|degree|qualification|educated in|studied|studium|ausbildung)/.test(sentence) && 
          /(required|necessary|need|must|should|vereist|erforderlich)/.test(sentence)) {
        const cleaned = cleanText(sentence);
        if (cleaned.length > 15 && cleaned.length < 200) {
          matches.push(cleaned);
        }
      }
    }
  }

  return matches.length ? matches[0] : null;
}

function extractWageFromCorpus(text) {
  const patterns = [
    /(?:salary|wage|compensation|CTC|annual salary|bruto|netto|monthly salary|yearly salary|yearly compensation|monthly compensation)[:=]?\s*(?:€|EUR|\$|USD)?[\s*]*(([\d.,]+(?:\s*,?\s*[\d.,]+)?(?:\s*[kK])?)\s*(?:per|p\.a\.|annually|yearly|monthly|per month|per year|-\s*€?\s*[\d.,]+)?)/gi,
    /(€|EUR|\$|USD)\s*([\d.,]+(?:\s*,-?\s*[\d.,]+)?(?:\s*[kK])?)\s*(?:-|to|–|tot|–)\s*(?:€|EUR|\$|USD)?\s*([\d.,]+[kK]?)/gi,
    /\b(([\d.,]+\s*(?:per hour|per uur|hourly|uur|hour|p\.h\.|€)))\b/gi,
    /(?:estimated|monthly|annual|yearly)\s+(?:salary|wage)[:=]?\s*(?:around|approximately|about|approx)?\s*(?:€|EUR)?\s*([\d.,]+[kK]?)/gi,
    /(?:we (offer|provide|will offer)|contractual compensation)[:=]?\s*([€$£]\s*[\d.,]+[kK]?[^.\n]{0,80})/gi,
  ];

  const matches = [];
  for (const pattern of patterns) {
    const found = text.matchAll(pattern);
    for (const match of found) {
      const raw = match[0] || match[1] || match[2] || "";
      const candidate = cleanText(raw);
      if (candidate.length > 3 && candidate.length < 200 && /[\d€\$£k]/.test(candidate)) {
        matches.push(candidate);
      }
    }
  }

  if (matches.length) {
    // Prefer matches that contain currency symbols or "per" units
    const withCurrency = matches.find(m => /[€\$£]/.test(m));
    if (withCurrency) return withCurrency;
    return matches[0];
  }
  return null;
}

function extractEmploymentTypeFromCorpus(text) {
  const patterns = [
    /(?:employment type|job type|type of contract|position type|contract type|soort contract|arbeitsverh|vertragsart|employment model)[:=]?\s*([^,.\n]{4,80})/gi,
    /(?:we (offer|provide|are hiring for)|position offered|hiring)[:=]?\s*(?:a\s+)?(full[- ]?time|part[- ]?time|permanent|temporary|fixed[- ]?term|freelance|contractor|consultant|contract position|fulltime|parttime)/gi,
    /\b(full[- ]?time|fulltime|part[- ]?time|parttime|freelance|contract|permanent|temporary|fixed[- ]?term|fixed-term|befristet|unbefristet|duurovereenkomst|tijdelijk|vast contract|freelancer|uitzendkracht|consultancy)\b/gi,
    /(?:this is a)\s+([^.\n]{0,80}(?:full|part|permanent|temporary|freelance|contract))/gi,
  ];

  const matches = [];
  for (const pattern of patterns) {
    const found = text.matchAll(pattern);
    for (const match of found) {
      const candidate = cleanText((match[0] || match[1] || "").trim());
      if (candidate.length > 2 && candidate.length < 150) {
        matches.push(candidate);
      }
    }
  }

  if (matches.length) {
    // Prefer standard single-term employment types
    const standardTypes = ["full-time", "part-time", "permanent", "temporary", "contract", "freelance", "fixed-term", "fulltime", "parttime"];
    const standard = matches.find((m) => standardTypes.some((st) => m.toLowerCase().includes(st)));
    if (standard) return cleanText(standard);
    
    // Otherwise return the shortest match (likely cleanest)
    return matches.sort((a, b) => a.length - b.length)[0];
  }
  return null;
}

function mergeLanguages(...values) {
  const parts = [];

  for (const value of values) {
    if (!value) continue;
    const items = String(value)
      .split(",")
      .map((item) => cleanText(item))
      .filter(Boolean);
    parts.push(...items);
  }

  const unique = [...new Set(parts)];
  return unique.length ? unique.join(", ") : null;
}

function formatSalaryNumber(value) {
  if (value == null) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(num);
}

function inferWageFromJsonLd(jobPosting) {
  if (!jobPosting?.baseSalary) return null;

  const base = jobPosting.baseSalary;
  const currency = cleanText(base?.currency || base?.value?.currency || "");
  const unitText = cleanText(base?.unitText || base?.value?.unitText || "").toLowerCase();
  const min = formatSalaryNumber(base?.value?.minValue ?? base?.minValue);
  const max = formatSalaryNumber(base?.value?.maxValue ?? base?.maxValue);
  const exact = formatSalaryNumber(base?.value?.value ?? base?.value);

  const unit = /hour/i.test(unitText)
    ? "per hour"
    : /month/i.test(unitText)
      ? "per month"
      : "per year";

  if (min && max) return `${currency || ""} ${min} - ${max} ${unit}`.trim();
  if (exact) return `${currency || ""} ${exact} ${unit}`.trim();

  const raw = cleanText(typeof base === "string" ? base : JSON.stringify(base));
  return raw || null;
}

function normalizeGermanWage(wageText) {
  if (!wageText) return wageText;
  let normalized = cleanText(wageText);

  // Extract just the wage part: number + currency + optional brutto/netto + time period
  // Match patterns like: "15.00 EUR brutto pro Stunde", "2500 € netto pro Monat", etc.
  const wageMatch = normalized.match(/[€$£]?\s*[\d.,]+\s*(?:EUR|€|\$|£)?\s*(?:brutto|netto)?\s*(?:pro|per|\/)\s*(stunde|monat|jahr|hour|month|year|uur|maand|dag|stunde|woche|week)/i);
  if (wageMatch) {
    normalized = wageMatch[0];
  }

  // Remove brutto/netto qualifiers
  normalized = normalized.replace(/\s+(brutto|netto)\s*/gi, " ");

  // Convert slash format to "per" format: "17,50 Euro / Stunde" -> "17,50 Euro per Stunde"
  normalized = normalized.replace(/\s*\/\s*/g, " per ");

  // Convert German time periods to English
  normalized = normalized.replace(/\b(pro|per)\s+stunde\b/gi, "per hour");
  normalized = normalized.replace(/\b(pro|per)\s+monat\b/gi, "per month");
  normalized = normalized.replace(/\b(pro|per)\s+jahr\b/gi, "per year");
  normalized = normalized.replace(/\b(pro|per)\s+uur\b/gi, "per hour");
  normalized = normalized.replace(/\b(pro|per)\s+maand\b/gi, "per month");
  normalized = normalized.replace(/\b(pro|per)\s+dag\b/gi, "per day");
  normalized = normalized.replace(/\b(pro|per)\s+woche\b/gi, "per week");

  // Normalize decimal: replace comma with period for EUR amounts
  normalized = normalized.replace(/(\d),(\d{2})\b/g, "$1.$2");

  // Ensure EUR is formatted cleanly: "15.00 EUR per hour" format
  normalized = normalized.replace(/([€$£])\s*(eur|usd|gbp)?/gi, (match, currency) => {
    return currency === "€" || currency === "€" ? "EUR " : currency;
  });

  // Convert "Euro" to "EUR"
  normalized = normalized.replace(/\bEuro\b/gi, "EUR");

  // Clean up extra spaces and standardize format
  normalized = normalized
    .replace(/\s+/g, " ")
    .replace(/\s*(€|\$|£)\s*/g, " EUR ")
    .replace(/EUR\s+EUR/g, "EUR")
    .trim();

  return normalized;
}

function inferWageFromText(text) {
  const cleaned = cleanText(text);
  if (!cleaned) return null;

  // German format with slash: "17,50 Euro / Stunde"
  const germanSlashFormat = cleaned.match(/\d[\d.,]*\s*(?:EUR|Euro|€)\s*\/\s*(?:Stunde|Monat|Jahr|Woche|stunde|monat|jahr|woche|hour|month|year|week|heure|mois|an)/i);
  if (germanSlashFormat) return normalizeGermanWage(cleanText(germanSlashFormat[0]));

  // Higher priority: German wage formats with clear boundaries
  const germanHourly = cleaned.match(/\d[\d.,]*\s*(?:EUR|€)\s*(?:brutto|netto)?\s*(?:pro|per)\s*stunde\b/i);
  if (germanHourly) return normalizeGermanWage(cleanText(germanHourly[0]));

  const germanMonthly = cleaned.match(/\d[\d.,]*\s*(?:EUR|€)\s*(?:brutto|netto)?\s*(?:pro|per)\s*monat\b/i);
  if (germanMonthly) return normalizeGermanWage(cleanText(germanMonthly[0]));

  const germanYearly = cleaned.match(/\d[\d.,]*\s*(?:EUR|€)\s*(?:brutto|netto)?\s*(?:pro|per)\s*jahr\b/i);
  if (germanYearly) return normalizeGermanWage(cleanText(germanYearly[0]));

  // Range pattern (e.g., "€50,000 - 70,000 per year")
  const rangePattern = /(€|\$|£)\s?\d[\d.,]*(?:\s?[kK])?\s*(?:-|to|–|—)\s*(?:€|\$|£)?\s?\d[\d.,]*(?:\s?[kK])?/;
  const directRange = cleaned.match(rangePattern);
  if (directRange) return normalizeGermanWage(cleanText(directRange[0]));

  // Hourly with explicit unit
  const hoursPattern = /\d[\d.,]*\s*(?:EUR|€|\$|£)\s*(?:pro|per)\s*(?:stunde|hour|uur|h\.?|\/h)\b/i;
  const hoursMatch = cleaned.match(hoursPattern);
  if (hoursMatch) return normalizeGermanWage(cleanText(hoursMatch[0]));

  // Monthly/yearly patterns
  const monthlyPattern = /\d[\d.,]*\s*(?:EUR|€|\$|£)(?:\s*(?:brutto|netto))?\s*(?:pro|per)\s*(?:monat|month|maand)\b/i;
  const monthlyMatch = cleaned.match(monthlyPattern);
  if (monthlyMatch) return normalizeGermanWage(cleanText(monthlyMatch[0]));

  const yearlyPattern = /\d[\d.,]*\s*(?:EUR|€|\$|£)(?:\s*[kK])?(?:\s*(?:brutto|netto))?\s*(?:pro|per)?\s*(?:jahr|year|annually|yearly|p\.a\.)/i;
  const yearlyMatch = cleaned.match(yearlyPattern);
  if (yearlyMatch) return normalizeGermanWage(cleanText(yearlyMatch[0]));

  // Fallback: labeled wage sections
  const labeled = findSnippetByLabels(cleaned, WAGE_LABELS);
  if (labeled) return normalizeGermanWage(labeled);

  return null;
}

function sanitizeWage(value) {
  if (!value) return null;
  const cleaned = normalizeGermanWage(cleanText(value));
  if (cleaned.length < 2 || cleaned.length > 150) return null;

  const hasNumber = /\d/.test(cleaned);
  const hasCurrency = /(€|\$|£|\b(?:eur|usd|gbp)\b)/i.test(cleaned);
  const hasPayContext =
    /(salary|wage|compensation|gehalt|vergutung|verguetung|brutto|netto|annual|yearly|monthly|hourly|per year|per month|per hour|pro jahr|pro monat|pro stunde|p\.a\.)/i.test(
      cleaned
    );

  if (hasNumber && (hasCurrency || hasPayContext)) {
    return cleaned;
  }

  return null;
}

function sanitizeSkills(value) {
  if (!value) return null;
  const cleaned = cleanText(value);
  const parts = cleaned
    .split(",")
    .map((part) => cleanText(part)
      .replace(/^&\s*/, "")
      .replace(/^(and|und|oder|or)\s+/i, "")
      .replace(/^(experience\s+with|knowledge\s+of|proficient\s+in|familiar\s+with|tools\s+like|packages\s+such\s+as|kenntnisse\s+in|erfahrung\s+mit|tools\s+wie)\s+/i, "")
      .replace(/^(with|mit)\s+/i, "")
      .replace(/[)\]]+/g, "")
      .replace(/[;:.]+$/g, "")
      .replace(/\s+[A-Z]$/g, "")
      .trim())
    .filter(Boolean);

  const valid = parts.filter((part) => {
    const lower = part.toLowerCase();
    // Prevent education text leaking into skills.
    if (/(bachelor|master|ph\.?d|doctorate|degree|university|education|qualification|studium|ausbildung|abschluss)/i.test(part)) {
      return false;
    }
    if (KNOWN_SKILLS_LOWER.has(lower)) return true;
    return /\b(python|javascript|typescript|react|node|sql|java|c\+\+|c#|go|aws|azure|docker|kubernetes|git|html|css|graphql|rest)\b/i.test(part);
  });

  const nonGenericAi = valid.filter((part) => !/^(ai|llm|llms)$/i.test(part));

  const generic = parts.filter((part) => {
    if (part.length < 2 || part.length > 42) return false;
    if (/\d{3,}/.test(part)) return false;
    if (/^[a-z]$/i.test(part)) return false;
    if (/(bachelor|master|ph\.?d|doctorate|degree|university|education|qualification|studium|ausbildung|abschluss)/i.test(part)) return false;
    if (/^(ai|llm|llms)$/i.test(part)) return false;
    if (/(benefit|salary|gehalt|eur|€|m\/w\/d|full[- ]?time|part[- ]?time|responsibilit|aufgaben|about the role)/i.test(part)) return false;
    if (/(kenntnisse\s+mitbringen|was\s+du\s+mitbringst|was\s+sie\s+mitbringen|dein\s+profil|ihr\s+profil|requirements?|qualifications?|must\s+have|nice\s+to\s+have|what\s+you\s+bring|your\s+profile|anforderungen|voraussetzungen|qualifikationen)/i.test(part)) return false;
    if (/^(kenntnisse|mitbringen|profil|requirements?|qualifications?)$/i.test(part)) return false;
    const words = part.split(/\s+/).filter(Boolean);
    return words.length <= 5;
  });

  if (nonGenericAi.length) {
    const merged = [...new Set([...nonGenericAi, ...generic])];
    return merged.join(", ");
  }

  // Avoid writing generic placeholder skills like only "AI".
  if (valid.length) return null;

  // Fallback for non-technical roles: keep short, clean skill phrases.
  if (!generic.length) return null;
  return [...new Set(generic)].join(", ");
}

function sanitizeAiSkills(value) {
  if (!value) return null;

  const cleaned = cleanText(value);
  if (!cleaned) return null;

  const parts = cleaned
    .split(",")
    .map((part) => cleanText(part)
      .replace(/^&\s*/, "")
      .replace(/^(and|und|oder|or)\s+/i, "")
      .replace(/^(experience\s+with|knowledge\s+of|proficient\s+in|familiar\s+with|tools\s+like|packages\s+such\s+as|kenntnisse\s+in|erfahrung\s+mit|tools\s+wie)\s+/i, "")
      .replace(/^(with|mit)\s+/i, "")
      .replace(/[)\]]+/g, "")
      .replace(/[;:.]+$/g, "")
      .trim())
    .filter(Boolean);

  const allowed = parts.filter((part) => {
    if (part.length < 2 || part.length > 45) return false;
    if (/\d{4,}/.test(part)) return false;
    if (/(bachelor|master|ph\.?d|doctorate|degree|university|education|qualification|studium|ausbildung|abschluss)/i.test(part)) return false;
    if (/^(ai|llm|llms|skill|skills|technology|technologies|tool|tools)$/i.test(part)) return false;
    if (/(must\s+have|requirements?|qualifications?|your\s+profile|what\s+you\s+bring|dein\s+profil|ihr\s+profil|anforderungen|voraussetzungen)/i.test(part)) return false;

    const words = part.split(/\s+/).filter(Boolean);
    if (words.length > 5) return false;

    // Keep concise explicit skills, including non-technical ones.
    return /[a-z]/i.test(part);
  });

  const unique = [...new Set(allowed)];
  return unique.length ? unique.join(", ") : null;
}

function extractCanonicalEducationPhrase(text) {
  const source = cleanText(text);
  if (!source) return null;

  const patterns = [
    /\b(?:bachelor(?:'s)?\s+degree|master(?:'s)?\s+degree|ph\.?d|doctorate|university\s+degree|diploma|vocational\s+training)\b(?:\s+in\s+[^,.!?;\n]{2,90})?/i,
    /\bdegree\b(?:\s+in\s+[^,.!?;\n]{2,90})?/i,
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match && match[0]) {
      const phrase = cleanText(match[0]);
      if (phrase.length >= 8 && phrase.length <= 120) return phrase;
    }
  }

  return null;
}

function normalizeGermanEducation(text) {
  let s = text;
  // German degree names → English
  // Avoid replacing "Bachelor degree" → "Bachelor's degree degree"; only replace standalone Bachelor/Master
  s = s.replace(/\bBachelor(?:arbeit|abschluss|studiengang|of\s+Science|of\s+Arts)?(?!\s*'s|\s+degree)\b/gi, "Bachelor's degree");
  s = s.replace(/\bMaster(?:arbeit|abschluss|studiengang|of\s+Science|of\s+Arts)?(?!\s*'s|\s+degree)\b/gi, "Master's degree");
  s = s.replace(/\bDiplom(?:studiengang|arbeit|abschluss|\b)/gi, "Diploma");
  // "studium" → "degree"
  s = s.replace(/\b(erfolgreich abgeschlossenes\s+)?studium\b/gi, "degree");
  // "abgeschlossenes/r/e" prefix (means "completed") → strip it, "degree" is sufficient
  s = s.replace(/\babgeschlossene[rs]?\s+/gi, "");
  // "ausbildung" → "vocational training"
  s = s.replace(/\bausbildung\b/gi, "vocational training");
  // "abschluss" → "degree"
  s = s.replace(/\b(erfolgreich abgeschlossener\s+|abgeschlossener\s+)?abschluss\b/gi, "degree");
  // "erforderlich / erforderliche" → "required"
  s = s.replace(/\berforderlich[ea]?\b/gi, "required");
  // "im Bereich" → "in"
  s = s.replace(/\bim\s+Bereich\b/gi, "in");
  // "oder vergleichbar" → "or equivalent"
  s = s.replace(/\boder\s+vergleichbar\b/gi, "or equivalent");
  // "oder" → "or"
  s = s.replace(/\boder\b/gi, "or");
  // "Informatik" → "Computer Science"
  s = s.replace(/\bInformatik\b/gi, "Computer Science");
  // "Wirtschaftsinformatik" → "Business Informatics"
  s = s.replace(/\bWirtschaftsinformatik\b/gi, "Business Informatics");
  // "Wirtschaftswissenschaften" → "Business"
  s = s.replace(/\bWirtschaftswissenschaften\b/gi, "Business");
  // "Wirtschaft" → "Business" (standalone, after field-level replacements)
  s = s.replace(/\bWirtschaft\b/gi, "Business");
  // "Betriebswirtschaft" → "Business Administration"
  s = s.replace(/\bBetriebswirtschaft(?:slehre|lehre)?\b/gi, "Business Administration");
  // "Mathematik" → "Mathematics"
  s = s.replace(/\bMathematik\b/gi, "Mathematics");
  // "Ingenieur" → "Engineering"
  s = s.replace(/\bIngenieur(?:wissenschaften|wesen)?\b/gi, "Engineering");
  // "oder ähnliches" → "or similar"
  s = s.replace(/\boder\s+ähnlich(?:es|em|er)?\b/gi, "or similar");
  // Reject if the value still looks like German prose
  if (/\b(sind|haben|werden|einem|einer|immatrikuliert|derzeit|aktuell|idealerweise|studierenden)\b/i.test(s)) {
    return null;
  }
  return s.trim();
}

function sanitizeEducation(value) {
  if (!value) return null;
  const cleaned = cleanText(value);
  if (cleaned.length < 12) return null;
  if (cleaned.length > 140) return null;
  if (!/(bachelor|master|ph\.?d|degree|university|studium|ausbildung|abschluss)/i.test(cleaned)) {
    return null;
  }

  const normalized = normalizeGermanEducation(cleaned);
  if (!normalized) return null;

  // Reject question/promo fragments like "Are you a Master's degree".
  if (/\?|\byou\s+have\s+a\s+passion\b|\bare\s+you\b/i.test(normalized)) {
    const extracted = extractCanonicalEducationPhrase(normalized);
    return extracted || null;
  }

  return extractCanonicalEducationPhrase(normalized) || normalized;
}

function sanitizeYearsExperience(value) {
  if (!value) return null;
  const cleaned = cleanText(value);
  if (/\d+/.test(cleaned) && /(year|yrs|jahre)/i.test(cleaned)) return cleaned;
  return null;
}

function sanitizeEmployment(value) {
  if (!value) return null;
  const cleaned = normalizeEmploymentType(value);
  // If normalization worked, return it
  if (cleaned && cleaned !== "Unknown") return cleaned;
  // Otherwise try looser matching
  const raw = cleanText(value);
  if (/(full[- ]?time|part[- ]?time|permanent|temporary|contract|freelance|fixed term)/i.test(raw)) {
    return raw;
  }
  return null;
}

function valueToText(value, joiner = " ") {
  if (Array.isArray(value)) {
    return cleanText(value.map((item) => valueToText(item, joiner)).join(joiner));
  }
  if (typeof value === "object" && value !== null) {
    return cleanText(JSON.stringify(value));
  }
  return cleanText(value);
}

function extractJobPostingFields(jobPosting) {
  if (!jobPosting) {
    return {
      title: null,
      company: null,
      city: null,
      employmentText: null,
      skillsText: null,
      qualificationsText: null,
      experienceText: null,
      educationText: null,
      descriptionText: null,
      languageText: null,
      remoteText: null,
    };
  }

  const employmentType = valueToText(jobPosting.employmentType, ", ");
  const applicantLocation = valueToText(jobPosting.applicantLocationRequirements, " ");

  return {
    title: cleanText(jobPosting.title),
    company: firstNonEmpty(valueToText(jobPosting?.hiringOrganization?.name), valueToText(jobPosting?.hiringOrganization)),
    city: readJobPostingCity(jobPosting),
    employmentText: employmentType,
    skillsText: valueToText(jobPosting.skills, ", "),
    qualificationsText: valueToText(jobPosting.qualifications, " "),
    experienceText: valueToText(jobPosting.experienceRequirements),
    educationText: valueToText(jobPosting.educationRequirements),
    descriptionText: valueToText(jobPosting.description),
    descriptionHtml: typeof jobPosting.description === "string" ? jobPosting.description : null,
    languageText: valueToText(jobPosting.inLanguage),
    remoteText: cleanText(`${employmentType || ""} ${applicantLocation || ""}`),
  };
}

function getLinkedInJobId(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (!/linkedin\.com$/i.test(parsed.hostname) && !/\.linkedin\.com$/i.test(parsed.hostname)) {
    return null;
  }

  const fromPath = parsed.pathname.match(/\/jobs\/view\/(\d+)/i);
  if (fromPath) return fromPath[1];

  const fromQuery = parsed.searchParams.get("currentJobId") || parsed.searchParams.get("jobId");
  if (fromQuery && /^\d+$/.test(fromQuery)) return fromQuery;

  return null;
}

async function fetchLinkedInGuestJob(jobId) {
  const guestUrl = `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`;
  const response = await fetch(guestUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9,de;q=0.8",
      "Referer": "https://www.linkedin.com/",
      "X-Requested-With": "XMLHttpRequest",
    },
  });

  if (!response.ok) return null;
  const html = await response.text();
  if (!html || html.length < 300) return null;
  return html;
}

function parseLinkedInGuestJob(guestHtml) {
  const $guest = cheerio.load(guestHtml);

  const title = firstNonEmpty(
    cleanText($guest(".top-card-layout__title").first().text()),
    cleanText($guest(".topcard__title").first().text()),
    cleanText($guest("h1").first().text())
  );

  const company = firstNonEmpty(
    cleanText($guest(".topcard__org-name-link").first().text()),
    cleanText($guest(".topcard__flavor-row .topcard__flavor").first().text())
  );

  const city = firstNonEmpty(
    cleanText($guest(".topcard__flavor--bullet").first().text()),
    cleanText($guest(".topcard__flavor.topcard__flavor--bullet").first().text())
  );

  const descriptionTextRaw = firstNonEmpty(
    cleanText($guest(".show-more-less-html__markup").first().text()),
    cleanText($guest(".description__text").first().text()),
    cleanText($guest(".description").first().text())
  );
  const descriptionHtml = firstNonEmpty(
    $guest(".show-more-less-html__markup").first().html(),
    $guest(".description__text").first().html(),
    $guest(".description").first().html()
  );
  const descriptionListItems = extractListItemsFromHtml(descriptionHtml || "");
  const descriptionText = cleanText(
    `${descriptionTextRaw || ""} ${descriptionListItems.join(" • ")}`
  );

  const criteria = {};
  $guest(".description__job-criteria-item").each((_index, item) => {
    const label = cleanText($guest(item).find("h3").first().text()).toLowerCase();
    const value = cleanText($guest(item).find(".description__job-criteria-text").first().text());
    if (label && value) criteria[label] = value;
  });

  const criteriaText = Object.entries(criteria)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" ");

  const employmentText = firstNonEmpty(
    criteria["employment type"],
    criteria["anstellungsart"],
    criteria["besch\u00e4ftigungsart"],
    criteria["beschaftigungsart"]
  );

  const workplaceText = firstNonEmpty(
    criteria["workplace type"],
    criteria["arbeitsorttyp"],
    criteria["arbeitsmodell"]
  );

  return {
    title,
    company,
    city,
    descriptionText,
    descriptionHtml,
    criteriaText,
    employmentText,
    workplaceText,
    source: "linkedin-guest",
  };
}

function parseStepstoneJobPage($, rendered) {
  const title = firstNonEmpty(
    cleanText($("h1[data-at='job-item-title']").first().text()),
    cleanText($("h1[class*='listing']").first().text()),
    cleanText($("h1").first().text())
  );

  const company = firstNonEmpty(
    cleanText($("[data-at='job-item-company-name']").first().text()),
    cleanText($("[data-genesis-element='COMPANY_NAME']").first().text()),
    cleanText($("meta[property='og:site_name']").attr("content"))
  );

  const city = firstNonEmpty(
    cleanText($("[data-at='job-item-location']").first().text()),
    cleanText($("meta[property='jobLocation']").attr("content"))
  );

  const descriptionText = firstNonEmpty(
    cleanText($("[data-at='job-ad-description']").first().text()),
    cleanText($("#job-details").first().text()),
    cleanText($("[class*='jobad']").first().text()),
    cleanText(rendered?.descriptionText)
  );

  const descriptionHtml = firstNonEmpty(
    $("[data-at='job-ad-description']").first().html(),
    $("#job-details").first().html(),
    $("[class*='jobad']").first().html(),
    rendered?.descriptionHtml
  );

  const metaText = cleanText(
    [
      $("[data-at='job-item-worktype']").text(),
      $("[data-at='job-item-employment-type']").text(),
      $("[data-at='job-item-salary']").text(),
      $("[class*='salary']").text(),
      $("[class*='worktype']").text(),
    ].join(" ")
  );

  return {
    title,
    company,
    city,
    descriptionText,
    descriptionHtml,
    criteriaText: metaText,
    employmentText: metaText,
    workplaceText: metaText,
    wageText: metaText,
    source: "stepstone",
  };
}

function getUrlHost(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

async function extractJobDataFromUrl(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);

  let html = null;
  let rendered = null;
  let responseStatus = null;

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,de;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "max-age=0",
        "Referer": "https://www.google.com/",
      },
    });

    responseStatus = response.status;
    html = await response.text();
  } finally {
    clearTimeout(timeoutId);
  }

  try {
    rendered = await renderPageInBrowser(url);
  } catch {
    rendered = null;
  }

  const sourceHtml = rendered?.html || html;
  if (!sourceHtml) {
    throw new Error(`Unable to fetch URL (${responseStatus || "unknown"})`);
  }

  const $ = cheerio.load(sourceHtml);

  let linkedInGuest = null;
  const linkedInJobId = getLinkedInJobId(url);
  if (linkedInJobId) {
    try {
      const guestHtml = await fetchLinkedInGuestJob(linkedInJobId);
      if (guestHtml) {
        linkedInGuest = parseLinkedInGuestJob(guestHtml);
      }
    } catch {
      // Best-effort optimization: if LinkedIn guest fetch fails, continue with generic extraction.
    }
  }

  const host = getUrlHost(url);
  const isStepstone = /(^|\.)stepstone\./i.test(host);
  const siteSpecific = isStepstone
    ? parseStepstoneJobPage($, rendered)
    : null;

  const jobPosting = getJobPostingFromJsonLd($);
  const structured = extractJobPostingFields(jobPosting);

  const pageTitle = firstNonEmpty(
    $("meta[property='og:title']").attr("content"),
    $("meta[name='twitter:title']").attr("content"),
    $("h1").first().text(),
    $("title").text()
  );

  const fullText = cleanText(rendered?.bodyText || $("body").text());
  const baseText = linkedInGuest
    ? cleanText(`${linkedInGuest.descriptionText || ""} ${linkedInGuest.criteriaText || ""}`)
    : siteSpecific?.descriptionText
      ? cleanText(`${siteSpecific.descriptionText || ""} ${siteSpecific.criteriaText || ""}`)
      : fullText;
  const capturedDescription = firstNonEmpty(
    linkedInGuest?.descriptionText,
    siteSpecific?.descriptionText,
    rendered?.descriptionText,
    structured.descriptionText,
    baseText,
    fullText
  );
  const capturedDescriptionSource = linkedInGuest?.descriptionText
    ? "linkedin-guest"
    : siteSpecific?.descriptionText
      ? siteSpecific.source || "site-specific"
      : rendered?.descriptionText
        ? "rendered-dom"
        : structured.descriptionText
          ? "json-ld"
          : "page-text";

  const corpus = cleanText(
    `${baseText} ${rendered?.descriptionText || ""} ${(rendered?.listItems || []).join(" ")} ${structured.descriptionText || ""} ${structured.qualificationsText || ""}`
  );
  const descriptionHtml = firstNonEmpty(linkedInGuest?.descriptionHtml, siteSpecific?.descriptionHtml, rendered?.descriptionHtml, structured.descriptionHtml);
  const descriptionCorpus = cleanText(`${capturedDescription || ""} ${structured.qualificationsText || ""}`);
  const titleCandidate = firstNonEmpty(linkedInGuest?.title, siteSpecific?.title, structured.title, cleanText(pageTitle));
  const companyCandidate = firstNonEmpty(linkedInGuest?.company, structured.company, siteSpecific?.company, inferCompany($, pageTitle || ""));
  const cityCandidate = firstNonEmpty(linkedInGuest?.city, structured.city, siteSpecific?.city, inferCity($, descriptionCorpus));
  const aiExtraction = await extractFieldsWithOllama({
    title: titleCandidate,
    company: companyCandidate,
    city: cityCandidate,
    descriptionText: descriptionCorpus,
  });

  const requiredSkillsFromAi = firstNonEmpty(
    sanitizeAiSkills(aiExtraction?.required_skills),
    sanitizeSkills(aiExtraction?.required_skills)
  );
  const requiredSkillsFromHeuristics = firstNonEmpty(
    sanitizeSkills(
      mergeSkillValues(
        structured.skillsText,
        extractSkillsFromSources(descriptionCorpus, descriptionHtml, REQUIREMENT_LABELS),
        extractSkillsFromText(descriptionCorpus, REQUIREMENT_LABELS),
        extractExplicitSkillsFromProfile(descriptionCorpus),
        extractKnownSkillsFromCorpus(descriptionCorpus),
        extractSkillListsFromPhrases(descriptionCorpus),
        inferRequiredSkillsFallback(titleCandidate, descriptionCorpus)
      )
    ),
    inferRequiredSkillsFallback(titleCandidate, descriptionCorpus)
  );

  const requiredSkills = firstNonEmpty(
    sanitizeSkills(mergeSkillValues(requiredSkillsFromAi, requiredSkillsFromHeuristics)),
    requiredSkillsFromAi,
    requiredSkillsFromHeuristics
  );

  // Multi-source experience extraction
  const experienceRaw = firstNonEmpty(
    sanitizeYearsExperience(structured.experienceText),
    sanitizeYearsExperience(inferYearsExperience(descriptionCorpus)),
    sanitizeYearsExperience(extractExperienceFromCorpus(descriptionCorpus))
  );

  const yearsExperience = isWorkingStudentRole(titleCandidate, descriptionCorpus, null)
    ? "0-2 years of experience"
    : firstNonEmpty(sanitizeYearsExperience(aiExtraction?.years_experience), experienceRaw);

  // Multi-source wage extraction
  const wageRaw = firstNonEmpty(
    sanitizeWage(inferWageFromJsonLd(jobPosting)),
    sanitizeWage(inferWageFromText(siteSpecific?.wageText)),
    sanitizeWage(extractWageFromCorpus(descriptionCorpus)),
    sanitizeWage(inferWageFromText(descriptionCorpus))
  );

  const wage = firstNonEmpty(sanitizeWage(aiExtraction?.wage), wageRaw);

  // Multi-source education extraction
  const educationRaw = firstNonEmpty(
    sanitizeEducation(structured.educationText),
    sanitizeEducation(inferEducationRequirements(descriptionCorpus)),
    sanitizeEducation(extractEducationFromCorpus(descriptionCorpus)),
    sanitizeEducation(
      extractRelevantSentence(
        descriptionCorpus,
        /(bachelor|master|degree|diploma|qualification|certificate|certification|studium|ausbildung|abschluss)/i,
        /(benefit|salary|vacation|offer|about us|company)/i
      )
    )
  );

  const educationRequirements = firstNonEmpty(
    sanitizeEducation(aiExtraction?.education_requirements),
    educationRaw
  );

  // Multi-source employment type extraction
  const employmentRaw = firstNonEmpty(
    sanitizeEmployment(siteSpecific?.employmentText),
    sanitizeEmployment(linkedInGuest?.employmentText),
    sanitizeEmployment(structured.employmentText),
    sanitizeEmployment(extractEmploymentTypeFromCorpus(descriptionCorpus)),
    sanitizeEmployment(inferEmploymentType(descriptionCorpus)),
    extractRelevantSentence(
      descriptionCorpus,
      /(full[- ]?time|part[- ]?time|temporary|permanent|fixed[- ]?term|contract|freelance|working student|internship|intern)/i,
      /(benefit|salary|vacation|offer|about us|company)/i
    )
  );

  const roleEmploymentHint = isWorkingStudentRole(titleCandidate, descriptionCorpus, employmentRaw)
    ? "Working student"
    : null;

  const employmentType = firstNonEmpty(
    roleEmploymentHint,
    sanitizeEmployment(aiExtraction?.employment_type),
    employmentRaw
  );

  // Multi-source language extraction
  const extractedLanguages = inferLanguageRequirementsFromHtml(firstNonEmpty(structured.languageText, descriptionCorpus), descriptionHtml);
  const languageFromDocument = inferLanguageFromDocumentLanguage(firstNonEmpty(structured.descriptionText, descriptionCorpus));
  const requiredLanguages = firstNonEmpty(
    sanitizeAiListValue(aiExtraction?.required_languages),
    mergeLanguages(extractedLanguages, languageFromDocument)
  );

  const extractedJob = {
    url,
    title: titleCandidate,
    company: companyCandidate,
    city: cityCandidate,
    remote_type: normalizeRemoteType(`${siteSpecific?.workplaceText || ""} ${linkedInGuest?.workplaceText || ""} ${structured.remoteText || ""}`),
    required_skills: requiredSkills,
    preferred_skills: null,
    years_experience: yearsExperience,
    wage,
    education_requirements: educationRequirements,
    employment_type: employmentType,
    required_languages: requiredLanguages,
    captured_description: capturedDescription,
    captured_description_source: capturedDescriptionSource,
  };

  return normalizeJobDataToEnglishWithOllama(extractedJob);
}

async function extractJobDataFromText(description, { title = null, company = null, city = null } = {}) {
  const descriptionCorpus = cleanText(description);
  if (!descriptionCorpus || descriptionCorpus.length < 30) {
    throw new Error("Job description must be at least 30 characters long");
  }

  const manualUrl = `manual://text/${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  const aiExtraction = await extractFieldsWithOllama({
    title: title || "",
    company: company || "",
    city: city || "",
    descriptionText: descriptionCorpus,
  });

  const requiredSkillsFromAi = firstNonEmpty(
    sanitizeAiSkills(aiExtraction?.required_skills),
    sanitizeSkills(aiExtraction?.required_skills)
  );
  const requiredSkillsFromHeuristics = firstNonEmpty(
    sanitizeSkills(
      mergeSkillValues(
        extractSkillsFromText(descriptionCorpus, REQUIREMENT_LABELS),
        extractExplicitSkillsFromProfile(descriptionCorpus),
        extractKnownSkillsFromCorpus(descriptionCorpus),
        extractSkillListsFromPhrases(descriptionCorpus),
        inferRequiredSkillsFallback(title, descriptionCorpus)
      )
    ),
    inferRequiredSkillsFallback(title, descriptionCorpus)
  );

  const requiredSkills = firstNonEmpty(
    sanitizeSkills(mergeSkillValues(requiredSkillsFromAi, requiredSkillsFromHeuristics)),
    requiredSkillsFromAi,
    requiredSkillsFromHeuristics
  );

  const experienceRaw = firstNonEmpty(
    sanitizeYearsExperience(aiExtraction?.years_experience),
    sanitizeYearsExperience(inferYearsExperience(descriptionCorpus)),
    sanitizeYearsExperience(extractExperienceFromCorpus(descriptionCorpus))
  );

  const yearsExperience = isWorkingStudentRole(title, descriptionCorpus, null)
    ? "0-2 years of experience"
    : experienceRaw;

  const wage = firstNonEmpty(
    sanitizeWage(aiExtraction?.wage),
    sanitizeWage(inferWageFromText(descriptionCorpus))
  );

  const educationRaw = inferEducationRequirements(descriptionCorpus);
  const educationRequirements = firstNonEmpty(
    sanitizeEducation(aiExtraction?.education_requirements),
    sanitizeEducation(educationRaw)
  );

  const employmentRaw = firstNonEmpty(
    sanitizeEmployment(extractEmploymentTypeFromCorpus(descriptionCorpus)),
    sanitizeEmployment(inferEmploymentType(descriptionCorpus))
  );

  const roleEmploymentHint = isWorkingStudentRole(title, descriptionCorpus, employmentRaw)
    ? "Working student"
    : null;

  const employmentType = firstNonEmpty(
    roleEmploymentHint,
    sanitizeEmployment(aiExtraction?.employment_type),
    employmentRaw
  );

  const extractedLanguages = inferLanguageRequirements(descriptionCorpus);
  const languageFromDocument = inferLanguageFromDocumentLanguage(descriptionCorpus);
  const requiredLanguages = firstNonEmpty(
    sanitizeAiListValue(aiExtraction?.required_languages),
    mergeLanguages(extractedLanguages, languageFromDocument)
  );

  const extractedJob = {
    url: manualUrl,
    title: title || aiExtraction?.title || null,
    company: company || aiExtraction?.company || null,
    city: city || aiExtraction?.city || null,
    remote_type: normalizeRemoteType(descriptionCorpus),
    required_skills: requiredSkills,
    preferred_skills: null,
    years_experience: yearsExperience,
    wage,
    education_requirements: educationRequirements,
    employment_type: employmentType,
    required_languages: requiredLanguages,
    captured_description: descriptionCorpus,
    captured_description_source: "manual-text",
  };

  return normalizeJobDataToEnglishWithOllama(extractedJob);
}

module.exports = {
  extractJobDataFromUrl,
  extractJobDataFromText,
};
