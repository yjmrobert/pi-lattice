# Two agents, no host

Two Pi sessions on one machine exchanging messages through `@pi-lattice/a2a` alone.

1. In two terminals, from the repository root:

   ```bash
   pi -e ./packages/a2a --name alpha
   pi -e ./packages/a2a --name beta
   ```

2. In either session run `/node` to see its node id, or `/peers` to see the other one.

3. In alpha, ask the agent:

   > Use list_peers, then send beta a message asking what directory it is working in.

4. Beta's agent wakes, sees the message as a `<lattice-message>` block, and can answer with `send_message` and `replyTo`. The reply arrives in alpha the same way.

To see approval, start beta as a different owner and send again; the message waits until you run `/inbox` in beta:

```bash
LATTICE_OWNER=someone-else pi -e ./packages/a2a --name beta
```
