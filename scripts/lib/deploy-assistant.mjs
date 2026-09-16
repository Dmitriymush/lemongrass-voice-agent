import { createHash } from "node:crypto";

import { assertDeployable } from "./validate-assistant.mjs";

const API = "https://api.vapi.ai";

/**
 * Pushes the built assistant to Vapi.
 *
 * Idempotent by construction:
 *   - the assistant is PATCHed by pinned id, never created (the sandbox org is
 *     shared, and a stray POST would leave a duplicate someone else has to clean up)
 *   - Vapi files are immutable — PATCH /file only renames — so the fact sheet is
 *     re-uploaded solely when its content hash changes. Without that check every
 *     deploy would add another copy and the old ids would still be referenced.
 *
 * `state` is the previous contents of state/resources.json; the caller persists the
 * returned state only on success, so a failed deploy never records itself as done.
 */
export async function deploy({ assistant, factSheet, env, state = {}, fetch: fetchImpl = fetch }) {
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

  /* -- fact sheet artefact --------------------------------------------------- */
  // Uploaded so the knowledge base exists in Vapi in the form the task asks for.
  // It is not wired to a query tool — grounding is inline, see docs/ARCHITECTURE.md §4.

  const hash = createHash("sha256").update(factSheet).digest("hex");

  if (hash !== state.factSheetHash || !state.factSheetFileId) {
    const form = new FormData();
    form.append("file", new Blob([factSheet], { type: "text/markdown" }), "kb-fact-sheet.md");

    const res = await fetchImpl(`${API}/file`, { method: "POST", headers, body: form });
    if (!res.ok) throw new Error(`POST /file failed: ${res.status} ${await res.text()}`);

    next.factSheetFileId = (await res.json()).id;
    next.factSheetHash = hash;
    actions.push("upload-fact-sheet");
  }

  /* -- assistant ------------------------------------------------------------- */

  const res = await fetchImpl(`${API}/assistant/${assistantId}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(assistant),
  });

  if (!res.ok) throw new Error(`PATCH /assistant/${assistantId} failed: ${res.status} ${await res.text()}`);

  actions.push("patch-assistant");
  next.deployedAt = new Date().toISOString();

  return { state: next, actions };
}
