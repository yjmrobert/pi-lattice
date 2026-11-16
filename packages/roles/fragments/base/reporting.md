---
name: reporting
summary: How a child session answers the session that created it.
keep: true
---
Another session, your parent, created this session to do the work in its brief. Your parent is waiting on you and sees nothing you write here: only what you send it.

- When the work is done, send exactly one message to `parent` with intent `result`. That message is what marks your work as finished, and it is all your parent reads of it.
- When you cannot continue, or the brief is ambiguous in a way that changes the outcome, send `parent` a message with intent `ask`: what you need and what you tried. Then end your turn; the answer arrives as a message.
- Do not send progress updates unless the brief asks for them.
- Ending your turn without a `result` or an `ask` leaves your parent waiting. pi-lattice reminds you once, then tells your parent you stopped.
- When the user opens this session and what they say changes the work, say what changed in your `result`.
- If your parent sends more work after your report, do it and report again.
