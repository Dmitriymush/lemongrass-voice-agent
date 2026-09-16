import { encode } from "gpt-tokenizer";

/**
 * Vapi evaluates this at call time, not at build time. The assistant is deployed
 * once and answers calls for weeks — a baked-in date would rot immediately.
 */
const CURRENT_DATE_EXPR = '{{"now" | date: "%A, %B %d, %Y", "America/New_York"}}';

/** First meaningful term of a not-covered entry, used to check it really is absent. */
function leadingTerm(entry) {
  return entry.split(/,|\bor\b/)[0].trim().toLowerCase();
}

/**
 * Assembles the deployable Vapi assistant from its sources.
 *
 * Pure: every input is passed in, nothing is read from disk. `readKbFile` resolves
 * a name from `kbConfig.sources` to its contents.
 *
 * Throws rather than warns. A build that silently produces a subtly wrong assistant
 * is worse than one that stops — see docs/ARCHITECTURE.md §8.2.
 */
export function buildAssistant({ kbConfig, promptTemplate, summaryPrompt, assistantConfig, readKbFile }) {
  const { mode, inlineThresholdTokens } = kbConfig.grounding;
  const { hot = [], cold = [] } = kbConfig.sources;

  if (mode === "inline" && cold.length > 0) {
    throw new Error(
      `grounding.mode is "inline" but sources.cold lists ${cold.length} file(s). ` +
        `Cold sources are only reachable through retrieval — they would be silently ignored.`
    );
  }

  if (mode !== "inline") {
    throw new Error(
      `grounding.mode "${mode}" is documented but not implemented. See docs/ARCHITECTURE.md §9.5.`
    );
  }

  if (hot.length === 0) {
    throw new Error("sources.hot is empty — the assistant would have no facts at all.");
  }

  const knowledge = hot.map(readKbFile).join("\n\n").trim();

  /* -- scope manifest: generated, so it cannot drift from the facts ---------- */

  const headings = [...knowledge.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());

  if (headings.length === 0) {
    throw new Error("No '## ' headings found in the knowledge sources — cannot build a scope manifest.");
  }

  const topics = headings.map((h) => kbConfig.scope.headingAliases[h] ?? h.toLowerCase());
  const scopeManifest = topics.map((t) => `- ${t}`).join("\n");

  /* -- anti-examples: the one part that cannot be generated ------------------ */
  // They are by definition what the sources do not contain, so they are hand-written
  // — and therefore need guarding against drifting into a topic we actually cover.

  const haystack = knowledge.toLowerCase();

  for (const entry of kbConfig.scope.notCovered) {
    if (haystack.includes(leadingTerm(entry))) {
      throw new Error(
        `notCovered entry "${entry}" appears in the knowledge sources. ` +
          `Listing a covered topic as not-covered would make the assistant deny a fact it has.`
      );
    }
  }

  const notCovered = kbConfig.scope.notCovered.map((t) => `- ${t}`).join("\n");

  /* -- grounding rule: docs/ARCHITECTURE.md §4.3 ---------------------------- */

  const kbTokens = encode(knowledge).length;

  if (kbTokens > inlineThresholdTokens) {
    throw new Error(
      `Knowledge base is ${kbTokens} tokens, over the ${inlineThresholdTokens}-token inline threshold. ` +
        `Inline grounding is no longer the cheaper option at this size. ` +
        `See docs/ARCHITECTURE.md §9 and pick a grounding mode deliberately.`
    );
  }

  /* -- render ---------------------------------------------------------------- */

  const systemPrompt = promptTemplate
    .replace("{{KNOWLEDGE_BASE}}", knowledge)
    .replace("{{SCOPE_MANIFEST}}", scopeManifest)
    .replace("{{NOT_COVERED}}", notCovered)
    .replace("{{CURRENT_DATE}}", CURRENT_DATE_EXPR);

  const leftover = systemPrompt.match(/\{\{[A-Z_]+\}\}/g);
  if (leftover) {
    throw new Error(`Unsubstituted marker(s) left in the system prompt: ${[...new Set(leftover)].join(", ")}`);
  }

  const assistant = assistantConfig;
  assistant.model.messages[0].content = systemPrompt;
  assistant.analysisPlan.summaryPlan.messages[0].content = summaryPrompt;

  return {
    assistant,
    stats: {
      sources: hot.length,
      sections: headings.length,
      kbTokens,
      thresholdTokens: inlineThresholdTokens,
      promptTokens: encode(systemPrompt).length,
    },
  };
}
