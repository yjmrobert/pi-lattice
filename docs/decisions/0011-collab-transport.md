# 0011 Collab transport: a shared git repository, with signed records

**Superseded by [0012](0012-peer-to-peer-collab.md).** Kept for the record of what was built first and why it was replaced. Identities, signed ownership logs and the lease state machine carried over; the shared repository, compare-and-swap and polling did not.

**Decision**

Two people share a tree through a private git repository that both can push to. Each person runs their own host; the hosts never talk to each other directly.

- **Compare-and-swap** is a rejected non-fast-forward push. Every change is a transaction that re-runs against the other person's commit when it loses the race, so two conflicting writes can never both land.
- **Identity** is an Ed25519 key pair per person, created on first use and kept in `~/.pi/agent/lattice/identity/`. Everything a person writes to the shared repository is signed. A reader believes a signature only after the human has trusted that person's key, by comparing its fingerprint out of band. The key is pinned; a different key later is reported as changed and not believed.
- **Ownership is a signed log, not a field.** A node's record holds who created it and the list of handoff events. Owner and version are recomputed by replaying the log through the lease state machine in `protocol`, skipping anything that is not signed by the person it names. Nobody can become owner by editing a file, because there is no owner field to edit.
- **There is no central lease authority.** The state machine, the signatures and the compare-and-swap together are the authority. Both hosts reach the same answer from the same log.
- **`collab` is a library the host loads, not a Pi extension.** Ownership is a property of the tree, which lives in the host. Keeping it out of the sessions keeps the code that runs beside a model small.

**Why git and not a relay or object storage**

Both people already have git and a place to host a private repository; no server has to be run or exposed; history gives an audit trail of every ownership change. A relay would be faster but is one more thing to run and secure. Object storage with conditional writes would work, and the `SharedStore` interface (a transactional file tree) is small enough to add one later.

**Costs accepted**

- Latency: hosts poll (5 seconds by default). A handoff takes a few polls, not milliseconds.
- A transferred session travels through the repository, and git history keeps it after the working copy removes it. The shared repository must be private to the collaborators, and the release step says so before sending.
- Signed timestamps are the signer's own clock. Offer expiry is therefore advisory between people who trust each other, not a defence against a hostile collaborator.

**Evidence**

`packages/collab/test` covers the compare-and-swap race, forged and tampered signatures, a takeover attempt by a non-owner, a changed key, expiry, cancel, replayed steps and forged mail. `test/integration/collab.test.ts` runs two real hosts with separate Pi configurations, project checkouts and keys through a full handoff, including the conversation and the branch, and mail held for approval in both directions.

**Not verified**

Two physically separate machines over a network remote. The test uses one machine with two isolated hosts and a local bare repository. See [the manual script](../two-machine-handoff.md).
