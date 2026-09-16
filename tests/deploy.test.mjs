import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { deploy } from "../scripts/lib/deploy-assistant.mjs";

/* ---------- harness ------------------------------------------------------- */

const ASSISTANT_ID = "asst_fixed_id";
const FACT_SHEET = "# Fact sheet\n\n## Hours\n\n- Monday: closed\n";

function validAssistant() {
  return {
    name: "Someone — Lemongrass Kitchen (inbound)",
    model: {
      provider: "openai",
      model: "gpt-4.1-mini",
      messages: [{ role: "system", content: "You are the assistant." }],
      tools: [{ type: "endCall" }],
    },
    voice: {
      provider: "11labs",
      voiceId: "abc123",
      chunkPlan: { enabled: true, formatPlan: { formattersEnabled: ["phoneNumber"] } },
    },
    stopSpeakingPlan: { numWords: 0, voiceSeconds: 0.2, backoffSeconds: 1 },
    silenceTimeoutSeconds: 30,
    maxDurationSeconds: 600,
    analysisPlan: {
      summaryPlan: { enabled: true, messages: [{ role: "system", content: "Summarise." }] },
      structuredDataPlan: {
        schema: {
          properties: {
            guestName: {}, phoneNumber: {}, partySize: {}, date: {}, time: {}, notes: {},
          },
        },
      },
    },
  };
}

/** Records every request and replies from a per-route script. */
function mockFetch(routes = {}) {
  const calls = [];

  const fn = async (url, options = {}) => {
    const method = options.method ?? "GET";
    calls.push({ method, url, body: options.body });

    const key = Object.keys(routes).find((k) => url.includes(k.split(" ")[1]) && k.startsWith(method));
    const handler = routes[key];

    if (typeof handler === "function") return handler();
    return { ok: true, status: 200, json: async () => handler ?? { id: "generated_id" } };
  };

  fn.calls = calls;
  return fn;
}

const run = (overrides = {}) =>
  deploy({
    assistant: overrides.assistant ?? validAssistant(),
    factSheet: overrides.factSheet ?? FACT_SHEET,
    env: overrides.env ?? { VAPI_API_KEY: "key_123", VAPI_ASSISTANT_ID: ASSISTANT_ID },
    state: overrides.state ?? {},
    fetch: overrides.fetch ?? mockFetch(),
  });

/* ---------- 3.1–3.2  preconditions and targeting -------------------------- */

describe("targeting", () => {
  test("3.1 patches the pinned assistant and never creates a new one", async () => {
    const fetch = mockFetch();
    await run({ fetch });

    const patch = fetch.calls.find((c) => c.method === "PATCH" && c.url.includes("/assistant/"));
    assert.ok(patch, "must PATCH the existing assistant");
    assert.ok(patch.url.endsWith(`/assistant/${ASSISTANT_ID}`));

    const created = fetch.calls.find((c) => c.method === "POST" && /\/assistant\/?$/.test(c.url));
    assert.equal(created, undefined, "the org is shared — creating assistants would litter it with duplicates");
  });

  test("3.2 fails with a clear message when the API key is missing", async () => {
    await assert.rejects(() => run({ env: { VAPI_ASSISTANT_ID: ASSISTANT_ID } }), /VAPI_API_KEY/);
  });

  test("3.2b fails when the assistant id is missing rather than guessing one", async () => {
    await assert.rejects(() => run({ env: { VAPI_API_KEY: "key_123" } }), /VAPI_ASSISTANT_ID/);
  });

  test("3.2c refuses to ship a placeholder, before touching the network", async () => {
    const fetch = mockFetch();
    const assistant = validAssistant();
    assistant.voice.voiceId = "REPLACE_AFTER_VOICE_SELECTION";

    await assert.rejects(() => run({ assistant, fetch }), /placeholder/i);
    assert.equal(fetch.calls.length, 0, "validation must happen before any request");
  });
});

/* ---------- 3.3, 3.5  idempotency ----------------------------------------- */

describe("idempotency", () => {
  test("3.5 uploads the fact sheet on a first deploy and records its hash", async () => {
    const fetch = mockFetch({ "POST /file": { id: "file_abc" } });
    const { state, actions } = await run({ fetch });

    assert.ok(actions.includes("upload-fact-sheet"));
    assert.equal(state.factSheetFileId, "file_abc");
    assert.ok(state.factSheetHash, "the hash is what makes the next deploy a no-op");
  });

  test("3.3 re-deploying unchanged content uploads nothing new", async () => {
    const first = await run({ fetch: mockFetch({ "POST /file": { id: "file_abc" } }) });

    const fetch = mockFetch();
    const second = await run({ state: first.state, fetch });

    assert.ok(!second.actions.includes("upload-fact-sheet"), "Vapi files are immutable — re-uploading would litter the org");
    assert.equal(fetch.calls.filter((c) => c.url.includes("/file")).length, 0);
    assert.equal(second.state.factSheetFileId, "file_abc", "the existing file id must survive");
    assert.ok(second.actions.includes("patch-assistant"), "the assistant is still patched — that call is idempotent");
  });

  test("3.5b re-uploads once the fact sheet actually changes", async () => {
    const first = await run({ fetch: mockFetch({ "POST /file": { id: "file_abc" } }) });

    const fetch = mockFetch({ "POST /file": { id: "file_def" } });
    const second = await run({
      state: first.state,
      factSheet: FACT_SHEET + "\n## Parking\n\n- Free after 6 pm.\n",
      fetch,
    });

    assert.ok(second.actions.includes("upload-fact-sheet"));
    assert.equal(second.state.factSheetFileId, "file_def");
    assert.notEqual(second.state.factSheetHash, first.state.factSheetHash);
  });
});

/* ---------- 3.4  failure handling ----------------------------------------- */

describe("failure handling", () => {
  test("3.4 surfaces an API failure instead of reporting success", async () => {
    const fetch = mockFetch({
      "PATCH /assistant/": () => ({ ok: false, status: 422, text: async () => "invalid voice provider" }),
    });

    await assert.rejects(() => run({ fetch }), /422|invalid voice provider/);
  });

  test("3.4b does not return a state claiming deployment after a failure", async () => {
    const fetch = mockFetch({
      "PATCH /assistant/": () => ({ ok: false, status: 500, text: async () => "upstream error" }),
    });

    await assert.rejects(async () => {
      const { state } = await run({ fetch });
      assert.fail(`deploy resolved with state ${JSON.stringify(state)} despite a 500`);
    });
  });
});
