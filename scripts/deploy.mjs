#!/usr/bin/env node
/**
 * CLI wrapper: reads the built assistant and the recorded resource state, deploys,
 * persists the state only on success. All logic lives in lib/deploy-assistant.mjs.
 *
 * Requires VAPI_API_KEY and VAPI_ASSISTANT_ID in the environment.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { deploy } from "./lib/deploy-assistant.mjs";

const at = (p) => new URL(`../${p}`, import.meta.url);
const read = (p) => readFileSync(at(p), "utf8");

const STATE_PATH = "state/resources.json";

if (!existsSync(at("build/assistant.rendered.json"))) {
  console.error("build/assistant.rendered.json is missing. Run `npm run build` first.");
  process.exit(1);
}

const previousState = existsSync(at(STATE_PATH)) ? JSON.parse(read(STATE_PATH)) : {};

let result;
try {
  result = await deploy({
    assistant: JSON.parse(read("build/assistant.rendered.json")),
    factSheet: read("kb/kb-fact-sheet.md"),
    env: process.env,
    state: previousState,
  });
} catch (error) {
  console.error(`Deploy failed: ${error.message}`);
  console.error("State left untouched — nothing was recorded as deployed.");
  process.exit(1);
}

const { state, actions } = result;

mkdirSync(at("state"), { recursive: true });
writeFileSync(at(STATE_PATH), JSON.stringify(state, null, 2) + "\n");

for (const action of actions) console.log(`  ${action}`);

if (actions.includes("upload-fact-sheet")) {
  console.log(`\n${STATE_PATH} changed (new file id ${state.factSheetFileId}) — commit it.`);
}

console.log(`\nDeployed to assistant ${process.env.VAPI_ASSISTANT_ID}`);
