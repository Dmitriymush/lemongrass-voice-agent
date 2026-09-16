#!/usr/bin/env node
/**
 * CLI wrapper: reads the sources from disk, splits and builds, writes both artefacts.
 * All logic lives in lib/build-assistant.mjs so it can be tested without a filesystem.
 *
 *   kb/kb-fact-sheet.md   (untouched original — the only source of restaurant facts)
 *   kb/routing.json       (which sections are hot, which are cold)
 *   kb/kb.config.json     (grounding mode, threshold, scope manifest inputs)
 *   prompt/*.md           (templates with {{MARKERS}})
 *   assistant.config.json (Vapi config with prompt placeholders)
 *        -> build/assistant.rendered.json   the assistant, hot core inlined
 *        -> build/kb-cold.md                the document uploaded to the knowledge base
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { buildAssistant } from "./lib/build-assistant.mjs";
import { validateAssistant } from "./lib/validate-assistant.mjs";

const at = (p) => new URL(`../${p}`, import.meta.url);
const read = (p) => readFileSync(at(p), "utf8");

const kbConfig = JSON.parse(read("kb/kb.config.json"));

const { assistant, cold, stats } = buildAssistant({
  kbConfig,
  routing: JSON.parse(read("kb/routing.json")),
  sourceFiles: kbConfig.sources,
  promptTemplate: read("prompt/system-prompt.md"),
  summaryPrompt: read("prompt/summary-prompt.md").trim(),
  assistantConfig: JSON.parse(read("assistant.config.json")),
  readKbFile: (name) => read(`kb/${name}`),
});

// Structural contract. The placeholder gate (assertDeployable) runs at deploy time
// instead, so a working tree without a chosen voice still builds.
validateAssistant(assistant);

mkdirSync(at("build"), { recursive: true });
writeFileSync(at("build/assistant.rendered.json"), JSON.stringify(assistant, null, 2) + "\n");
writeFileSync(at("build/kb-cold.md"), cold + "\n");

console.log(
  `HOT  ${stats.hotSections} sections + ${stats.allergenLines} allergen line(s), ` +
    `${stats.hotTokens} tokens (cap ${stats.thresholdTokens})`
);
console.log(`COLD ${stats.coldSections} section(s), ${stats.coldTokens} tokens -> build/kb-cold.md`);
console.log(`Prompt: ${stats.promptTokens} tokens`);
