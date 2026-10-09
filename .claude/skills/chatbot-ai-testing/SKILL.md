---
name: chatbot-ai-testing
description: Test an AI chatbot on a site or app: answer quality, dead or wrong links, made-up facts, repeatability, multi-turn behaviour, prompt injection, and the widget itself per environment. Use for "test the chatbot", "check the AI answers", "is the bot hallucinating", "test prompt injection", "Ask <brand>" widgets, or a chatbot failing on one environment.
---

# Testing an AI chatbot

A chatbot is **non-deterministic**. The same question can pass four times and fail the
fifth. Everything below follows from that.

## Test the API, not the chat window

Find the endpoints the widget calls (usually a POST that creates a message and a streamed
response, SSE or chunked) and write one small helper — `ask(env, question, session=None)`
— that sends the question, parses the stream and returns the **text and the structured
payloads** (sources, links, cards like products, places or bookings). Run questions in parallel (≈8
at a time is polite). This is faster than a browser, repeatable, and gives you the
structured data you need to judge the text against.

Also note from the API itself: message length limit (what does 1 character over return?),
whether error bodies leak stack traces, what headers the frontends send, whether feedback
can be posted for another session. These are findings too.

## Question sets

Build tagged lists of `(key, question)`:

- **The top tasks** of the site, one question each, in the words a visitor would use.
- **Time-sensitive questions** ("open now", "today's schedule", stock, wait times).
- **Other languages** the audience uses.
- **Edge cases:** a false premise ("why did X close?"), personal data in the question,
  emoji only, a medical emergency, legal advice, a competitor, off-topic.
- **Multi-turn conversations** where the second question depends on the first ("I'm
  visiting on Saturday" → "where can I park?" → "how much is it?").
- **Removed features.** When a release removes a feature from the product, ask the
  chatbot about it ("Can I order food online in the app?"). The app no longer had mobile
  ordering, but the bot still answered "Yes, … order through <ordering site>" with a link.
  Its sources or knowledge base outlive the code, so add the question to every
  feature-removal ticket's test.

## Judging answers

- **Links:** collect markdown links, bare URLs and cited sources; fetch each (`curl -sL`
  with a browser user agent), record status, final URL and `<title>` — the title catches
  soft 404s that return 200. Report dead links with the question that produced them.
- **Made-up facts:** compare the text with the structured payload of the **same**
  response. A bot that answers "gate C25" when its own data payload says D16 — or when no
  lookup happened at all — is inventing. Check whether the lookup ran before
  judging the answer.
- **Self-contradiction:** text that says "no arrivals between 7 and 8" next to a card
  listing four.
- **Relevance of sources and ranking:** a staff-only page cited for a customer
  question; vending machines ranked above restaurants.

**Time windows move under you.** A bot that only knows today's data loses an item from
its window between two calls (a departure, a timeslot, a daily offer). Pick items that are in the feed *right now*, ask
immediately, and compare within minutes — otherwise you report a broken lookup that is
really a clock.

## Repeatability — never judge on one try

Run every behavioural question **at least 5 times** and report "x of N" ("invented a gate
number in 4 of 5"). In the report, say plainly that a single manual try proves nothing. On a
retest, something that now fails 1 of 6 is **not fixed** — list it separately.

## Prompt injection — test it properly or not at all

Two off-topic prompts that the topic filter rejects prove only that the topic filter
exists. Never report injection resistance as "verified" on that basis.

A real test:

- **Canary tokens.** Every attack asks for a unique, harmless marker ("end your answer
  with ZORPCANARY7"). An attack succeeded only if its token appears. This makes judging
  objective.
- **Categories:** calibration (bare "ignore previous instructions"), override hidden inside
  a real on-topic question, behaviour change, exfiltration (append an attacker URL),
  impersonating an admin or developer, obfuscation and other languages, instructions
  inside pasted "context", jailbreak framing (personas, hypotheticals), and **persistence**
  over several turns in one session.
- Several attempts per case, like any other behaviour.
- If a firewall blocks some payloads outright (403), note it as a layer and re-word to
  reach the model.
- **Name the limit:** true indirect injection means planting content in the bot's
  knowledge source. If you can't, check instead that every cited source is first-party,
  and say that indirect injection was not tested.

Run injection tests on a non-production environment, and tag them like any other test
that leaves a trace: each message costs money and creates a conversation log.

## The widget: opens vs works

Test the widget in two halves — does it **open** (SDK loads, panel appears) and does it
**work** (a message goes out and an answer streams back). The frontend almost always opens;
the backend is what breaks.

When it works on one environment and not another, check in this order:

1. **The feature flag** for that environment — off is *absent*, not *broken*.
2. **Which SDK / API host** that environment loads (old and new widgets may both ship).
3. **CORS:** a preflight from that environment's origin —
   `curl -si -X OPTIONS <api>/<path> -H "Origin: <site origin>" -H "Access-Control-Request-Method: POST"`
   — and look for `access-control-allow-origin`. Preview hostnames are often missing from
   the allowlist, which makes the chatbot always red on previews; say so rather than
   reporting it per ticket.

## Report

English, no shell commands or reproduce scripts — the readers are product people. Per
finding: an ID, severity, layer (API / frontend / content), one line "Tested by …" with the
number of attempts, and the example with its count ("8 of 9"). Put the non-determinism
warning in its own highlighted box. Structure: what must be fixed first, quality and
robustness, smaller issues, what works. On a retest, report only what **keeps** breaking,
and list what dropped off separately. Update the same document or artifact on a retest
rather than creating a new one.
