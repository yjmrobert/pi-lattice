# 0046 Two machines are tested as containers

Builds on [0012](0012-peer-to-peer-collab.md) and [0029](0029-sharing-through-the-server.md). Status: built.

Sharing was tested with two hosts on one computer, each with its own home, talking over `127.0.0.1`. That holds what the hosts say to each other. It cannot hold what a network does: an address that is one machine's and not another's, a machine that leaves without closing anything, two machines that reach the server and not each other. Those were a script to follow by hand ([two machines](../two-machine-handoff.md)), which was not followed often.

**Decision**

- **A machine is a container.** One image: Node, git, Pi, and pi-lattice installed into Pi from the packed package, as a person gets it. The server and each person's machine are containers of it, each with its own filesystem, home, keys and addresses. Nothing of the checkout runs on them but the scripted model and a probe, mounted read-only.
- **Three of them are a team.** `test/e2e/compose.yml`: a server running `pi-lattice server`, and the machines of yan and sam. Everyone is on one network, and each machine has a link of its own to the server besides, so a machine has two addresses as a laptop on an office network and a VPN has.
- **The tests do what a person does.** They drive a real Pi on each machine through its RPC mode: the line the server printed is pasted, the name is answered, `/lattice take` and `/lattice approve` are typed. What a host knows is asked of it as its terminal would ask.
- **The network is changed under them.** A machine is taken off a network and put back with `docker network disconnect`. Off the shared network, two machines reach the server and not each other; off every network, a machine is away and has said so to nobody.
- **They run on GitHub's runners, beside CI.** `npm run e2e` here, and the workflow `Between machines` on every push. They need Docker, so they are not part of `npm test`, and they do not hold a release back. The repository is public, so nothing runs on a machine of ours.

**What it comes to**

Six tests in about three and a half minutes: the handover of the manual script from joining to going away; machines apart that agree on a handover through the server, which happens once they share a network; addresses where nothing listens; a machine gone half way through a handover; the server restarted; a line with the wrong code.

Writing them found four things that the tests on one machine could not, each fixed with a test of its own where one machine is enough:

- A teammate whose machine left the network stayed online for good: nothing closes a connection that a cable was pulled from. A quiet connection is now asked whether anyone is there, and closed after fifteen seconds of nothing.
- A machine that moved to another network stayed listed at its old addresses until its host was restarted. A host now says where it is each time it says it is there.
- A session just taken over read as an empty conversation until it first ran.
- A request on its way through the server was failed when a connection to its owner was dropped, which happens whenever two hosts dial each other at once. This is what made `test/integration/teammates.test.ts` fail now and then on CI.

**Not done**

- Two real machines, a real VPN and a firewall are still the manual script.
- Nothing here runs a real model. The scenarios with one are `npm run eval`.
- The terminal interface is not driven on the machines: the tests use Pi's RPC mode. The pane and the canopy are tested on one machine.
- A changed key, a third person, a private repository and taking a session by cloning are in the manual script and tested on one machine, not here.
- One network at a time is taken away whole. A slow or lossy link is not made.

**Evidence**

`test/e2e/team.e2e.ts` and `test/e2e/network.e2e.ts`. On one machine: `packages/collab/test/collab.test.ts` (a silent teammate; a request by the server when a connection goes), `packages/app/test/work.test.ts` (addresses said again), `test/integration/collab.test.ts` (a session read before it has run).
