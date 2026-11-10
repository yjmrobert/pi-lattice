# 0006 Attach renders RPC events with Pi's own components

**Decision**

Attach is a host-side view built from the child's RPC event stream, rendered with the chat components Pi exports (`AssistantMessageComponent`, `UserMessageComponent`, `ToolExecutionComponent`, `CustomMessageComponent`, the editor and selector components) on `@earendil-works/pi-tui`.

**Alternatives considered**

- *Interactive Pi inside tmux, attach = the real TUI.* Full fidelity for free and sessions would survive a host crash. Rejected for v1: tmux is not installed on the development machine, it would be a hard runtime dependency, it rules out Windows, and the host would lose the structured event stream it needs for status badges and blocked-dialog detection.
- *Own renderer from scratch.* This was the hidden cost in the original plan. Reusing Pi's components removes most of it.

**Risk**

Only importability is verified (spike S10). Driving those components from RPC events outside Pi's `InteractiveMode` is unproven and is the first task of Phase 4. If it turns out to need large parts of `InteractiveMode`, revisit the tmux option before building further.

**Known limits**

Extension custom components, widgets, footers and custom editors do not exist over RPC. Extension-defined message renderers run in the child, not the host, so custom messages fall back to plain rendering in the attached view.
