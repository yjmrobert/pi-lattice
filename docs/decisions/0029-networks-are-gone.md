# 0029. Networks joined by a code are gone

Status: built. Withdraws the finding half of [0018](0018-networks.md), [0019](0019-everything-everyone-is-running.md) and [0020](0020-one-line-to-join.md). Completes [0028](0028-the-server-introduces-the-machines-carry.md).

## Context

After [0028](0028-the-server-introduces-the-machines-carry.md) there were two ways for a team's hosts to find each other. On a server, the server said who was on the team, which key each person signed with and where their hosts were. Without one, a network did: a secret passed as a join code, beacons on the local network, a port derived from the secret, a second port every member watched, and hosts telling each other who else they knew.

Every install can be a server since [0027](0027-what-kanzo-changed.md): `/lattice server start` and `/lattice server share` put one on a person's own machine. So a team with no machine that stays on did not need the second way either, and keeping it meant two sets of commands for one thing, two places a person's name could come from, and a second secret to pass around.

## Decision

The second way is removed. Sessions are shared with the people on the server a person has joined, and with nobody when they have joined none.

Removed:

- Creating, joining and leaving a network: `/lattice create`, `/lattice join`, `pi-lattice create`, `pi-lattice join`, `--join`, the join code, and `network.json` in the lattice home.
- Beacons on the local network, and `LATTICE_DISCOVERY`.
- The port derived from the secret and the repository, and the port every member watched. A host listens on any free port and tells the server which.
- Hosts telling each other who else they know. Who is on the team is the server's to say.

Kept, unchanged:

- The connection between two hosts: authenticated by the team's secret, encrypted, with each person's first key pinned ([0012](0012-peer-to-peer-collab.md)).
- Signed ownership logs with one writer, the two-step handoff from either side, and the transfer that is kept until the new owner signs for it.
- Hosts for different repositories connecting to look, what everyone has running, watching a session, and taking one by cloning ([0019](0019-everything-everyone-is-running.md)).
- The name a person chooses once ([0020](0020-one-line-to-join.md)). It is asked the first time they join a server.

Changed names, because there is no network to name: `/lattice network` is `/lattice team`, and the pane's first line names the server instead of a network. The settings `network.share` and `network.cloneDir` keep their keys, so nobody's settings break.

`@pi-lattice/collab` no longer finds anyone by itself. Whatever starts a `CollabSession` tells it who is on the team and where (`learn`, `heardAt`); in this repository that is the host, from what the server says.

## Consequences

- One thing to set up: a server, started or joined. One line to send a teammate: the server's address.
- A team with nothing that stays on shares a board from someone's machine. Teammates see each other's sessions while that machine is on; their own trees work without it.
- People who were in a network are in none after upgrading: `network.json` is ignored. They join a server once.
- People known from a server are forgotten when it is left, so a name that means someone else on the next server is not refused for its key.
- Two machines that cannot reach each other still cannot hand a session over, as before. The server being reachable does not change that.
