# 0027. What Kanzo changed: a board on your own machine, and work that agents take

Status: built.

## Context

[0026](0026-a-server-for-the-work.md) was designed from a description of [Kanzo](https://github.com/emanuele-em/kanzo), which could not be found at the time. It has since been read (version 0.4.2). It is a kanban board that coding agents use through MCP, and it differs from 0026 in two ways that matter.

**Nothing is deployed.** 0026 needed someone to run `pi-lattice server` on a machine before anyone had an issue. In Kanzo every install is the board; sharing it with other computers is a switch, and joining someone else's is one command. A machine that stays on, like a Raspberry Pi, is the same program left running.

**Agents take work; they are not only given it.** 0026 let agents read and write issues, and put a session on an issue someone chose. Kanzo's agents ask for the next task. For that to be safe it has three things 0026 lacked: tasks that wait on other tasks, tasks marked as a person's, and a review column that agents move to, leaving done to the person.

Kanzo is AGPL-3.0. Its design was read; none of its code is used.

## Decision

1. **A board on a person's own machine.** `/lattice server start` starts the same server 0026 describes, as a process of its own, keeping its work in the lattice home and listening only to that machine. `/lattice server share` restarts it open to the network and prints the address teammates join with; `share off` closes it. The person's hosts, one per repository, are all clients of it, exactly as they are of a team's server.

   Nobody is in charge of the board. A host that finds it gone starts it; if two do so at once, the one that gets the port stays and the other exits. Unshared, it stops after ten minutes with no host asking. This is not the leader election the move to a server was meant to avoid: it is on one machine, and the operating system decides.

   It is one command and not automatic, because once a host is on a server the canopy draws issues instead of the session tree.

2. **`work_next`.** The server picks the lowest-numbered issue that is in a state sessions take from, is not for a person, is unassigned or the asker's, has nothing unfinished under it, waits on nothing unfinished, and is not for another repository; starts it; and assigns it. One step, on the one writer, so two sessions never get the same issue.

3. **`waitsOn`, `human`, `repo` on an issue.** These are part of the issue and not fields in the scheme, because the server acts on them. Waiting that could never end (an issue waiting, however far along, on itself) is refused. A dropped issue holds nothing; an issue in review still does.

4. **Review by default.** The default scheme gains a `review` state, and a session's result moves its issue there. Closing it is a person's. This is a rule in the scheme: `onReport: "done"` gives the old behaviour.

5. **A state to take from.** `rules.take` names the one state sessions take issues from; others of kind open, such as a backlog, wait for a person to release them. Absent, every open state is taken from.

6. **A `url` field** in the default scheme, for where the work can be looked at.

## Not taken

- **Projects found from a git remote.** Issues are the team's and cross repositories. An issue may name a repository, by the folder's name, which is weaker than Kanzo's remote.
- **No logins.** Joining still takes the code, and every request a personal token.
- **Board order.** Kanzo's cards are dragged into the order agents take them. Here it is by number.
- **MCP, a browser board, images, a filter language, export, sync through git.** The canopy is the board; the tools are Pi's.

## Consequences

- One person gets issues, a structure and the canopy over them with one command and nothing to run.
- A team can start on someone's laptop and move to a machine that stays on later. Moving means copying one file (`board/work.db`) and joining again; there is no command for it.
- A shared board is reachable only while its machine is on, over plain HTTP. For anything beyond a trusted network it needs a VPN or TLS in front, as before.
- A background process outlives the Pi sessions that started it, for up to ten minutes, or for as long as it is shared.
- Existing servers are migrated in place: issues gain three columns. A server whose scheme was never edited is on the default and so gains `review`; one whose scheme was edited keeps its states and rules.
