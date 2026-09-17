import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parse } from "yaml";

/**
 * The credit policy from docs/ARCHITECTURE.md §8.4, asserted rather than documented.
 *
 * The sandbox org runs on a finite credit balance. Every eval run and every deploy
 * spends it. A comment saying "don't run this on PRs" is not a control; adding
 * `pull_request` to the deploy trigger is a one-line change nobody would flag in
 * review. These tests make that change fail loudly.
 */

const load = (name) => parse(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8"));

const ci = load("ci.yml");
const deploy = load("deploy.yml");

/** `on` parses as the boolean true in YAML 1.1, so read it by either key. */
const triggers = (wf) => wf.on ?? wf[true];

const stepsOf = (wf) => Object.values(wf.jobs).flatMap((job) => job.steps ?? []);
const runScripts = (wf) => stepsOf(wf).map((s) => s.run ?? "").join("\n");

/* -------------------------------------------------------------------------- */

describe("pull request workflow", () => {
  test("5.1 runs on pull requests", () => {
    assert.ok(triggers(ci).pull_request !== undefined, "PRs must be checked");
  });

  test("5.2 runs the test suite and the build", () => {
    const scripts = runScripts(ci);

    assert.match(scripts, /npm test|npm run test/, "the suite must gate every PR");
    assert.match(scripts, /npm run build/, "a PR that cannot build must not be mergeable");
  });

  test("5.3 never spends credits — no eval, no deploy on a pull request", () => {
    const scripts = runScripts(ci);

    assert.doesNotMatch(scripts, /npm run eval/, "eval calls the model on every turn; PRs must stay free");
    assert.doesNotMatch(scripts, /npm run deploy/, "a PR must never reach the shared sandbox org");
  });
});

/* -------------------------------------------------------------------------- */

describe("deploy workflow", () => {
  test("5.4 never triggers on a pull request", () => {
    assert.equal(triggers(deploy).pull_request, undefined, "a PR must not be able to deploy or spend credits");
  });

  test("5.5 triggers only on main, plus a manual run", () => {
    const push = triggers(deploy).push;

    assert.deepEqual(push.branches, ["main"], "deploys come from main only");
    assert.ok("workflow_dispatch" in triggers(deploy), "a manual run is needed for measurement sessions");
  });

  test("5.6 deploys only after the suite and the scenarios have passed", () => {
    const scripts = runScripts(deploy);
    const order = ["npm test", "npm run build", "npm run eval", "npm run deploy"];

    const positions = order.map((cmd) => scripts.indexOf(cmd));

    for (const [i, cmd] of order.entries()) {
      assert.notEqual(positions[i], -1, `${cmd} is missing from the deploy workflow`);
      if (i > 0) {
        assert.ok(
          positions[i] > positions[i - 1],
          `${cmd} must run after ${order[i - 1]} — deploying before the scenarios pass defeats the gate`
        );
      }
    }
  });

  test("5.6b deploying is gated on the same condition as the scenarios", () => {
    const steps = stepsOf(deploy);
    const evalStep = steps.find((s) => (s.run ?? "").includes("npm run eval"));
    const deployStep = steps.find((s) => (s.run ?? "").includes("npm run deploy"));

    assert.ok(evalStep.if, "the gate is skipped where it cannot run");
    assert.equal(
      deployStep.if,
      evalStep.if,
      "deploy must carry the same condition as the gate — otherwise skipping the gate ships unverified"
    );
  });

  test("5.7 passes both secrets to the steps that need them", () => {
    const withSecrets = stepsOf(deploy).filter((s) => JSON.stringify(s.env ?? {}).includes("secrets."));

    assert.ok(withSecrets.length > 0, "eval and deploy need VAPI_API_KEY");

    const env = JSON.stringify(withSecrets.map((s) => s.env));
    assert.match(env, /VAPI_API_KEY/);
    assert.match(env, /VAPI_ASSISTANT_ID/);
  });

  test("5.8 keeps no credentials in the repository", () => {
    const raw = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");

    assert.doesNotMatch(raw, /sk-|Bearer\s+[a-f0-9]{8}/i, "keys come from secrets, never from the file");
  });
});

/* -------------------------------------------------------------------------- */

describe("deployment state", () => {
  test("5.9 commits state/resources.json back when the fact sheet changed", () => {
    const scripts = runScripts(deploy);

    assert.match(
      scripts,
      /state\/resources\.json/,
      "Vapi file ids live in state/resources.json; if CI never commits it back, the next run re-uploads and the org fills with duplicates"
    );
  });
});
