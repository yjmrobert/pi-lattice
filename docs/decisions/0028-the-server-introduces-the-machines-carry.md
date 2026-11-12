# 0028. The server introduces; the machines carry

Status: built.

## Context

[0026](0026-a-server-for-the-work.md) left sharing sessions peer to peer and planned to move it to the server, with the server holding a session in flight so that the giver and the taker need not be online together. That would put whole conversations on the server: the files read, the command output, everything an agent saw. The server has no roles and stores nothing encrypted.

Peer to peer had two halves. One is the hard part that works: an authenticated, encrypted connection between two hosts, signed ownership logs, and a transfer that is kept until the other side signs for it ([0012](0012-peer-to-peer-collab.md)). The other is how two hosts come to connect at all: a network secret passed as a join code, beacons on the local network, a port derived from the secret, a lobby port, and hosts telling each other who else they know ([0018](0018-networks.md), [0019](0019-everything-everyone-is-running.md)). The second half is what a server replaces without seeing anything.

## Decision

A session is handed over between the two machines, directly, and both must be on. The server does the introducing.

On a server, a host needs no network and no code:

- **Membership is the team.** The server gives each member the secret hosts prove membership with. It is the same proof as before; only where the secret comes from has changed.
- **The server says who is where.** A host that can be connected to tells the server its addresses and what it is working on, along with what it runs. Every host hears it, and connects. Nothing is announced on the local network and no well-known port is watched.
- **The server says who signs as whom.** Each person's public key is told to the server once and stays theirs: a different key under the same name is refused. Hosts pin what the server says.
- **Offers and requests go through the server.** Asking for a session, the offer, accepting, cancelling and declining are handed to the server for the other person's host, which takes them within a minute or not at all. They arrive whether or not the two machines can connect yet.
- **The session goes straight across.** The conversation and the branch travel on the connection between the two hosts. The server never has them.

Reading a teammate's conversation and mail between owners are unchanged, on the connection.

A host that is not on a server used a network joined by a code, as before. That was removed in [0029](0029-networks-are-gone.md): such a host now shares with nobody.

## What the server can and cannot do

It can see who offered what to whom, by session id and name. It holds the secret that admits a host to the team's connections, so whoever controls the server can connect as a member; it cannot sign as one, because it has no private key. It can refuse to pass something on. It cannot read a session.

What is handed over is signed by its author where it matters: an acceptance or a cancellation is an event in the owner's log and is checked against the pinned key, and so is the record that carries an offer. Asking and declining are not signed; for those the server's word on who sent them is taken.

## Consequences

- Joining a server is all a team does. There is no second thing to create and pass around.
- Both people must be online, and their machines must be able to connect, for a session to move: the same network, a VPN, or an open port. A server reachable from everywhere does not make two laptops behind different routers reachable to each other. An offer made to someone who is away waits on the owner's machine.
- A person's second machine needs the `identity` folder of their lattice home as well as `server.json`, or the server refuses its key.
- The name a person has on the server must be the name their host goes by; when they differ, sessions are not shared through the server, and the host says so.
- Networks joined by a code were left only for teams without a server, and have since been removed ([0029](0029-networks-are-gone.md)).
