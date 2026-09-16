import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildAssistant } from "../scripts/lib/build-assistant.mjs";

/* ---------- fixtures ------------------------------------------------------ */

const FACT_SHEET = `# Test Kitchen — Fact Sheet

## Opening hours

- Monday: closed
- Tuesday to Sunday: 5 pm to 10 pm

## Menu highlights and prices

- Pad thai: 19 dollars. Contains peanuts.

## Other

- Dress code: casual.
`;

const PROMPT_TEMPLATE = `## Identity

You are an assistant.

<knowledge_base>
{{KNOWLEDGE_BASE}}
</knowledge_base>

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
  voice: { provider: "11labs", voiceId: "abc123" },
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
  grounding: { mode: "inline", inlineThresholdTokens: 580 },
  sources: { hot: ["fact-sheet.md"], cold: [] },
  scope: {
    headingAliases: { Other: "dress code" },
    notCovered: ["corkage or BYOB fees", "Wi-Fi"],
  },
};

/** Builds with the default fixtures, overriding any slice of the input. */
function build(overrides = {}) {
  const files = { "fact-sheet.md": FACT_SHEET, ...(overrides.files ?? {}) };

  return buildAssistant({
    kbConfig: structuredClone({ ...KB_CONFIG, ...(overrides.kbConfig ?? {}) }),
    promptTemplate: overrides.promptTemplate ?? PROMPT_TEMPLATE,
    summaryPrompt: overrides.summaryPrompt ?? "Summarise the call.",
    assistantConfig: structuredClone(overrides.assistantConfig ?? ASSISTANT_CONFIG),
    readKbFile: (name) => {
      if (!(name in files)) throw new Error(`fixture missing: ${name}`);
      return files[name];
    },
  });
}

const systemPromptOf = (result) => result.assistant.model.messages[0].content;

/* ---------- 1.1–1.2  scope manifest --------------------------------------- */

describe("scope manifest", () => {
  test("1.1 contains one entry per '##' heading in the fact sheet", () => {
    const prompt = systemPromptOf(build());

    assert.match(prompt, /- opening hours/);
    assert.match(prompt, /- menu highlights and prices/);
  });

  test("1.2 applies the alias for an unhelpful heading", () => {
    const prompt = systemPromptOf(build());

    assert.match(prompt, /- dress code/, "alias should replace the heading");
    assert.doesNotMatch(prompt, /- other$/m, "raw 'Other' is useless as a topic name");
  });

  test("1.3 refuses to build when a notCovered entry is present in the fact sheet", () => {
    assert.throws(
      () =>
        build({
          kbConfig: {
            scope: { ...KB_CONFIG.scope, notCovered: ["pad thai"] },
          },
        }),
      /pad thai/i,
      "listing a covered topic as not-covered would make the assistant deny a fact it has"
    );
  });
});

/* ---------- 1.4  grounding rule ------------------------------------------- */

describe("grounding rule", () => {
  test("1.4 refuses to build when the KB exceeds the inline threshold", () => {
    assert.throws(
      () => build({ kbConfig: { grounding: { mode: "inline", inlineThresholdTokens: 10 } } }),
      /threshold/i
    );
  });

  test("1.4b reports the measured token count so the tripwire is observable", () => {
    const { stats } = build();

    assert.ok(stats.kbTokens > 0, "kbTokens must be measured, not assumed");
    assert.equal(stats.thresholdTokens, 580);
  });
});

/* ---------- 1.5–1.7  rendering -------------------------------------------- */

describe("rendering", () => {
  test("1.5 refuses to build when a marker is left unsubstituted", () => {
    assert.throws(
      () => build({ promptTemplate: PROMPT_TEMPLATE + "\n{{UNKNOWN_MARKER}}\n" }),
      /UNKNOWN_MARKER/
    );
  });

  test("1.6 renders CURRENT_DATE as a runtime expression, not the build date", () => {
    const prompt = systemPromptOf(build());
    const thisYear = String(new Date().getFullYear());

    assert.match(prompt, /\{\{"now" \| date:/, "must stay a LiquidJS expression Vapi evaluates per call");
    assert.doesNotMatch(prompt, new RegExp(`Today is [^\\n]*${thisYear}`), "build date must not be baked in");
  });

  test("1.7 embeds the fact sheet verbatim", () => {
    const prompt = systemPromptOf(build());

    assert.ok(
      prompt.includes("- Pad thai: 19 dollars. Contains peanuts."),
      "facts must reach the model unmodified"
    );
  });

  test("1.7b substitutes the summary prompt into the analysis plan", () => {
    const { assistant } = build({ summaryPrompt: "SUMMARY RULES HERE" });

    assert.equal(assistant.analysisPlan.summaryPlan.messages[0].content, "SUMMARY RULES HERE");
    assert.match(assistant.analysisPlan.summaryPlan.messages[1].content, /\{\{transcript\}\}/);
  });
});

/* ---------- 1.8–1.9  sources ---------------------------------------------- */

describe("sources", () => {
  test("1.8 reads every file listed in sources.hot", () => {
    const prompt = systemPromptOf(
      build({
        files: { "extra.md": "## Parking\n\n- Free after 6 pm.\n" },
        kbConfig: { sources: { hot: ["fact-sheet.md", "extra.md"], cold: [] } },
      })
    );

    assert.ok(prompt.includes("- Free after 6 pm."), "second hot source must be included");
    assert.match(prompt, /- parking/, "its headings must reach the scope manifest too");
  });

  test("1.9 refuses to build when cold sources exist but mode is still inline", () => {
    assert.throws(
      () =>
        build({
          files: { "menu.md": "## Full menu\n\n- Many dishes.\n" },
          kbConfig: { sources: { hot: ["fact-sheet.md"], cold: ["menu.md"] } },
        }),
      /cold/i,
      "mode and data must not diverge silently"
    );
  });

  test("1.9b rejects a grounding mode that is documented but not implemented", () => {
    assert.throws(
      () => build({ kbConfig: { grounding: { mode: "hybrid", inlineThresholdTokens: 580 } } }),
      /not implemented/i
    );
  });
});
