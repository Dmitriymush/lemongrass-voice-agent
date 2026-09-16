#!/usr/bin/env node
/**
 * Runs the reviewer's two conversations against the deployed assistant through the
 * Chat API and reports every guardrail violation.
 *
 * Text, not voice: same prompt and same model, but no STT or TTS. That makes the
 * run cheap, deterministic and fast, and it covers the whole of the guardrail logic.
 * The speech layer — endpointing, interruption, digit pronunciation — is verified by
 * hand through the dashboard; automating it does not pay for itself at this size.
 *
 * Costs sandbox credits. See docs/ARCHITECTURE.md §8.4 for when CI is allowed to run it.
 *
 * Requires VAPI_API_KEY and VAPI_ASSISTANT_ID.
 */

import { SCENARIOS, runScenario } from "./lib/scenarios.mjs";

const { VAPI_API_KEY, VAPI_ASSISTANT_ID } = process.env;

if (!VAPI_API_KEY || !VAPI_ASSISTANT_ID) {
  console.error("VAPI_API_KEY and VAPI_ASSISTANT_ID must both be set.");
  process.exit(1);
}

/** One Chat session per scenario; previousChatId threads the turns together. */
function chatSession() {
  let previousChatId;

  return async (input) => {
    const res = await fetch("https://api.vapi.ai/chat", {
      method: "POST",
      headers: { Authorization: `Bearer ${VAPI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ assistantId: VAPI_ASSISTANT_ID, input, ...(previousChatId && { previousChatId }) }),
    });

    if (!res.ok) throw new Error(`POST /chat failed: ${res.status} ${await res.text()}`);

    const chat = await res.json();
    previousChatId = chat.id;

    const reply = chat.output?.map((m) => m.content).filter(Boolean).join(" ") ?? "";
    if (!reply) throw new Error(`No assistant text in response: ${JSON.stringify(chat).slice(0, 400)}`);

    return reply;
  };
}

const verbose = process.argv.includes("--verbose");
let failed = 0;

for (const scenario of SCENARIOS) {
  const started = Date.now();
  const { failures, transcript } = await runScenario(scenario, chatSession());
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  if (failures.length === 0) {
    console.log(`PASS  ${scenario.id}  (${scenario.turns.length} turns, ${seconds}s)`);
  } else {
    failed += failures.length;
    console.log(`FAIL  ${scenario.id}  (${failures.length} violation(s), ${seconds}s)`);

    for (const f of failures) {
      console.log(`\n  turn ${f.turn} — ${f.check}`);
      console.log(`  ${f.reason}`);
      if (f.reply) console.log(`  reply: "${f.reply}"`);
    }
    console.log();
  }

  if (verbose) console.log(transcript.map((l) => `    ${l}`).join("\n") + "\n");
}

if (failed > 0) {
  console.error(`\n${failed} violation(s). The assistant is not ready to hand in.`);
  process.exit(1);
}

console.log("\nBoth scenarios pass.");
