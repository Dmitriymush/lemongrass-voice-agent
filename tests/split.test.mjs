import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildAssistant } from "../scripts/lib/build-assistant.mjs";

/* ---------- fixtures ------------------------------------------------------ */

const FACT_SHEET = `# Test Kitchen — Fact Sheet

## Opening hours

- Monday: closed
- Tuesday to Sunday: 5 pm to 10 pm

## Menu highlights and prices

- Pad thai with shrimp or tofu: 19 dollars. Contains peanuts.
- Green curry with chicken: 21 dollars
- Papaya salad: 13 dollars. Contains peanuts and fish sauce.

## Dietary information

- Gluten-free options are available.

## Other

- Dress code: casual.
`;

const ROUTING = {
  sections: {
    "Opening hours": "hot",
    "Menu highlights and prices": "cold",
    "Dietary information": "hot",
    Other: "hot",
  },
  extractToHot: { matching: "Contains" },
};

const PROMPT_TEMPLATE = `## Identity

<hot_knowledge>
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
    summaryPlan: { enabled: true, messages: [{ role: "system", content: "{{SUMMARY_PROMPT}}" }] },
  },
};

const KB_CONFIG = {
  grounding: { mode: "hybrid", hotThresholdTokens: 600 },
  sources: { hot: [], cold: [] },
  scope: { headingAliases: { Other: "dress code" }, notCovered: ["corkage or BYOB fees"] },
};

function build(overrides = {}) {
  const files = { "fact-sheet.md": overrides.factSheet ?? FACT_SHEET };

  return buildAssistant({
    kbConfig: structuredClone({ ...KB_CONFIG, ...(overrides.kbConfig ?? {}) }),
    routing: structuredClone(overrides.routing ?? ROUTING),
    sourceFiles: ["fact-sheet.md"],
    promptTemplate: overrides.promptTemplate ?? PROMPT_TEMPLATE,
    summaryPrompt: "Summarise the call.",
    assistantConfig: structuredClone(ASSISTANT_CONFIG),
    readKbFile: (name) => files[name],
  });
}

const promptOf = (r) => r.assistant.model.messages[0].content;

/* ---------- 6.1–6.2  the split is real ------------------------------------ */

describe("hot/cold split", () => {
  test("6.1 hot sections reach the prompt and cold sections do not", () => {
    const prompt = promptOf(build());

    assert.ok(prompt.includes("Monday: closed"), "hours are hot — asked in most calls");
    assert.ok(prompt.includes("Gluten-free options are available."), "dietary information is hot");
    assert.ok(prompt.includes("Dress code: casual."), "small stable facts are hot");

    assert.ok(
      !prompt.includes("Green curry with chicken: 21 dollars"),
      "a dish with no allergen line belongs to the knowledge base, not the prompt"
    );
  });

  test("6.2 cold sections are emitted as their own document for upload", () => {
    const { cold } = build();

    assert.ok(cold.includes("Green curry with chicken: 21 dollars"));
    assert.ok(!cold.includes("Dress code"), "hot facts must not be duplicated into the knowledge base");
    assert.match(cold, /^##\s+Menu highlights and prices/m, "headings survive, retrieval needs them for context");
  });
});

/* ---------- 6.3–6.4  allergen extraction ---------------------------------- */

describe("allergen matrix", () => {
  test("6.3 allergen lines from cold sections are lifted into the hot prompt", () => {
    const prompt = promptOf(build());

    assert.ok(prompt.includes("Contains peanuts."), "pad thai's allergen line must not depend on retrieval");
    assert.ok(prompt.includes("Contains peanuts and fish sauce."), "every allergen line, not just the first");
  });

  test("6.4 the lift is verbatim — no rewriting, no price stripped", () => {
    const prompt = promptOf(build());

    assert.ok(
      prompt.includes("- Pad thai with shrimp or tofu: 19 dollars. Contains peanuts."),
      "a clever extraction would one day cut the wrong thing; the line is copied as-is"
    );
  });

  test("6.4b a cold section with no allergen lines yields an empty matrix, not a crash", () => {
    const factSheet = FACT_SHEET.replace(/\. Contains[^\n]*/g, "");
    const { assistant } = build({ factSheet });

    assert.ok(assistant.model.messages[0].content.includes("<allergen_matrix>"));
  });
});

/* ---------- 6.5, 6.8  routing integrity ----------------------------------- */

describe("routing integrity", () => {
  test("6.5 a section missing from routing.json fails the build", () => {
    const factSheet = FACT_SHEET + "\n## Private events\n\n- Room seats 20.\n";

    assert.throws(() => build({ factSheet }), /Private events/, "a new section must not vanish silently");
  });

  test("6.5b an unknown routing value fails the build", () => {
    const routing = { ...ROUTING, sections: { ...ROUTING.sections, "Opening hours": "warm" } };

    assert.throws(() => build({ routing }), /warm/);
  });

  test("6.8 nothing but allergen lines appears in both halves", () => {
    const { assistant, cold } = build();
    const prompt = assistant.model.messages[0].content;

    const coldLines = cold.split("\n").filter((l) => l.trim().startsWith("- "));
    const duplicated = coldLines.filter((l) => prompt.includes(l.trim()));

    for (const line of duplicated) {
      assert.match(line, /Contains/, `"${line.trim()}" is duplicated but carries no allergen information`);
    }
  });
});

/* ---------- 6.6–6.7  manifest and threshold ------------------------------- */

describe("scope manifest and threshold", () => {
  test("6.6 the manifest covers hot and cold topics alike", () => {
    const prompt = promptOf(build());

    assert.match(prompt, /- opening hours/, "hot topic");
    assert.match(prompt, /- menu highlights and prices/, "cold topic — the assistant must know it can look this up");
    assert.match(prompt, /- dress code/, "alias still applies");
  });

  test("6.7 the threshold now guards the hot core, not the whole corpus", () => {
    assert.throws(
      () => build({ kbConfig: { grounding: { mode: "hybrid", hotThresholdTokens: 10 } } }),
      /threshold/i
    );
  });

  test("6.7b reports hot and cold sizes separately", () => {
    const { stats } = build();

    assert.ok(stats.hotTokens > 0);
    assert.ok(stats.coldTokens > 0);
    assert.equal(stats.thresholdTokens, 600);
  });
});
