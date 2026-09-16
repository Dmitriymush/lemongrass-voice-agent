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

/** Splits a markdown document into its `## ` sections, heading line included. */
function parseSections(markdown) {
  const found = [];
  const re = /^##\s+(.+)$/gm;

  let match;
  let open = null;

  while ((match = re.exec(markdown)) !== null) {
    if (open) found.push({ ...open, end: match.index });
    open = { title: match[1].trim(), start: match.index };
  }
  if (open) found.push({ ...open, end: markdown.length });

  return found.map(({ title, start, end }) => ({ title, text: markdown.slice(start, end).trim() }));
}

/**
 * Assembles the deployable Vapi assistant and the document that backs its knowledge base.
 *
 * The fact sheet is never edited. It is split at build time by declarative rules
 * (kb/routing.json) into:
 *
 *   HOT  — inlined into the system prompt: asked in most calls, or costly to get
 *          wrong, or behaviour rather than fact
 *   COLD — written out for upload to Vapi and reached through the query tool:
 *          grows with the business, and a miss is merely inconvenient
 *
 * Allergen lines are lifted verbatim out of cold sections into the hot prompt. Missing
 * a price is an inconvenience; missing "does the pad thai contain peanuts" is an
 * incident, and data whose error has a health cost does not belong behind a
 * probabilistic lookup. See docs/ARCHITECTURE.md §4.3.
 *
 * Throws rather than warns: a build that silently ships a subtly wrong assistant is
 * worse than one that stops.
 */
export function buildAssistant({
  kbConfig,
  routing,
  sourceFiles,
  promptTemplate,
  summaryPrompt,
  assistantConfig,
  readKbFile,
}) {
  const { mode, hotThresholdTokens } = kbConfig.grounding;

  if (mode !== "hybrid") {
    throw new Error(
      `grounding.mode "${mode}" is not implemented. Inline-only grounding was superseded — see docs/ARCHITECTURE.md §5 (ADR-001).`
    );
  }

  if (!sourceFiles?.length) throw new Error("No knowledge sources listed — the assistant would have no facts at all.");

  const knowledge = sourceFiles.map(readKbFile).join("\n\n").trim();
  const sections = parseSections(knowledge);

  if (sections.length === 0) {
    throw new Error("No '## ' headings found in the knowledge sources — nothing to route.");
  }

  /* -- routing --------------------------------------------------------------- */
  // An unrouted section is a new part of the fact sheet nobody classified. Defaulting
  // it either way is a silent decision about whether guests can be told about it.

  const hot = [];
  const cold = [];

  for (const section of sections) {
    const destination = routing.sections[section.title];

    if (destination === undefined) {
      throw new Error(
        `Section "${section.title}" is not in kb/routing.json. Classify it as "hot" or "cold" — see docs/ARCHITECTURE.md §4.2.`
      );
    }
    if (destination !== "hot" && destination !== "cold") {
      throw new Error(`Section "${section.title}" is routed to "${destination}"; only "hot" and "cold" exist.`);
    }

    (destination === "hot" ? hot : cold).push(section);
  }

  const hotText = hot.map((s) => s.text).join("\n\n");
  const coldText = cold.map((s) => s.text).join("\n\n");

  /* -- allergen matrix ------------------------------------------------------- */
  // Copied as-is, price and all. A tidier extraction would eventually cut the wrong
  // part of a line, and the failure would be silent and unsafe.

  const marker = routing.extractToHot.matching;
  const allergenMatrix = coldText
    .split("\n")
    .filter((line) => line.includes(marker))
    .join("\n");

  /* -- scope manifest -------------------------------------------------------- */
  // Generated from every section, hot and cold alike: the assistant must know which
  // topics it can look up, not only the ones it already holds.

  const topics = sections.map((s) => routing.headingAliases?.[s.title] ?? kbConfig.scope.headingAliases[s.title] ?? s.title.toLowerCase());
  const scopeManifest = topics.map((t) => `- ${t}`).join("\n");

  // Anti-examples cannot be generated — they are by definition what the sources do
  // not contain — so they are hand-written and need guarding against drift.
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

  /* -- threshold on the hot core -------------------------------------------- */

  const hotTokens = encode(`${hotText}\n${allergenMatrix}`).length;

  if (hotTokens > hotThresholdTokens) {
    throw new Error(
      `Hot core is ${hotTokens} tokens, over the ${hotThresholdTokens}-token threshold. ` +
        `It is carried on every turn of every call. Move something to cold — see docs/ARCHITECTURE.md §10.`
    );
  }

  /* -- render ---------------------------------------------------------------- */

  const systemPrompt = promptTemplate
    .replace("{{HOT_KNOWLEDGE}}", hotText)
    .replace("{{ALLERGEN_MATRIX}}", allergenMatrix)
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
    cold: coldText,
    stats: {
      sources: sourceFiles.length,
      hotSections: hot.length,
      coldSections: cold.length,
      allergenLines: allergenMatrix ? allergenMatrix.split("\n").length : 0,
      hotTokens,
      coldTokens: encode(coldText).length,
      thresholdTokens: hotThresholdTokens,
      promptTokens: encode(systemPrompt).length,
    },
  };
}
