# 0003 Roles are injected as system prompt sections

**Decision**

The roles extension sets `event.systemPromptOptions.sections[...]` in `before_agent_start`. It does not return a replaced `systemPrompt`.

**Why**

Pi diffs sections against what the model already has and appends a patch for only the changed ones. Changing roles mid-session therefore keeps the cached prefix on providers that accept mid-conversation system messages. Replacing the whole prompt is a cache miss on every change.

Section keys become XML tag names. The extension uses one section per applied fragment, in list order, with keys derived from the fragment name, so removing a fragment removes exactly its section.

**Evidence (spike S3)**

A section set by an extension appeared in the system prompt the model received, per session, with different text in each of eight concurrent sessions.

**Also available**

`resources_discover` lets an extension contribute skill and prompt-template paths at session start and on reload. Roles do not need it; it is the route if fragments ever want to ship skills.
