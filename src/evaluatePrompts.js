const fs = require("fs");
const path = require("path");
const { extractJobDataFromText } = require("./extractJobData");
const { matchCvTextToJobs, generateMotivationLetter } = require("./jobMatch");

function cleanText(text) {
  const normalized = typeof text === "string" ? text : text == null ? "" : String(text);
  return normalized.replace(/\s+/g, " ").trim();
}

function containsAny(haystack, values) {
  const base = cleanText(haystack).toLowerCase();
  return values.some((value) => base.includes(cleanText(value).toLowerCase()));
}

function scoreSkillHit(extractedSkills, expectedSkills) {
  if (!Array.isArray(expectedSkills) || !expectedSkills.length) return 1;
  const found = expectedSkills.filter((skill) => containsAny(extractedSkills, [skill]));
  return found.length / expectedSkills.length;
}

async function runCase(testCase) {
  const extraction = await extractJobDataFromText(testCase.jobDescription, {
    title: testCase.title,
    company: testCase.company,
    city: testCase.city,
  });

  const skillScore = scoreSkillHit(extraction.required_skills || "", testCase.expected?.requiredSkills || []);
  const yearsPass = testCase.expected?.yearsExperienceIncludes
    ? containsAny(extraction.years_experience || "", [testCase.expected.yearsExperienceIncludes])
    : true;
  const typePass = testCase.expected?.employmentType
    ? containsAny(extraction.employment_type || "", [testCase.expected.employmentType])
    : true;
  const langPass = Array.isArray(testCase.expected?.languages)
    ? containsAny(extraction.required_languages || "", testCase.expected.languages)
    : true;

  const wagePass = testCase.expected?.wageContains
    ? containsAny(extraction.wage || "", [testCase.expected.wageContains])
    : true;
  const wageNoGerman = testCase.expected?.wage
    ? !/(pro\s+stunde|pro\s+monat|pro\s+jahr|brutto|netto)/i.test(extraction.wage || "")
    : true;

  const matchRows = await matchCvTextToJobs(testCase.cvText || "", [
    {
      id: 1,
      ...extraction,
    },
  ]);

  const top = Array.isArray(matchRows) && matchRows.length ? matchRows[0] : null;
  const matchPass = top
    ? Number(top.suitability_score || 0) >= Number(testCase.expectedMatch?.minScore || 0)
    : false;

  const motivation = await generateMotivationLetter(testCase.cvText || "", extraction, {
    applicant_name: "Test Candidate",
    recipient_name: "Hiring Manager",
  });

  const letter = String(motivation?.letter || "");
  const mentionsCompany = containsAny(letter, [testCase.company || ""]);
  const mentionsRole = containsAny(letter, [testCase.title || ""]);
  const wordCount = cleanText(letter).split(" ").filter(Boolean).length;
  const motivationPass = mentionsCompany && mentionsRole && wordCount >= 180;

  return {
    id: testCase.id,
    extraction: {
      skillScore,
      yearsPass,
      typePass,
      langPass,
      wagePass,
      wageNoGerman,
      wage: extraction.wage,
      passed: skillScore >= 0.66 && yearsPass && typePass && langPass && wagePass && wageNoGerman,
    },
    match: {
      score: Number(top?.suitability_score || 0),
      passed: matchPass,
    },
    motivation: {
      wordCount,
      source: motivation?.source || "unknown",
      passed: motivationPass,
    },
  };
}

async function main() {
  const filePath = path.join(__dirname, "..", "data", "evals", "prompt-eval-cases.json");
  const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));

  const results = [];
  for (const testCase of data) {
    try {
      const result = await runCase(testCase);
      results.push(result);
    } catch (error) {
      results.push({
        id: testCase.id,
        error: error?.message || "Unknown error",
      });
    }
  }

  const total = results.length;
  const passedExtraction = results.filter((r) => r.extraction?.passed).length;
  const passedMatch = results.filter((r) => r.match?.passed).length;
  const passedMotivation = results.filter((r) => r.motivation?.passed).length;

  console.log("Prompt Eval Results");
  console.log(JSON.stringify(results, null, 2));
  console.log(
    JSON.stringify(
      {
        total,
        extractionPassRate: `${passedExtraction}/${total}`,
        matchPassRate: `${passedMatch}/${total}`,
        motivationPassRate: `${passedMotivation}/${total}`,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error("Prompt evaluation failed:", error?.message || error);
  process.exitCode = 1;
});
