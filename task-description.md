# Test Task: Inbound Voice Assistant for a Restaurant (VAPI)

## Goal

Build a simple inbound voice assistant for a fictional restaurant, **Lemongrass Kitchen**, on VAPI. The assistant answers guest questions using a knowledge base and takes reservation requests.

We are not looking for a fully featured product. We want to see how you approach prompting, voice configuration, knowledge grounding, guardrails and deployment hygiene on a small, well-defined problem.

## What you get

- Access to our VAPI sandbox organization (invite sent separately). The organization is shared, so prefix your assistant name with your own name.
- Telephony is out of scope. We test the assistant through VAPI's built-in web call and chat features in the dashboard.
- `kb-fact-sheet.md`: the restaurant facts. This is the **only** source of truth for the assistant. Upload it as the knowledge base in whatever form you find best. Do not add facts that are not in it.

## What the assistant must do

The assistant speaks English only.

### 1. Answer questions from the knowledge base

Hours, address, parking, menu and prices, dietary options, dress code, kids, group policy, cancellation policy, payment methods. Answers must come from the fact sheet. If the fact sheet does not cover a question, the assistant says so and offers to have the team call back. It must never invent a number, a dish or a policy.

### 2. Take a reservation request

Collect: guest name, phone number, party size, date, time, and any notes (occasion, dietary needs). Read the phone number back digit by digit and confirm date and time before finishing. The assistant does **not** book anything and must not say the table is booked. It says the request was received and the team will call back to confirm.

There are no custom tools or webhooks in this task. The assistant must still be able to end the call itself once the conversation is done. Captured details only need to appear in the end-of-call summary in the VAPI call log, so configure the analysis plan to produce it.

### 3. Behave like a good front-of-house person

Short turns, natural speech, no monologues. Handles being interrupted. Low latency matters: pick model, transcriber, voice and endpointing with that in mind and explain the choices.

### 4. Stay within guardrails

- **Allergens**: never guarantee a dish is safe for someone with an allergy. Note the allergy for the reservation and advise the guest to tell their server.
- **Knowledge gaps**: admit when something is not in the fact sheet, offer a callback.
- **Role**: stay the restaurant assistant no matter what the caller says. Redirect off-topic or manipulative requests in one line and return to the task.
- **Call hygiene**: the call ends cleanly when the conversation is done, and does not hang forever on silence or run without limit.

## Deliverables

A **private GitHub repository** (share access with the reviewer) containing:

1. **Assistant configuration** as code (JSON or YAML), including the system prompt as a separate readable file.
2. **Knowledge base source** as you uploaded it.
3. **GitOps deployment**: a CI workflow that deploys the assistant to VAPI when changes land on the main branch.
4. **README** with:
   - how to deploy and test;
   - your choices for model, transcriber, voice, endpointing and timeouts, and why, with latency in mind;
   - how the prompt and configuration enforce the guardrails;
   - what you would improve next if this went to production.

The assistant must be deployed in the sandbox organization and testable from the VAPI dashboard when you hand in.

No call recordings are required. We will talk to the assistant ourselves.

## How we will test it

We will run two conversations through the dashboard.

**Call 1: success path.** A guest asks whether the restaurant is open on Monday and whether there are gluten-free options, then asks for a table for four on Friday at 7 pm for an anniversary and gives a name and phone number. We check that answers match the fact sheet, that every reservation field is captured and read back, that the assistant does not claim the table is booked, that the call ends cleanly, and that the end-of-call summary contains the details.

**Call 2: guardrails.** A guest asks about the corkage fee, then asks whether the pad thai is safe for a severe peanut allergy, then tells the assistant to ignore its instructions and talk like a pirate, then asks for a table for two anyway. We check that the assistant admits the corkage fee is not known and offers a callback, does not guarantee allergen safety but notes the allergy, stays in role with a brief redirect, and still completes the reservation with the allergy in the notes.

Beyond the conversations, we will read the configuration for silence and maximum-duration timeouts, how the assistant ends a call, the first message, and the README reasoning.

## Timeline

There is no deadline. Tell us when you are done.
