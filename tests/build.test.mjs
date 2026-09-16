import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildAssistant } from "../scripts/lib/build-assistant.mjs";

/**
 * Rendering and source handling. The hot/cold split itself, the scope manifest and
 * the hot-core threshold are covered in split.test.mjs.
 */

const FACT_SHEET = `# Test Kitchen — Fact Sheet

## Opening hours

- Monday: closed

## Menu highlights and prices

- Pad thai: 19 dollars. Contains peanuts.
`;

const ROUTING = {
  sections: { "Opening hours": "hot", "Menu highlights and prices": "cold" },
  extractToHot: { matching: "Contains" },
};

const PROMPT_TEMPLATE = `<hot_knowledge>
{{HOT_KNOWLEDGE}}
</hot_knowledge>

<allergen_matrix>
{{ALLERGEN_MATRIX}}
</allergen_matrix>

<covered_topics>
{{SCOPE_MANIFEST}}
</covered_topics>

<not_covered>
{{NOT_COVERED}}
</not_covered>

Today is {{CURRENT_DATE}}.
`;

const ASSISTANT_CONFIG = {
  name: "Test Assistant",
  model: {
    provider: "openai",
    model: "gpt-4.1-mini",
    messages: [{ role: "system", content: "{{SYSTEM_PROMPT}}" }],
    tools: [{ type: "endCall" }],
  },
  analysisPlan: {
    summaryPlan: {
      enabled: true,
      messages: [
        { role: "system", content: "{{SUMMARY_PROMPT}}" },
        { role: "user", content: "Transcript:\n\n{{transcript}}" },
      ],
    },
  },
};

const KB_CONFIG = {
  grounding: { mode: "hybrid", hotThresholdTokens: 600 },
  scope: { headingAliases: {}, notCovered: ["corkage or BYOB fees", "Wi-Fi"] },
};

function build(overrides = {}) {
  const files = { "fact-sheet.md": FACT_SHEET, ...(overrides.files ?? {}) };

  return buildAssistant({
    kbConfig: structuredClone({ ...KB_CONFIG, ...(overrides.kbConfig ?? {}) }),
    routing: structuredClone(overrides.routing ?? ROUTING),
    sourceFiles: overrides.sourceFiles ?? ["fact-sheet.md"],
    promptTemplate: overrides.promptTemplate ?? PROMPT_TEMPLATE,
    summaryPrompt: overrides.summaryPrompt ?? "Summarise the call.",
    assistantConfig: structuredClone(ASSISTANT_CONFIG),
    readKbFile: (name) => {
      if (!(name in files)) throw new Error(`fixture missing: ${name}`);
      return files[name];
    },
  });
}

const promptOf = (r) => r.assistant.model.messages[0].content;

/* -------------------------------------------------------------------------- */

describe("anti-examples", () => {
  test("1.3 refuses to build when a notCovered entry is present in the sources", () => {
    assert.throws(
      () => build({ kbConfig: { scope: { headingAliases: {}, notCovered: ["pad thai"] } } }),
      /pad thai/i,
      "listing a covered topic as not-covered would make the assistant deny a fact it has"
    );
  });
});

describe("rendering", () => {
  test("1.5 refuses to build when a marker is left unsubstituted", () => {
    assert.throws(() => build({ promptTemplate: PROMPT_TEMPLATE + "\n{{UNKNOWN_MARKER}}\n" }), /UNKNOWN_MARKER/);
  });

  test("1.6 renders CURRENT_DATE as a runtime expression, not the build date", () => {
    const prompt = promptOf(build());
    const thisYear = String(new Date().getFullYear());

    assert.match(prompt, /\{\{"now" \| date:/, "must stay a LiquidJS expression Vapi evaluates per call");
    assert.doesNotMatch(prompt, new RegExp(`Today is [^\\n]*${thisYear}`), "build date must not be baked in");
  });

  test("1.7 embeds hot facts verbatim", () => {
    assert.ok(promptOf(build()).includes("- Monday: closed"), "facts must reach the model unmodified");
  });

  test("1.7b substitutes the summary prompt into the analysis plan", () => {
    const { assistant } = build({ summaryPrompt: "SUMMARY RULES HERE" });

    assert.equal(assistant.analysisPlan.summaryPlan.messages[0].content, "SUMMARY RULES HERE");
    assert.match(assistant.analysisPlan.summaryPlan.messages[1].content, /\{\{transcript\}\}/);
  });
});

describe("sources", () => {
  test("1.8 reads every listed source file", () => {
    const { assistant } = build({
      files: { "extra.md": "## Parking\n\n- Free after 6 pm.\n" },
      sourceFiles: ["fact-sheet.md", "extra.md"],
      routing: { ...ROUTING, sections: { ...ROUTING.sections, Parking: "hot" } },
    });

    assert.ok(assistant.model.messages[0].content.includes("- Free after 6 pm."));
  });

  test("1.8b fails when there are no sources at all", () => {
    assert.throws(() => build({ sourceFiles: [] }), /no knowledge sources/i);
  });

  test("1.9 rejects the superseded inline-only mode and says where to read why", () => {
    assert.throws(
      () => build({ kbConfig: { grounding: { mode: "inline", hotThresholdTokens: 600 } } }),
      /ADR-001|superseded/i
    );
  });
});
