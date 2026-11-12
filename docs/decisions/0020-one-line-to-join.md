# 0020 One line to join, and a name you choose

**The join code was removed by [0029](0029-networks-are-gone.md): the one line is now the server's address. The chosen name stands.**

Adds to [0018](0018-networks.md). Nothing there is withdrawn.

**Why**

Getting a second machine into a network took more than the one step it was meant to. A person had to send a throwaway message first, so that a tree and its host existed. They then opened a menu, picked an entry and pasted a code. Their name was their OS user name, which two machines of one person share, and which is often not what teammates call them. When nobody was found, the pane stayed empty and said nothing.

**Decision**

- **A person chooses the name teammates see, once per machine.** They are asked the first time they create or join a network; enter keeps the OS user name. It is kept in one file in the lattice home, `name`, and every repository's host uses it. `LATTICE_OWNER` and `--as` still say who a single run acts as, and a chosen name does not replace them.
- **What was theirs stays theirs.** Each tree remembers the name it was last run under. A host started under another name carries the person's own sessions over to it. A running host does not change name: it stays out of the network until it is restarted, which the pane does at once for the repository the person is in, and which other repositories' hosts do by themselves as soon as nobody is using them.
- **The name is fixed while in a network.** Teammates pinned a key to it. Changing it means leaving first; what was signed under the old name is dropped and made again under the new one.
- **Joining is one line.** Creating a network answers with `/lattice join <code>`, ready to send. `/lattice join <code> [name]` and `/lattice create [network] [name]` do the whole thing; `pi-lattice join <code>` and `pi-lattice create` do it from a shell, with no host running, because hosts follow the network file. A code pasted with the command around it is accepted anywhere a code is.
- **No session tree is needed first.** The network commands start this repository's host themselves.
- **Not finding anyone is said.** After joining, the pane waits ten seconds for a teammate. Then it lists each address it tried and why it did not answer, in words (nothing listening, no answer, no route), and what to change. "Look for teammates again" does the same.

**Rejected**

- **Renaming while in a network.** It needs the old key to sign the node over to the new name and every teammate to accept the pairing. Leaving and joining again is rare enough.
- **Asking for the name at install.** Most people who install never join a network; the question belongs where the answer is first shown to someone else.

**Costs accepted**

- **Leaving, renaming and rejoining the same network** makes sessions the teammates remember under the old name new sessions to them; their old records of those do not match and are not replaced.
- **A tree last run before this change** is assumed to have been under the OS user name.
- **The ten-second wait is a guess.** A teammate found later is shown in the pane, not announced.
