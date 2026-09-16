#!/usr/bin/env node
/**
 * CLI wrapper: reads the sources from disk, builds, writes the deployable config.
 * All logic lives in lib/build-assistant.mjs so it can be tested without a filesystem.
 *
 *   kb/kb-fact-sheet.md   (untouched original — the only source of restaurant facts)
 *   kb/kb.config.json     (grounding rule, source list, scope manifest inputs)
 *   prompt/*.md           (templates with {{MARKERS}})
 *   assistant.config.json (Vapi config with prompt placeholders)
 *        -> build/assistant.rendered.json
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { buildAssistant } from "./lib/build-assistant.mjs";

const at = (p) => new URL(`../${p}`, import.meta.url);
const read = (p) => readFileSync(at(p), "utf8");

const { assistant, stats } = buildAssistant({
  kbConfig: JSON.parse(read("kb/kb.config.json")),
  promptTemplate: read("prompt/system-prompt.md"),
  summaryPrompt: read("prompt/summary-prompt.md").trim(),
  assistantConfig: JSON.parse(read("assistant.config.json")),
  readKbFile: (name) => read(`kb/${name}`),
});

mkdirSync(at("build"), { recursive: true });
writeFileSync(at("build/assistant.rendered.json"), JSON.stringify(assistant, null, 2) + "\n");

console.log(
  `KB: ${stats.sources} source(s), ${stats.sections} sections, ` +
    `${stats.kbTokens} tokens (threshold ${stats.thresholdTokens})`
);
console.log(`Prompt: ${stats.promptTokens} tokens`);
console.log("Wrote build/assistant.rendered.json");
