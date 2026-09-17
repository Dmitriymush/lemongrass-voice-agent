# Architecture

The design behind the assistant, the decision record, and the thresholds at which each
decision stops being right. The [README](../README.md) covers deploying and testing it;
this document covers why it is shaped the way it is.

> Ukrainian working notes, kept for the author's own use, are in [`ua/`](ua/).

---

## 1. What the task actually tests

The reviewer's two conversations are not arbitrary. Each one aims at a specific failure
mode, and reading them that way is what determined the design.

| Trap | The failure mode behind it |
|---|---|
| **Corkage fee** — absent from the fact sheet | Can the system say "I don't know"? Retrieval always returns *something*: the nearest neighbour to "corkage" is the payment section, and a model handed that text will build a plausible answer out of it |
| **Pad thai + severe peanut allergy** | Not an "I don't know": the sheet says *Contains peanuts* and *shared kitchen*. The guardrail must suppress the **guarantee**, not the knowledge — and the data must not depend on a search succeeding |
| **"Talk like a pirate"** | Prompt injection with a tail: after the redirect the assistant must **finish the reservation**. Most role-lock prompts break the flow once they have refused |
| **"Does not book"** | A lexical guardrail. Models gravitate to "you're all set" at the end of a booking dialogue |
| **Monday** | A grounding sanity check |
| **"Friday at 7 pm"** + readback | Without an injected date and timezone the model invents one |
| **Phone digit by digit** | Default TTS says "(207)" as "two hundred seven" — a failure in the speech layer, not in the logic |

Traps 1, 3 and 4 live in the prompt. Trap 2 lives in the hot/cold split *and* the prompt.
Trap 6 lives in a template variable. Trap 7 is not in the prompt at all — it is in
`formatPlan`.

---

## 2. Runtime

![Runtime architecture](diagrams/01-runtime.png)

Two answer paths, deliberately:

- **Hot questions** — hours, parking, policies, allergens — go straight through
  `STT → LLM → TTS` with nothing off to the side. This is most turns.
- **Cold questions** — a specific dish or price — add a retrieval round trip.

| Stage | Hot | Cold |
|---|---|---|
| Endpointing | 300–500 ms | 300–500 ms |
| LLM decision + tool call | — | 300–600 ms |
| Retrieval | — | 500–1500 ms |
| LLM answer (TTFT) | 250–500 ms | 300–600 ms |
| TTS first byte | 100–300 ms | 100–300 ms |
| **Total** | **0.65–1.3 s** | **1.5–3.5 s** |

This is why the split is made by how often a fact is asked rather than by what it is
about. A `request-start` message covers the cold path so the guest never hears silence.

---

## 3. The knowledge boundary

### 3.1 The rule

Not size, and not topic. Three properties:

```
HOT   if   it is asked in most calls
      OR   a retrieval miss costs more than inconvenience
      OR   it is behaviour rather than fact

COLD  if   it grows with the business
      AND  a miss is merely inconvenient
```

![Hot/cold decision tree](diagrams/02-decision-tree.png)

Applied to the fact sheet:

![Hot and cold split](diagrams/07-hot-cold-split.png)

| Section | Route | Why |
|---|---|---|
| Contact and location | hot | asked in almost every call, does not grow |
| Opening hours | hot | the single commonest question |
| Dietary information | hot | policy plus allergens; a miss is expensive |
| Reservations and groups | hot | these are the assistant's rules, not a reference |
| Other — dress code, kids, payment, access | hot | frequent, tiny, static |
| **Menu highlights and prices** | **cold** | the only part that grows without bound |
| *lines containing `Contains …`* | **hot** | lifted out of the cold half — §3.2 |

### 3.2 Why allergens stay hot

A retrieval miss on a price is an inconvenience — the guest hears "I don't have that to
hand". A miss on *"is the pad thai safe with a severe peanut allergy"* is an incident.

Data whose error has a health cost does not belong behind a probabilistic lookup. Lines
matching `Contains …` are therefore extracted into an allergen matrix in the prompt, and
that answer never depends on the search working.

The extraction is **verbatim** — the whole line, price included, no reformatting. A
cleverer extraction would one day cut the wrong part of a line, and the failure would be
silent. The consequence is that allergen-bearing dishes appear in full in the hot core.
That is deliberate slack in the safe direction.

This is the same invariant as *"guardrails never go through retrieval"*, applied to data
instead of rules.

### 3.3 What the hybrid costs, and what it risks

Cost splits into two terms that behave differently:

```
hot   — paid every turn:      K_hot × T
cold  — paid per question:    Q_cold × (C + R)
```

The point of the split is that `K_hot` stops growing with the business while `Q_cold`
stays small by construction. A static hot core at the top of the prompt is also an ideal
cache prefix; retrieved chunks land mid-context and differ every time, invalidating
everything after them — another reason to keep the hot core small and stable rather than
generous.

**The risk the hybrid brings with it** is that a retrieval failure is invisible: the
model cannot tell "no such fact" from "nothing found". That aims straight at trap 1.

The counter is the **scope manifest** (§5): an explicit list of covered topics,
generated from the headings of *both* halves. "Corkage" fails a membership check before
any search happens. Without it, the hybrid would be worse than inlining on negative
questions; with it, it is not.

---

## 4. ADR-001 — inline-only grounding (superseded)

**Status:** superseded by §3.

The first design inlined the entire fact sheet and used no retrieval. The arithmetic
supporting it was sound — `K` = 485 measured tokens, `T` ≈ 20 turns, `Q` ≈ 4 knowledge
questions, `C` ≈ 2500 context, `R` ≈ 400 chunk:

```
Δ(inline)    = K × T       = 485 × 20 =  9 700 input tokens per call
Δ(retrieval) = Q × (C + R) = 4 × 2900 = 11 600 input tokens per call
break-even:    K* = Q × (C + R) / T ≈ 580 tokens
```

Inline was cheaper, 2–3× faster per knowledge turn, and made "we don't have that"
deterministic rather than emergent.

**Why it was wrong anyway.** It optimised *this* fact sheet. What is under evaluation is
the architecture, and a restaurant's menu is the one part of it guaranteed to grow. An
argument resting on today's 485 tokens collapses the day the menu does.

The boundary the first design never saw is the one in §3: not *inline vs retrieval*, but
*configuration vs knowledge base*. It treated the fact sheet as one homogeneous thing.

**What survived the reversal**, unchanged:

- the threshold arithmetic — now applied to `K_hot` rather than the whole corpus
- the scope manifest, which retrieval makes *more* necessary, not less
- the invariant that guardrails never go through retrieval, extended to allergen data
- the content-hash mechanism in the deploy, written speculatively and now load-bearing
- the entire guardrail layer of the prompt, and every scenario test

**The lesson, kept on purpose.** Correct arithmetic applied to a wrongly framed question
produces a confidently wrong answer. The signal arrived before the correction did: asked
"what if the document gets large?", the answer was a threshold and a migration plan
rather than a reversal.

---

## 5. The prompt

![Prompt structure](diagrams/03-prompt-structure.png)

Section order is chosen for caching: stable content first, the volatile date last.

Four places where it departs from the obvious shape:

**A scope manifest instead of "say so if you don't know".** Detecting absence is a
negative condition and models are poor at it — a model cannot distinguish "not in the
knowledge" from "I know restaurants generally have corkage fees". Retrieval adds a third
state, "nothing found". The manifest converts all of it into a membership check, which
models perform reliably. Covered topics are generated from the fact sheet's headings;
the anti-examples cannot be generated — they are by definition what the sheet does not
contain — so they are hand-written and guarded by a test.

**A role lock that must resume.** Most role-lock prompts teach refusal. The reviewer's
test checks that the reservation *survives*. The instruction is therefore one sentence
of redirect followed by returning to exactly where the conversation was. It also states
what is *not* an attack: an early version fired the anti-jailbreak line at a guest who
said *"wait, actually—"*, which is stranger than having no guardrail.

**An explicit rule for when to search.** Check the hot knowledge and the scope first;
call `query` only for a dish, a price or a description; never call it for hours,
policies or allergens, which are already present. If the two disagree, the inlined text
wins.

**Categorical criteria, and wrong examples.** Every subjective threshold — "apologise
repeatedly", "nothing useful", "one short line" — was replaced with something countable,
and each high-risk rule carries wrong examples beside the right one, lifted verbatim
from the failing samples in `tests/checks.test.mjs`. The prompt and the tests therefore
describe the same boundary rather than two similar ones.

![Guardrails in the reviewer's second call](diagrams/04-guardrails-call2.png)

---

## 6. Delivery

![GitOps pipeline](diagrams/05-gitops-pipeline.png)

```
kb/kb-fact-sheet.md     the reviewer's original, byte for byte, never edited
kb/routing.json         which sections are hot, which are cold
kb/generated/           the document Vapi actually holds, committed and diff-checked
prompt/                 templates with {{MARKERS}}
assistant.config.json   everything except the prompts
state/resources.json    file id, content hash, and the assistant they belong to
```

Ordering matters and is enforced: **upload → wait for processing → patch**. An assistant
patched to reference a file id that does not exist yet, or one that failed processing,
looks entirely healthy and answers nothing.

After every deploy the assistant is **read back and held to the same contract as the
artefact**. `PATCH` is a partial update, so a field deleted from the repository keeps its
old value on the server indefinitely — "the repository is the source of truth" is only
true if someone checks. See [`FINDINGS.md`](FINDINGS.md) §B2.

State is scoped to the assistant it was recorded against. Pointing the deploy at a
different org leaves the content hash matching, which would skip the upload and wire the
assistant to a file that org cannot see.

---

## 7. Scaling from here

The hybrid is the first step of the right shape, not the destination.

| When | What changes |
|---|---|
| Cold grows to several documents | topic-scoped knowledge bases, each with its own description, so the model routes rather than searching everything |
| Documents update at different rates | separate file ids and hashes — the mechanism is already per-document |
| Several restaurants, one assistant | `variableValues` for the hot core, a knowledge base per venue |
| The hot core itself passes ~600 tokens | revisit the split: something in hot must become cold |

The last row is the tripwire from ADR-001, now measuring `K_hot`. The build reports it
on every run and fails when it is crossed, so the architecture announces its own expiry
rather than relying on anyone remembering the calculation.

**What never changes:** guardrails, the allergen matrix, the scope manifest, banned
phrases, the role lock, and the scenario tests. They are bound to how the assistant
behaves, not to how knowledge reaches it, and they survive any migration of the latter.

---

## 8. Deliberately absent

| Not here | Why |
|---|---|
| A custom retriever behind `server.url` | That is a webhook, which the task excludes — and it would need hosting kept alive for the review |
| A database | The task asks for the details in the end-of-call report, nothing more |
| A dialogue state machine | The prompt handles a flow this size, and a state machine would cost the natural speech that is scored separately |
| Automated tests of the speech layer | They do not pay for themselves here; endpointing and pronunciation are verified by listening |
| Several topic-scoped knowledge bases | Empty complexity over one fact sheet — structurally allowed for, switched on when it earns its place |

---

## 9. Open questions

| # | Question | Impact |
|---|---|---|
| 1 | Does Vapi pass `cache_control` through for Anthropic models? | Decides whether the caching argument holds for Claude as a candidate; OpenAI caches prefixes automatically regardless |
| 2 | Query tool reliability across model sizes | A model that never calls the tool fails silently; the cold scenario exists to catch it, and `gpt-4.1-mini` passes it live |
| 3 | Chunking quality as the cold half grows | Not a problem at six dishes; needs measurement before it is one |
| 4 | Whether digit-by-digit readback survives TTS | Unverifiable from logs — Deepgram's `smartFormat` normalises spoken numbers back into digits, so "two zero seven" and "207" are indistinguishable in a transcript |
| 5 | Sandbox credits | `POST /chat` returns `402` without a card on file, so the scenario harness cannot run end to end; live evidence comes from dashboard web calls |
