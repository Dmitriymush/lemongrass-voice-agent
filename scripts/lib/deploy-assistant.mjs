import { createHash } from "node:crypto";

import { assertDeployable, assertKnowledgeBaseWired, validateAssistant } from "./validate-assistant.mjs";

/**
 * PATCH is a partial update: a field simply dropped from the repository keeps its
 * old value on the assistant forever. Removal has to be sent as an explicit null.
 */
const CLEARED_FIELDS = { endCallPhrases: null };

const API = "https://api.vapi.ai";

/** Vapi's file pipeline rejects text/markdown — byte-identical text/plain succeeds. */
const COLD_FILENAME = "kb-cold.txt";
const COLD_MIMETYPE = "text/plain";

const POLL_ATTEMPTS = 30;

/**
 * Pushes the built assistant and its knowledge base to Vapi.
 *
 * Two resources with one dependency between them: the cold document must exist and
 * have finished processing before the assistant can reference its id. Everything
 * else is idempotent —
 *
 *   - the assistant is PATCHed by pinned id, never created. The sandbox org is
 *     shared, and a stray POST leaves a duplicate for someone else to clean up.
 *   - Vapi files are immutable (PATCH /file only renames), so the menu is
 *     re-uploaded solely when its content hash changes. Without that check every
 *     deploy adds another copy while the assistant still points at the old id.
 *
 * `state` is the previous contents of state/resources.json; the caller persists the
 * returned state only on success, so a failed deploy never records itself as done.
 */
export async function deploy({ assistant, cold, env, state = {}, fetch: fetchImpl = fetch, pollIntervalMs = 2000 }) {
  const apiKey = env.VAPI_API_KEY;
  const assistantId = env.VAPI_ASSISTANT_ID;

  if (!apiKey) throw new Error("VAPI_API_KEY is not set. Deploy needs a key with write access to the sandbox org.");
  if (!assistantId) {
    throw new Error(
      "VAPI_ASSISTANT_ID is not set. The assistant is patched by a pinned id — create it once, then record the id."
    );
  }

  // Before any network call: a placeholder must never reach a shared org.
  assertDeployable(assistant);

  const headers = { Authorization: `Bearer ${apiKey}` };
  const actions = [];
  const next = { ...state };

  /* -- the knowledge base ---------------------------------------------------- */

  const hash = createHash("sha256").update(cold).digest("hex");

  if (hash !== state.coldHash || !state.coldFileId) {
    const form = new FormData();
    form.append("file", new File([cold], COLD_FILENAME, { type: COLD_MIMETYPE }));

    const res = await fetchImpl(`${API}/file`, { method: "POST", headers, body: form });
    if (!res.ok) throw new Error(`POST /file failed: ${res.status} ${await res.text()}`);

    const fileId = (await res.json()).id;

    // An upload that has not finished processing is not queryable, and one that
    // failed answers nothing at all — silently, on a live call. Wait for a verdict.
    await waitUntilProcessed({ fetchImpl, headers, fileId, pollIntervalMs });

    next.coldFileId = fileId;
    next.coldHash = hash;
    actions.push("upload-knowledge-base");
  }

  /* -- the assistant --------------------------------------------------------- */

  const queryTool = assistant.model.tools.find((t) => t.type === "query");
  if (!queryTool) throw new Error("The built assistant has no query tool — the cold half would be unreachable.");

  queryTool.knowledgeBases[0].fileIds = [next.coldFileId];
  assertKnowledgeBaseWired(assistant);

  const res = await fetchImpl(`${API}/assistant/${assistantId}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ ...assistant, ...CLEARED_FIELDS }),
  });

  if (!res.ok) throw new Error(`PATCH /assistant/${assistantId} failed: ${res.status} ${await res.text()}`);

  actions.push("patch-assistant");

  // Read back and hold the server state to the same contract as the artefact. The
  // repository is only the source of truth if what Vapi actually stored matches it;
  // reporting success without looking is how drift survives for months.
  const check = await fetchImpl(`${API}/assistant/${assistantId}`, { headers });
  if (!check.ok) throw new Error(`GET /assistant/${assistantId} failed after deploy: ${check.status}`);

  validateAssistant(await check.json());
  actions.push("verify-deployed");
  next.deployedAt = new Date().toISOString();

  return { state: next, actions };
}

async function waitUntilProcessed({ fetchImpl, headers, fileId, pollIntervalMs }) {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const res = await fetchImpl(`${API}/file/${fileId}`, { headers });
    if (!res.ok) throw new Error(`GET /file/${fileId} failed: ${res.status}`);

    const { status } = await res.json();

    if (status === "done") return;
    if (status === "failed") {
      throw new Error(
        `Vapi failed to process ${fileId}. The assistant would have a knowledge base that answers nothing. ` +
          `Check the upload is ${COLD_MIMETYPE} — the pipeline rejects text/markdown.`
      );
    }

    if (pollIntervalMs > 0) await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error(`File ${fileId} was still processing after ${POLL_ATTEMPTS} checks; refusing to deploy against it.`);
}
