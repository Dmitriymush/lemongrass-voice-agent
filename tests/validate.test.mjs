import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { validateAssistant, assertDeployable } from "../scripts/lib/validate-assistant.mjs";
import { buildAssistant } from "../scripts/lib/build-assistant.mjs";

/* ---------- fixtures ------------------------------------------------------ */

/** A structurally valid assistant. Each test breaks exactly one thing. */
function validAssistant() {
  return {
    name: "Someone — Lemongrass Kitchen (inbound)",
    firstMessage: "Lemongrass Kitchen, this is the front desk. How can I help?",
    model: {
      provider: "openai",
      model: "gpt-4.1-mini",
      messages: [{ role: "system", content: "You are the assistant." }],
      tools: [{ type: "endCall" }],
    },
    voice: {
      provider: "11labs",
      voiceId: "abc123",
      chunkPlan: { enabled: true, formatPlan: { formattersEnabled: ["phoneNumber", "dollarAmount"] } },
    },
    stopSpeakingPlan: { numWords: 0, voiceSeconds: 0.2, backoffSeconds: 1 },
    silenceTimeoutSeconds: 30,
    maxDurationSeconds: 600,
    analysisPlan: {
      summaryPlan: { enabled: true, messages: [{ role: "system", content: "Summarise." }] },
      structuredDataPlan: {
        enabled: true,
        schema: {
          type: "object",
          properties: {
            reservationRequested: { type: "boolean" },
            guestName: { type: "string" },
            phoneNumber: { type: "string" },
            partySize: { type: "number" },
            date: { type: "string" },
            time: { type: "string" },
            notes: { type: "string" },
          },
        },
      },
    },
  };
}

/** Applies a mutation to the valid fixture and returns it. */
function broken(mutate) {
  const a = validAssistant();
  mutate(a);
  return a;
}

/* ---------- 2.1  call hygiene --------------------------------------------- */

describe("call hygiene", () => {
  test("2.1 requires a silence timeout — the reviewer reads this field", () => {
    assert.throws(() => validateAssistant(broken((a) => delete a.silenceTimeoutSeconds)), /silenceTimeoutSeconds/);
  });

  test("2.1b requires a maximum duration", () => {
    assert.throws(() => validateAssistant(broken((a) => delete a.maxDurationSeconds)), /maxDurationSeconds/);
  });

  test("2.1c rejects a silence timeout long enough to feel like a dead line", () => {
    assert.throws(() => validateAssistant(broken((a) => (a.silenceTimeoutSeconds = 300))), /silenceTimeoutSeconds/);
  });

  test("2.1d rejects an unbounded call duration", () => {
    assert.throws(() => validateAssistant(broken((a) => (a.maxDurationSeconds = 36000))), /maxDurationSeconds/);
  });

  test("2.2 requires the endCall tool — the assistant must be able to hang up", () => {
    assert.throws(() => validateAssistant(broken((a) => (a.model.tools = []))), /endCall/);
  });
});

/* ---------- 2.3–2.4  end-of-call capture ---------------------------------- */

describe("end-of-call capture", () => {
  test("2.3 requires the summary plan to be enabled", () => {
    assert.throws(
      () => validateAssistant(broken((a) => (a.analysisPlan.summaryPlan.enabled = false))),
      /summaryPlan/
    );
  });

  test("2.3b rejects an unsubstituted summary prompt", () => {
    assert.throws(
      () => validateAssistant(broken((a) => (a.analysisPlan.summaryPlan.messages[0].content = "{{SUMMARY_PROMPT}}"))),
      /SUMMARY_PROMPT/
    );
  });

  test("2.4 requires every reservation field in the structured data schema", () => {
    for (const field of ["guestName", "phoneNumber", "partySize", "date", "time", "notes"]) {
      assert.throws(
        () => validateAssistant(broken((a) => delete a.analysisPlan.structuredDataPlan.schema.properties[field])),
        new RegExp(field),
        `dropping ${field} must fail validation`
      );
    }
  });
});

/* ---------- 2.5–2.6  speech layer ----------------------------------------- */

describe("speech layer", () => {
  test("2.5 requires the phoneNumber formatter — digit-by-digit readback depends on it", () => {
    assert.throws(
      () => validateAssistant(broken((a) => (a.voice.chunkPlan.formatPlan.formattersEnabled = ["dollarAmount"]))),
      /phoneNumber/
    );
  });

  test("2.6 requires VAD interruption rather than waiting for transcribed words", () => {
    assert.throws(() => validateAssistant(broken((a) => (a.stopSpeakingPlan.numWords = 3))), /numWords/);
  });
});

/* ---------- 2.7  payload hygiene ------------------------------------------ */

describe("payload hygiene", () => {
  test("2.7 rejects build metadata leaking into the Vapi payload", () => {
    assert.throws(() => validateAssistant(broken((a) => (a.grounding = { mode: "inline" }))), /grounding/);
    assert.throws(() => validateAssistant(broken((a) => (a.sources = { hot: [] }))), /sources/);
  });

  test("2.7b accepts the valid fixture unchanged", () => {
    assert.doesNotThrow(() => validateAssistant(validAssistant()));
  });
});

/* ---------- 2.8  deploy gate ---------------------------------------------- */

describe("deploy gate", () => {
  test("2.8 refuses to deploy an assistant still carrying a REPLACE_ placeholder", () => {
    assert.throws(() => assertDeployable(broken((a) => (a.voice.voiceId = "REPLACE_AFTER_VOICE_SELECTION"))), /voiceId/);
    assert.throws(() => assertDeployable(broken((a) => (a.name = "REPLACE_WITH_YOUR_NAME — X"))), /name/);
  });

  test("2.8b allows a fully filled assistant through", () => {
    assert.doesNotThrow(() => assertDeployable(validAssistant()));
  });
});

/* ---------- 2.9  the real artifact ---------------------------------------- */

describe("the real build output", () => {
  test("2.9 satisfies the contract", () => {
    const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

    const kbConfig = JSON.parse(read("kb/kb.config.json"));

    const { assistant } = buildAssistant({
      kbConfig,
      routing: JSON.parse(read("kb/routing.json")),
      sourceFiles: kbConfig.sources,
      promptTemplate: read("prompt/system-prompt.md"),
      summaryPrompt: read("prompt/summary-prompt.md").trim(),
      assistantConfig: JSON.parse(read("assistant.config.json")),
      readKbFile: (name) => read(`kb/${name}`),
    });

    assert.doesNotThrow(() => validateAssistant(assistant));
  });
});
