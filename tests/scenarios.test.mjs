import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { SCENARIOS, runScenario } from "../scripts/lib/scenarios.mjs";

/** Replies in order, so a scenario can be driven without touching the Chat API. */
const replay = (replies) => {
  let i = 0;
  return async () => replies[i++] ?? "";
};

const happyPath = SCENARIOS.find((s) => s.id === "01-happy-path");
const guardrails = SCENARIOS.find((s) => s.id === "02-guardrails");

const GOOD_HAPPY_PATH = [
  "We're closed on Mondays. We open again Tuesday at five.",
  "We do have gluten-free options, and we use gluten-free soy sauce on request.",
  "Happy to take that down. What date works — this Friday?",
  "An anniversary, lovely. Can I start with your name?",
  "Thanks Anna. And a phone number for the team?",
  "Let me read that back: two zero seven, five five five, zero one four eight. How many people, and what time?",
  "Four at seven p.m. this Friday. Any dietary needs or occasion I should note?",
  "I've got your request. The team will call you back to confirm. Have a good evening.",
];

describe("scenario definitions", () => {
  test("cover both conversations the reviewer described", () => {
    assert.equal(SCENARIOS.length, 2);
    assert.ok(happyPath && guardrails);
  });

  test("every turn has something to say", () => {
    for (const scenario of SCENARIOS) {
      for (const turn of scenario.turns) {
        assert.ok(turn.say?.length > 0, `${scenario.id} has an empty turn`);
      }
    }
  });
});

describe("runner", () => {
  test("passes a conversation that does everything right", async () => {
    const { failures } = await runScenario(happyPath, replay(GOOD_HAPPY_PATH));

    assert.deepEqual(failures, [], `unexpected failures:\n${JSON.stringify(failures, null, 2)}`);
  });

  test("reports the turn number and the reason, not just a boolean", async () => {
    const replies = [...GOOD_HAPPY_PATH];
    replies[0] = "Yes, we're open Monday from five to ten.";

    const { failures } = await runScenario(happyPath, replay(replies));

    assert.equal(failures.length, 1);
    assert.equal(failures[0].turn, 1);
    assert.equal(failures[0].check, "saysClosedOnMonday");
    assert.match(failures[0].reason, /open on Monday/i);
  });

  test("collects every failure rather than stopping at the first", async () => {
    const replies = [...GOOD_HAPPY_PATH];
    replies[0] = "Yes, we're open Monday from five to ten.";
    replies[1] = "No, we don't have anything gluten free.";

    const { failures } = await runScenario(happyPath, replay(replies));

    assert.equal(failures.length, 2, "one run should tell you everything that is broken");
  });

  test("catches a booking claim made on any turn", async () => {
    const replies = [...GOOD_HAPPY_PATH];
    replies[7] = "You're all set for Friday at seven. See you then!";

    const { failures } = await runScenario(happyPath, replay(replies));

    assert.ok(
      failures.some((f) => f.check === "noBookingClaim" && f.turn === "transcript"),
      "the transcript-level check must catch it wherever it appears"
    );
  });

  test("catches a reservation left incomplete even when every reply looks polite", async () => {
    const replies = [...GOOD_HAPPY_PATH];
    replies[4] = "Thanks Anna. What date works for you?";
    replies[5] = "Let me read that back: two zero seven, five five five, zero one four eight. Right?";

    const { failures } = await runScenario(happyPath, replay(replies));

    const missing = failures.find((f) => f.check === "collectsReservationFields");
    assert.ok(missing, "a polite conversation that never asks for a phone number still fails");
    assert.match(missing.reason, /phone/i);
  });

  test("guardrail scenario fails when the allergy never reaches the notes", async () => {
    const replies = [
      "I don't have that here, but I can have the team call you back. Can I take your name and number?",
      "That dish contains nuts. Our kitchen is shared, so I can't guarantee it. Please tell your server.",
      "I'll stay your restaurant assistant. Where were we — a table for two?",
      "Of course. Can I start with your name?",
      "Thanks Mark. And a phone number?",
      "Let me read that back: two zero seven, five five five, zero one nine nine. What date and time?",
      "I've got your request. The team will call you back to confirm.",
    ];

    const { failures } = await runScenario(guardrails, replay(replies));

    assert.ok(
      failures.some((f) => /allergy never resurfaced|peanut/i.test(f.reason)),
      "the allergy must survive from turn 2 into the reservation"
    );
  });
});
