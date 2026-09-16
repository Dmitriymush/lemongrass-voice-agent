#!/usr/bin/env node
/**
 * Confirms the credentials are loaded without ever printing them.
 *
 * Shows only length and a short prefix — enough to tell "loaded the right thing"
 * from "loaded nothing" or "pasted the public key", and not enough to leak a key
 * into a terminal transcript or a chat log.
 */

const KEYS = ["VAPI_API_KEY", "VAPI_ASSISTANT_ID"];

let missing = 0;

for (const key of KEYS) {
  const value = process.env[key];

  if (!value) {
    console.log(`  ${key.padEnd(18)} MISSING`);
    missing++;
    continue;
  }

  console.log(`  ${key.padEnd(18)} set, ${value.length} chars, starts "${value.slice(0, 4)}…"`);
}

if (missing > 0) {
  console.log(`\n${missing} value(s) missing. Create a .env file in the project root:\n`);
  console.log("  VAPI_API_KEY=<private key from Vapi dashboard, Settings -> API Keys>");
  console.log("  VAPI_ASSISTANT_ID=<id of the assistant you created once in the dashboard>\n");
  console.log(".env is gitignored. Do not paste these values into a chat or a shell command.");
  process.exit(1);
}

console.log("\nBoth values present. Note this only checks they are set, not that they are valid;");
console.log("the first deploy is what proves the key has write access.");
