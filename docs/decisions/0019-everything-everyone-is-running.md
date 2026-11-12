# 0019 Everyone's sessions in every repository, watched while looked at, and taken with a clone

**How hosts find each other (the port every member watched, beacons) was replaced by the team's server in [0028](0028-the-server-introduces-the-machines-carry.md) and [0029](0029-networks-are-gone.md). The rest stands.**

Changes two earlier rules. [0018](0018-networks.md) said two hosts connect only when they work on the same repository. [0012](0012-peer-to-peer-collab.md) said nothing is streamed between machines. Both are relaxed here, narrowly.

**Why**

Under 0018 a teammate's sessions showed only in repositories both people had a tree in. The point of a network is to see what the team is doing; work in a repository you had not opened was invisible, and you could not find out it existed. And a session opened for reading was a snapshot: to see what it did next, you opened it again.

**Decision**

- **Hosts for different repositories connect, as guests.** A guest may ask who is in the network, what the other person has running, and read or watch one of their sessions. Nothing else: offers, requests, mail and transfers still need both hosts to be for the same repository, and a guest that asks for more is refused.
- **Any one of a person's hosts answers for all of them.** Each host writes what it has running to the person's lattice home; a host asked "what do you have running" reads them all, skipping any whose process is gone. Teammates are told when that changes and ask again.
- **One port every member knows.** Besides its own port, each host tries to take a port derived from the network's secret alone. Whichever of a person's hosts gets it is where a teammate who shares no repository with them first asks; the others keep trying and take over when it stops. Beacons on the local network are now heard whatever repository they are for, to the same end.
- **What a teammate has elsewhere is kept as last heard**, like their sessions in a shared repository, and shown as away when they cannot be reached.
- **The pane lists those repositories after your own**, each marked as not on this machine and folded until you come to look. Their sessions can be read, and asked for.
- **A session under the cursor is watched.** While the pane shows a teammate's session, it keeps asking for it; its owner's host then sends each new message as it is written, and stops about twenty seconds after the asking stops. This is per message, not per word, and only for a session someone is looking at. Nothing else is streamed.
- **Taking a session from a repository you do not have clones it first.** The repository's address is its owner's `origin`. The person is shown it, and the folder, before anything is fetched; the folder is asked for once and kept as `network.cloneDir`. Then that repository's host is started, finds the owner's, and the request goes as usual. With no `origin` there is nothing to clone and the pane says so.
- **`network.share`, per repository.** Switched off for a repository, its host stays out of the network: its tree is shown to nobody and no teammate's sessions appear in it.
- **A host stays up while a session is on its way.** An open offer, request or unfinished transfer counts as work, so a host started only to receive a session does not exit before it arrives.

**Rejected**

- **One host per person for the whole network.** It would make "what do you have running" trivial, but trees, sessions and worktrees belong to a repository and its host, and a second kind of process would have to be started, found and kept alive.
- **Streaming every session to everyone.** Most sessions are watched by nobody. Sending on request costs nothing while nobody looks.
- **Shipping the whole repository in the handoff** when there is no `origin`. A branch bundle is one thing; a repository is another, and its owner has not said it may leave their machine.

**Costs accepted**

- **Everyone sees everything.** Every member can read every session of every other member, in repositories they may have no access to, unless its owner switches `network.share` off there. The names of those repositories and their clone addresses are told too.
- **A clone address comes from a teammate's machine.** It is shown before use, refused if it could be read as an option, and only ever handed to `git clone`. A member could still name a repository other than the one they claim; the session then never shows up in it, because a repository is known by its first commit.
- **Watching polls.** The owner's host re-reads a watched session once a second. A reply shows when it is complete.
- **The well-known port can be taken** by something else on the machine. That person is then found by beacon, through a shared repository, or not at all until one of those is possible.
- **More connections.** Each of a person's hosts may hold one to each teammate.

**Evidence**

`packages/collab/test` covers two people with no repository in common, one host answering for another, reading a session from the host that has it, being led from one of a teammate's hosts to their host for the same repository, what is kept when someone goes, guests being refused anything but looking, and watching, including a rewound conversation and a watcher who stops. `test/integration/network.test.ts` does the same through background hosts with real sessions. `test/integration/teammates.test.ts` drives a real Pi through its prompts: create a network, read a teammate's session in a repository that is not there, take it, and find it owned in the clone.

**Not verified**

Two physically separate machines, a VPN, and a clone over a real remote with credentials. See [the manual script](../two-machine-handoff.md).
