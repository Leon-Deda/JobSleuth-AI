function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function formatZodIssues(issues) {
  if (!Array.isArray(issues) || !issues.length) return "Unknown validation error";
  return issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
    .join("; ");
}

async function requestOllama({
  url,
  model,
  timeoutMs,
  prompt,
  format = "json",
  temperature = 0.1,
}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${url}/api/generate`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        format,
        options: {
          temperature,
        },
      }),
    });

    if (!response.ok) {
      return { ok: false, text: null };
    }

    const payload = await response.json();
    return { ok: true, text: String(payload?.response || "") };
  } catch {
    return { ok: false, text: null };
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildRepairPrompt({ schemaLabel, validationError, invalidOutput }) {
  return [
    "You repair JSON outputs to match a strict schema.",
    "Return ONLY valid JSON. No markdown. No comments.",
    `Schema label: ${schemaLabel}`,
    `Validation errors: ${validationError}`,
    "Fix the JSON below and keep only schema-compliant keys and value types.",
    "Invalid JSON output:",
    invalidOutput,
  ].join("\n");
}

async function generateJsonWithSchema({
  prompt,
  schema,
  schemaLabel,
  url,
  model,
  timeoutMs,
  temperature = 0.1,
  maxAttempts = 2,
}) {
  let lastRaw = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const base = await requestOllama({
      url,
      model,
      timeoutMs,
      prompt,
      format: "json",
      temperature,
    });

    if (!base.ok || !base.text) continue;
    lastRaw = base.text;

    const parsed = safeJsonParse(base.text);
    const validated = schema.safeParse(parsed);
    if (validated.success) {
      return validated.data;
    }

    const repairPrompt = buildRepairPrompt({
      schemaLabel,
      validationError: formatZodIssues(validated.error.issues),
      invalidOutput: base.text,
    });

    const repair = await requestOllama({
      url,
      model,
      timeoutMs,
      prompt: repairPrompt,
      format: "json",
      temperature: 0,
    });

    if (!repair.ok || !repair.text) continue;
    lastRaw = repair.text;

    const repairedParsed = safeJsonParse(repair.text);
    const repairedValidated = schema.safeParse(repairedParsed);
    if (repairedValidated.success) {
      return repairedValidated.data;
    }
  }

  return null;
}

module.exports = {
  generateJsonWithSchema,
  requestOllama,
  safeJsonParse,
};
