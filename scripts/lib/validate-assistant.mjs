/**
 * Contract for the assistant payload that ships to Vapi.
 *
 * Every rule here exists because breaking it fails silently: the assistant still
 * deploys, still answers, and the defect only shows up in a live call. Ranges are
 * deliberately loose — this guards against absence and nonsense, not against tuning.
 */

const RESERVATION_FIELDS = ["guestName", "phoneNumber", "partySize", "date", "time", "notes"];

/** Keys that belong to our build, not to Vapi. Leaking them pollutes the payload. */
const BUILD_ONLY_KEYS = ["grounding", "sources", "scope"];

function fail(message) {
  throw new Error(`Assistant contract violated: ${message}`);
}

export function validateAssistant(assistant) {
  /* -- call hygiene: the reviewer reads these fields directly ---------------- */

  const silence = assistant.silenceTimeoutSeconds;
  if (typeof silence !== "number" || silence < 10 || silence > 60) {
    fail(`silenceTimeoutSeconds must be 10-60 (got ${silence}). Longer feels like a dead line; the call must not hang on silence.`);
  }

  const maxDuration = assistant.maxDurationSeconds;
  if (typeof maxDuration !== "number" || maxDuration < 60 || maxDuration > 1800) {
    fail(`maxDurationSeconds must be 60-1800 (got ${maxDuration}). The call must not run without limit.`);
  }

  const tools = assistant.model?.tools ?? [];
  if (!tools.some((t) => t.type === "endCall")) {
    fail("model.tools must include endCall — the assistant has to be able to end the call itself.");
  }

  // The cold half of the knowledge base is only reachable through this tool. Without
  // it the assistant cannot answer a single menu question and has no way to know that.
  const query = tools.find((t) => t.type === "query");
  if (!query) {
    fail("model.tools must include the query tool — the cold half of the knowledge base would be unreachable.");
  }

  const kb = query.knowledgeBases?.[0];
  if (!kb?.description) {
    fail("the query tool's knowledge base needs a description — it is what the model routes on when deciding to search.");
  }

  // A search takes up to a second and a half. Without a spoken acknowledgement the
  // guest hears silence and assumes the line dropped.
  if (!query.messages?.some((m) => m.type === "request-start")) {
    fail('the query tool needs a "request-start" message, or the guest hears silence while it searches.');
  }

  // Termination is driven by a deterministic signal (the endCall tool), never by
  // matching words in the assistant's own speech. Phrase matching drops the line
  // when a farewell appears mid-conversation: "we close at ten, so have a good
  // evening" is not a goodbye. The silence and duration timeouts are the safety
  // net; a phrase list is neither a signal nor a net.
  if (Array.isArray(assistant.endCallPhrases) && assistant.endCallPhrases.length > 0) {
    fail(
      "endCallPhrases must not be set — it terminates the call by parsing the assistant's own text. " +
        "Use the endCall tool as the signal and the timeouts as the fallback."
    );
  }

  /* -- end-of-call capture: the only place reservation details survive ------- */

  const summaryPlan = assistant.analysisPlan?.summaryPlan;
  if (summaryPlan?.enabled !== true) {
    fail("analysisPlan.summaryPlan must be enabled — it is the only record of the reservation request.");
  }

  const summaryContent = summaryPlan.messages?.[0]?.content ?? "";
  if (/\{\{[A-Z_]+\}\}/.test(summaryContent)) {
    fail(`summaryPlan still contains an unsubstituted marker: ${summaryContent.match(/\{\{[A-Z_]+\}\}/)[0]}`);
  }

  const schemaProps = assistant.analysisPlan?.structuredDataPlan?.schema?.properties ?? {};
  for (const field of RESERVATION_FIELDS) {
    if (!(field in schemaProps)) {
      fail(`structuredDataPlan.schema is missing the reservation field "${field}".`);
    }
  }

  /* -- speech layer: failures here are inaudible in config, obvious on a call - */

  const formatters = assistant.voice?.chunkPlan?.formatPlan?.formattersEnabled;
  if (Array.isArray(formatters) && !formatters.includes("phoneNumber")) {
    fail('voice.chunkPlan.formatPlan.formattersEnabled must include "phoneNumber", or the digit-by-digit readback is spoken as "two hundred seven".');
  }

  if (assistant.stopSpeakingPlan?.numWords !== 0) {
    fail(`stopSpeakingPlan.numWords must be 0 (got ${assistant.stopSpeakingPlan?.numWords}). Anything higher waits for transcribed words before yielding, which reads as the assistant talking over the guest.`);
  }

  /* -- payload hygiene ------------------------------------------------------- */

  for (const key of BUILD_ONLY_KEYS) {
    if (key in assistant) {
      fail(`"${key}" is build metadata and must not be sent to Vapi.`);
    }
  }

  return assistant;
}

/**
 * Additional gate applied only before shipping. A placeholder is fine in the working
 * tree and fatal in the sandbox org, where the assistant name is visible to everyone.
 */
export function assertDeployable(assistant) {
  validateAssistant(assistant);


  const walk = (node, path) => {
    if (typeof node === "string") {
      if (node.includes("REPLACE_")) fail(`${path} still contains a placeholder: "${node}"`);
      return;
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
    }
  };

  walk(assistant, "");
  return assistant;
}

/**
 * Last gate before the PATCH, once the upload has happened and its id is injected.
 * Separate from assertDeployable because fileIds cannot exist before the upload —
 * checking them pre-flight would reject every first deploy.
 */
export function assertKnowledgeBaseWired(assistant) {
  const fileIds = assistant.model.tools.find((t) => t.type === "query")?.knowledgeBases?.[0]?.fileIds ?? [];

  if (fileIds.length === 0) {
    fail("the query tool has no fileIds — a tool that searches nothing answers nothing, and says so to no one.");
  }

  return assistant;
}
