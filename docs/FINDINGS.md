# Findings

What building this assistant actually taught us, as opposed to what the documentation said.

Everything below was found by running against the live Vapi API or by auditing the
configuration against agent-design guidance. Each entry states the evidence, what it
would have cost if it had shipped, and what now prevents it from recurring.

---

## A. A decision reversed

### A1 — Inline grounding was the wrong answer to the right arithmetic

**Superseded:** [ADR-001](ARCHITECTURE.md#5-adr-001--inline-only-grounding-superseded)

The first design inlined the whole fact sheet into the system prompt and used no
retrieval at all. The arithmetic supporting it was sound:

```
Δ(inline)    = K × T       = 485 × 20 =  9 700 input tokens per call
Δ(retrieval) = Q × (C + R) = 4 × 2900 = 11 600 input tokens per call
break-even   K* = Q × (C + R) / T ≈ 580 tokens,  measured K = 485
```

Inline was cheaper, roughly 2–3× faster per knowledge turn, and made "we don't have
that" deterministic rather than emergent.

**Why it was still wrong.** It optimised *this* fact sheet. What is being judged is the
architecture — and a restaurant's menu is the one part of it guaranteed to grow. An
argument resting on today's 485 tokens collapses the day the menu does.

**What replaced it.** The boundary does not run between "inline" and "retrieval". It
runs between what is the assistant's *configuration* and what is its *knowledge base*:

| | |
|---|---|
| **Hot**, inlined | contacts, hours, policies, behaviour rules, allergen matrix |
| **Cold**, retrieved | dishes, prices, descriptions — everything that grows |

Split by three properties, not by size: how often it is asked, what a retrieval miss
costs, and whether it grows.

**The lesson kept in the document on purpose.** Correct arithmetic applied to a
wrongly framed question produces a confidently wrong answer. The signal came earlier
than the correction did — the question "what if the document gets large?" was answered
with a threshold and a migration plan instead of a reversal.

### A2 — Allergen data does not belong behind a search

A consequence of A1 that is worth stating separately, because it is the one place
where the split is decided by safety rather than by economics.

Missing a price is an inconvenience. Missing *"does the pad thai contain peanuts"* is
an incident. Lines containing `Contains …` are therefore lifted out of the cold half
and inlined, **verbatim, price included** — a tidier extraction would one day cut the
wrong part of a line, and that failure would be silent.

The consequence is that dishes carrying allergens appear in full in the hot core. That
is deliberate slack in the safe direction.

---

## B. Vapi behaviour that is not in the documentation

Each of these was found by deploying early. None would have been caught by reading.

### B1 — `text/markdown` cannot be processed

```
kb-cold.md   text/markdown  ->  status: failed   (no error detail anywhere on the object)
kb-cold.txt  text/plain     ->  status: done     (byte-identical content)
```

**If it had shipped:** the assistant looks correct — the query tool exists, the
knowledge base is attached, the deploy reported success — and every menu question
returns nothing. The failure is invisible in the configuration and only audible on a
call.

**Prevented by:** the build writes `.txt`; the deploy polls `GET /file/:id` and refuses
to wire an assistant to a file that has not reached `done`.

### B2 — `PATCH /assistant` is a partial update, so deletions never happen

`endCallPhrases` was removed from the repository, the tests went green, the deploy
succeeded — and the field was **still live on the assistant**. A field absent from the
request body keeps its previous value indefinitely.

```
{ "endCallPhrases": [] }    -> stored as []     (not cleared)
{ "endCallPhrases": null }  -> cleared
```

**If it had shipped:** the central claim of the GitOps deliverable — that the
repository is the source of truth — would have been false. Anything ever deleted from
the config stays deployed forever, and nothing surfaces it.

**Prevented by:** removals are sent as explicit `null`, and, more generally, the
assistant is **read back after every deploy and held to the same contract as the
artefact**. A field list only covers what someone remembered; a read-after-write check
covers everything. Reporting success without looking is how drift survives for months.

### B3 — File content is immutable

`PATCH /file/:id` updates the **name** only. Changing a document means uploading a new
one and re-pointing whatever referenced it.

**Consequence:** this quietly demolishes the usual argument for a managed knowledge
base — "you can update the file without touching the code". You cannot. It is a deploy
either way, in two steps, with an id to track.

**Prevented by:** the cold document is hashed; it is re-uploaded only when its content
changes. Without that, every deploy adds another copy while the assistant still
references the old id, and the org fills with orphans.

### B4 — The query tool works inline, so the planned sequence was unnecessary

The documented path is `POST /tool`, store the id, reference it through `toolIds`. In
practice `{"type": "query", "knowledgeBases": [...]}` is accepted directly inside
`model.tools`.

The planned three-step deploy — create tool, track id, patch assistant — collapsed to
two, and the entire class of "assistant references a tool id that does not exist yet"
failures disappeared with it. **Less code because of a measurement, not despite one.**

### B5 — Public and private keys are indistinguishable by shape

Both are 36-character UUIDs. A credentials check can confirm a key is *present* but not
that it is the *right* one; the only signal is a 401 with
*"you may be using the private key instead of the public key, or vice versa"*.

**Prevented by:** the credentials check reports length and prefix only, and states
plainly that it proves presence rather than validity. The first read-only API call is
what actually proves access.

---

## C. Design defects found by audit, not by testing

Audited against published agent-design guidance. These were all present in a codebase
whose tests were green.

### C1 — Terminating a call on phrases is the named anti-pattern

The configuration carried:

```json
"endCallPhrases": ["goodbye", "bye now", "have a good evening", "thanks for calling"]
```

This ends the call by pattern-matching the assistant's own speech — precisely the
"parse assistant text for a completion signal" anti-pattern. The concrete failure: a
guest calls at 21:00, the assistant says *"we close at ten, so have a good evening"*,
and the line drops mid-reservation.

The correct arrangement was already in place; the phrase list only undermined it:

| Role | Mechanism |
|---|---|
| Signal | the `endCall` tool — a deterministic action |
| Safety net | `silenceTimeoutSeconds`, `maxDurationSeconds`, the speech-timeout hook |
| Removed | `endCallPhrases` |

**Prevented by:** the contract now rejects `endCallPhrases` outright, and the prompt
states that *ending the call is an action, not a phrase — saying goodbye does not end
it, calling `endCall` does*.

### C2 — Two sources, no precedence rule

The hybrid gives the model two sources that overlap: pad thai appears both in the
inlined allergen matrix and in the retrieved menu. They cannot actually diverge — both
are generated from one file at build time, so provenance is guaranteed by construction
rather than preserved by discipline — but the model was never told which to trust.

**Prevented by:** an explicit rule that the inlined text wins, plus a categorical
definition of a failed search — *no returned line names the dish that was asked about*
— instead of leaving "nothing useful" to the model's judgement.

### C3 — A request for a human was unhandled

Guidance lists an explicit request to speak to a person as the first valid escalation
trigger, to be honoured immediately with no attempt to resolve first. The prompt had
no rule for it at all — more likely in a restaurant than half of what was covered.

### C4 — Five subjective thresholds, and no wrong examples

*"Apologise repeatedly"*, *"nothing useful"*, *"one short line"* (twice), *"clearly
finished"* — each replaced with a countable criterion. And every high-risk rule now
carries **wrong** examples beside the right one, taken verbatim from the failing
samples in `tests/checks.test.mjs`, so the prompt and the tests describe the same
boundary rather than two similar ones.

---

## D. What keeps these from coming back

Findings are only worth the mechanism that outlives them.

| Mechanism | Covers |
|---|---|
| Read-after-write contract check | B2, and any future drift of the same kind |
| File-status polling before wiring | B1 |
| Content hash on the cold document | B3 |
| Contract rejects `endCallPhrases` | C1 |
| Hot-core token cap enforced at build | the threshold from A1, now on `K_hot` |
| Unrouted section fails the build | a new fact-sheet section silently disappearing |
| `notCovered` guard | an anti-example drifting into a topic actually covered |
| Checks tested against realistic failures | an assertion that can only ever pass |
| Mutation testing on the runner and the CI policy | tests that look strict and are not |
| Credit policy asserted in `tests/workflows.test.mjs` | a one-line trigger change spending the sandbox balance |

Two of these were verified by deliberately breaking the code rather than by trusting
them: making the scenario runner stop at the first failure turns the suite red, and
adding `pull_request` to the deploy trigger does the same.

One was verified by the platform itself. The first CI run on `main` stopped at the
scenario gate because no secrets were configured — the build passed, the evaluation
failed, and **nothing deployed**. The gate is in the repository's history, not only in
its description.
