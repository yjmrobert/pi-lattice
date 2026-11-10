# 0002 Deterministic testing with Pi's faux provider

**Decision**

Integration tests spawn real Pi processes in RPC mode against `fauxProvider` from `@earendil-works/pi-ai`, registered by a small test-support extension. A script module supplies the response steps; a step can be a function of the transcript, so tests can assert on what the model was actually shown (system prompt sections, injected messages).

Children run with `PI_CODING_AGENT_DIR` pointed at a throwaway directory, `PI_OFFLINE=1`, `PI_TELEMETRY=0`, `--no-skills` and `--no-context-files`, so tests never read the developer's Pi config or credentials.

**Evidence (spike S1, S4)**

A scripted run completes over RPC in about 20 ms. Eight concurrent children started in about 400 ms in total and ran in isolation.
