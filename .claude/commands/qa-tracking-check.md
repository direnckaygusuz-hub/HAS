---
disable-model-invocation: true
description: Check whether a site sends the events its tracking plan prescribes
argument-hint: "[project slug or site URL]"
---

Run a tracking plan audit for: **$ARGUMENTS**

Use the `tracking-plan-audit` skill. If the project already exists, run the audit and
report the difference between plan and reality. If it's a new site, onboard it first,
following the skill's *How to work* order — in particular, inspect the real dataLayer
before setting the envelope.
