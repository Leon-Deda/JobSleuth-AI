const { z } = require("zod");

const jobTableExtractionSchema = z.object({
  required_skills: z.array(z.string()).default([]),
  years_experience: z.string().nullable().default(null),
  wage: z.string().nullable().default(null),
  education_requirements: z.string().nullable().default(null),
  employment_type: z.string().nullable().default(null),
  required_languages: z.array(z.string()).default([]),
});

const englishNormalizationSchema = z.object({
  title: z.string().nullable().default(null),
  company: z.string().nullable().default(null),
  city: z.string().nullable().default(null),
  remote_type: z.string().nullable().default(null),
  required_skills: z.array(z.string()).default([]),
  preferred_skills: z.array(z.string()).nullable().default(null),
  years_experience: z.string().nullable().default(null),
  wage: z.string().nullable().default(null),
  education_requirements: z.string().nullable().default(null),
  employment_type: z.string().nullable().default(null),
  required_languages: z.array(z.string()).default([]),
  captured_description: z.string().nullable().default(null),
});

const matchDimensionSchema = z.object({
  skills: z.number().min(0).max(100),
  experience: z.number().min(0).max(100),
  domainFit: z.number().min(0).max(100),
  language: z.number().min(0).max(100),
  locationAndLogistics: z.number().min(0).max(100),
});

const jobMatchSchema = z.object({
  matches: z.array(
    z.object({
      job_id: z.number().int().nonnegative(),
      overallScore: z.number().min(0).max(100),
      dimensionScores: matchDimensionSchema,
      strengths: z.array(z.string()).default([]),
      gaps: z.array(z.string()).default([]),
      mustFixBeforeApplying: z.array(z.string()).default([]),
      fastImprovements: z.array(z.string()).default([]),
      reasoningSummary: z.string().default(""),
      confidence: z.number().min(0).max(100).default(50),
    })
  ),
});

const motivationLetterSchema = z.object({
  letter: z.string().min(120),
  overlapHighlights: z.array(z.string()).default([]),
  factualityChecklist: z.object({
    inventedFacts: z.boolean(),
    mentionsCompanyAndRole: z.boolean(),
    includesThreeOverlaps: z.boolean(),
  }),
});

module.exports = {
  jobTableExtractionSchema,
  englishNormalizationSchema,
  jobMatchSchema,
  motivationLetterSchema,
};
