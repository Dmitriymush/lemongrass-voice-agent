import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { deploy } from "../scripts/lib/deploy-assistant.mjs";

/* ---------- harness ------------------------------------------------------- */

const ASSISTANT_ID = "asst_fixed_id";
const COLD = "## Menu highlights and prices\n\n- Green curry: 21 dollars\n";

function validAssistant() {
  return {
    name: "Someone — Lemongrass Kitchen (inbound)",
    model: {
      provider: "openai",
      model: "gpt-4.1-mini",
      messages: [{ role: "system", content: "You are the assistant." }],
      tools: [
        { type: "endCall" },
        {
          type: "query",
          messages: [{ type: "request-start", content: "Let me check the menu for you." }],
          knowledgeBases: [
            { provider: "google", name: "menu", description: "Dishes, prices and descriptions.", fileIds: [] },
          ],
        },
      ],
    },
    voice: {
      provider: "vapi",
      voiceId: "Elliot",
      chunkPlan: { enabled: true, formatPlan: { formattersEnabled: ["phoneNumber"] } },
    },
    stopSpeakingPlan: { numWords: 0, voiceSeconds: 0.2, backoffSeconds: 1 },
    silenceTimeoutSeconds: 30,
    maxDurationSeconds: 600,
    analysisPlan: {
      summaryPlan: { enabled: true, messages: [{ role: "system", content: "Summarise." }] },
      structuredDataPlan: {
        schema: {
          properties: { guestName: {}, phoneNumber: {}, partySize: {}, date: {}, time: {}, notes: {} },
        },
      },
    },
  };
}

/**
 * Records every request. `routes` maps "METHOD /path-fragment" to a response or a
 * function; `fileStatuses` drives what successive GET /file/:id polls return.
 */
function mockFetch({ routes = {}, fileStatuses = ["done"], serverExtras = null } = {}) {
  const calls = [];
  let poll = 0;

  const fn = async (url, options = {}) => {
    const method = options.method ?? "GET";
    calls.push({ method, url, body: options.body });

    const key = Object.keys(routes).find((k) => {
      const [m, frag] = k.split(" ");
      return m === method && url.includes(frag);
    });
    if (routes[key]) return typeof routes[key] === "function" ? routes[key]() : routes[key];

    if (method === "GET" && url.includes("/assistant/")) {
      const last = calls.filter((c) => c.method === "PATCH" && c.url.includes("/assistant/")).at(-1);
      const stored = { ...(last ? JSON.parse(last.body) : {}), ...(serverExtras ?? {}) };
      return { ok: true, status: 200, json: async () => stored };
    }
    if (method === "GET" && url.includes("/file/")) {
      const status = fileStatuses[Math.min(poll++, fileStatuses.length - 1)];
      return { ok: true, status: 200, json: async () => ({ id: "file_abc", status }) };
    }
    if (method === "POST" && url.endsWith("/file")) {
      return { ok: true, status: 201, json: async () => ({ id: "file_abc", status: "processing" }) };
    }
    return { ok: true, status: 200, json: async () => ({ id: "ok" }) };
  };

  fn.calls = calls;
  return fn;
}

const run = (o = {}) =>
  deploy({
    assistant: o.assistant ?? validAssistant(),
    cold: o.cold ?? COLD,
    env: o.env ?? { VAPI_API_KEY: "key_123", VAPI_ASSISTANT_ID: ASSISTANT_ID },
    state: o.state ?? {},
    fetch: o.fetch ?? mockFetch(),
    pollIntervalMs: 0,
  });

const patchBody = (fetch) =>
  JSON.parse(fetch.calls.find((c) => c.method === "PATCH" && c.url.includes("/assistant/")).body);

/* ---------- 3.1–3.2  preconditions and targeting -------------------------- */

describe("targeting", () => {
  test("3.1 patches the pinned assistant and never creates a new one", async () => {
    const fetch = mockFetch();
    await run({ fetch });

    const patch = fetch.calls.find((c) => c.method === "PATCH" && c.url.includes("/assistant/"));
    assert.ok(patch?.url.endsWith(`/assistant/${ASSISTANT_ID}`));

    assert.equal(
      fetch.calls.find((c) => c.method === "POST" && /\/assistant\/?$/.test(c.url)),
      undefined,
      "the org is shared — creating assistants would litter it with duplicates"
    );
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
    assistant.name = "REPLACE_WITH_YOUR_FIRST_NAME — x";

    await assert.rejects(() => run({ assistant, fetch }), /placeholder/i);
    assert.equal(fetch.calls.length, 0, "validation must happen before any request");
  });
});

/* ---------- 7.4, 7.6–7.7  the cold document ------------------------------- */

describe("knowledge base upload", () => {
  test("7.4 uploads the cold document before patching the assistant", async () => {
    const fetch = mockFetch();
    await run({ fetch });

    const upload = fetch.calls.findIndex((c) => c.method === "POST" && c.url.endsWith("/file"));
    const patch = fetch.calls.findIndex((c) => c.method === "PATCH" && c.url.includes("/assistant/"));

    assert.ok(upload !== -1 && patch !== -1);
    assert.ok(upload < patch, "the assistant would otherwise reference a file id that does not exist yet");
  });

  test("7.7 injects the uploaded file id into the query tool", async () => {
    const fetch = mockFetch();
    await run({ fetch });

    const query = patchBody(fetch).model.tools.find((t) => t.type === "query");
    assert.deepEqual(query.knowledgeBases[0].fileIds, ["file_abc"]);
  });

  test("7.6 re-deploying unchanged content uploads nothing and keeps the file id", async () => {
    const first = await run({ fetch: mockFetch() });

    const fetch = mockFetch();
    const second = await run({ state: first.state, fetch });

    assert.equal(
      fetch.calls.filter((c) => c.method === "POST" && c.url.endsWith("/file")).length,
      0,
      "Vapi files are immutable — re-uploading would litter the org with orphans"
    );
    assert.equal(patchBody(fetch).model.tools.find((t) => t.type === "query").knowledgeBases[0].fileIds[0], "file_abc");
    assert.ok(second.actions.includes("patch-assistant"));
  });

  test("7.6b re-uploads once the menu actually changes", async () => {
    const first = await run({ fetch: mockFetch() });

    const fetch = mockFetch({ routes: { "POST /file": { ok: true, status: 201, json: async () => ({ id: "file_def" }) } } });
    const second = await run({ state: first.state, cold: COLD + "- Mango sticky rice: 9 dollars\n", fetch });

    assert.ok(second.actions.includes("upload-knowledge-base"));
    assert.equal(second.state.coldFileId, "file_def");
    assert.notEqual(second.state.coldHash, first.state.coldHash);
  });
});

/* ---------- 7.8  file processing ------------------------------------------ */

describe("file processing", () => {
  test("7.8 waits for the upload to finish processing before patching", async () => {
    const fetch = mockFetch({ fileStatuses: ["processing", "processing", "done"] });
    await run({ fetch });

    const polls = fetch.calls.filter((c) => c.method === "GET" && c.url.includes("/file/"));
    const patch = fetch.calls.findIndex((c) => c.method === "PATCH" && c.url.includes("/assistant/"));

    assert.ok(polls.length >= 3, "a file still processing is not yet queryable");
    assert.ok(fetch.calls.indexOf(polls.at(-1)) < patch);
  });

  test("7.8b fails loudly when Vapi cannot process the file", async () => {
    const fetch = mockFetch({ fileStatuses: ["failed"] });

    await assert.rejects(
      () => run({ fetch }),
      /failed/i,
      "an unprocessed file leaves the assistant with a knowledge base that silently returns nothing"
    );

    assert.equal(
      fetch.calls.find((c) => c.method === "PATCH" && c.url.includes("/assistant/")),
      undefined,
      "nothing should be patched to point at a file that will never answer"
    );
  });

  test("7.8c uploads as text/plain — Vapi's pipeline rejects text/markdown", async () => {
    const fetch = mockFetch();
    await run({ fetch });

    const upload = fetch.calls.find((c) => c.method === "POST" && c.url.endsWith("/file"));
    const file = upload.body.get("file");

    assert.equal(file.type, "text/plain");
    assert.match(file.name ?? "", /\.txt$/);
  });
});

/* ---------- 3.4, 7.5  failure handling ------------------------------------ */

describe("failure handling", () => {
  test("7.5 does not patch the assistant when the upload fails", async () => {
    const fetch = mockFetch({
      routes: { "POST /file": { ok: false, status: 500, text: async () => "storage unavailable" } },
    });

    await assert.rejects(() => run({ fetch }), /500|storage unavailable/);
    assert.equal(fetch.calls.find((c) => c.method === "PATCH"), undefined);
  });

  test("3.4 surfaces an API failure instead of reporting success", async () => {
    const fetch = mockFetch({
      routes: { "PATCH /assistant/": { ok: false, status: 422, text: async () => "invalid voice provider" } },
    });

    await assert.rejects(() => run({ fetch }), /422|invalid voice provider/);
  });

  test("3.4b does not return a state claiming deployment after a failure", async () => {
    const fetch = mockFetch({
      routes: { "PATCH /assistant/": { ok: false, status: 500, text: async () => "upstream error" } },
    });

    await assert.rejects(async () => {
      const { state } = await run({ fetch });
      assert.fail(`deploy resolved with state ${JSON.stringify(state)} despite a 500`);
    });
  });
});

/* ---------- 7.9–7.10  PATCH is partial ------------------------------------ */

describe("drift between the repository and the deployed assistant", () => {
  test("7.9 explicitly clears fields that were removed from the config", async () => {
    const fetch = mockFetch();
    await run({ fetch });

    const body = patchBody(fetch);

    assert.ok(
      "endCallPhrases" in body,
      "PATCH is a partial update: dropping a field from the repository leaves the old value live forever, " +
        "so removal has to be sent as an explicit null"
    );
    assert.equal(body.endCallPhrases, null);
  });

  test("7.10 reads the assistant back and holds the server state to the same contract", async () => {
    // Vapi kept a field the repository no longer sets — exactly what a partial
    // update does when an earlier deploy set it.
    const fetch = mockFetch({ serverExtras: { endCallPhrases: ["goodbye", "have a good evening"] } });

    await assert.rejects(
      () => run({ fetch }),
      /endCallPhrases/,
      "a deploy that reports success while the live assistant violates the contract is worse than a failed one"
    );
  });

  test("7.10b a clean read-back passes", async () => {
    const fetch = mockFetch();
    const { actions } = await run({ fetch });

    assert.ok(actions.includes("verify-deployed"));
    assert.ok(fetch.calls.some((c) => c.method === "GET" && c.url.includes("/assistant/")));
  });
});

/* ---------- 7.11  state is scoped to one assistant ------------------------ */

describe("state scoping", () => {
  test("7.11 does not reuse a file id recorded against a different assistant", async () => {
    const first = await run({ fetch: mockFetch() });
    assert.equal(first.state.assistantId, ASSISTANT_ID, "state must record what it belongs to");

    // Same content, different assistant — typically a different Vapi org, where that
    // file id does not exist. Reusing it wires the assistant to nothing.
    const fetch = mockFetch({ routes: { "POST /file": { ok: true, status: 201, json: async () => ({ id: "file_other_org" }) } } });
    const second = await run({
      state: first.state,
      env: { VAPI_API_KEY: "key_123", VAPI_ASSISTANT_ID: "asst_in_another_org" },
      fetch,
    });

    assert.ok(second.actions.includes("upload-knowledge-base"), "content hash alone must not authorise reuse across orgs");
    assert.equal(second.state.coldFileId, "file_other_org");
  });
});
