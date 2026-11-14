# 0034. A server encrypts by itself, and its address says which server it is

Status: built. Changes the "plain HTTP" cost accepted in [0026](0026-a-server-for-the-work.md) and [0027](0027-what-kanzo-changed.md).

## Context

The server spoke plain HTTP and left TLS to whatever was put in front of it. Everything a host says to it crossed the network in the clear: the code that lets someone join, each person's token, the team's work, and the secret that admits a host to the team's connections ([0028](0028-the-server-introduces-the-machines-carry.md)). Whoever could listen on the network could join the team, and from there read every session.

A board shared from a laptop has nothing in front of it and no domain name, so a certificate from an authority is not something its owner can get. Telling people to use a VPN is advice, not a property.

## Decision

A server makes its own certificate the first time it starts, and the address teammates are given carries its fingerprint.

- **The address is still one line.** After the code comes a dot and the fingerprint: `https://host:port/#code.fingerprint`. Nothing else is passed around, typed or approved.
- **The fingerprint is the check.** A client given one sees the server's certificate before it sends anything, and goes on only if it is the one the fingerprint was made from. Every later request is made to that certificate and no other. The certificate names nobody and does not expire: neither a name nor a date is what is trusted.
- **One port.** The server takes TLS and plain HTTP on the same port, telling them apart by the first byte, so a board keeps the address it had.
- **Plain HTTP only from the server's own machine.** A board's own hosts speak to it over loopback, as before, and so can a proxy in front. Anyone else speaking plainly is answered with what to do, and nothing they sent is acted on.
- **Someone already on a server takes its address again.** Given the address of the server they are on, with a fingerprint it did not have, `/lattice server` keeps who they are there and changes only how it is reached.
- **`pi-lattice server` encrypts unless told its address is `http://`.** `--url http://...` says something in front does the encrypting, and it then speaks plain HTTP to everyone, as it did.

The certificate is kept beside the work (`tls.key`, private to the user, and `tls.crt`), so the address holds across restarts.

## Why not

- **Trust the certificate on first use.** Whoever is in the way the first time is trusted from then on, and the first time is when the code is sent.
- **A certificate authority, or a public name.** A laptop on a home network has neither, and the board is for exactly that.
- **A second port for TLS.** Two addresses for one server, and one of them the wrong one to give out.
- **Shelling out to `openssl`, or a library, to write the certificate.** A program that may not be there, or a dependency for the few dozen bytes Node cannot write itself. They are encoded in `packages/server/src/cert.ts` and checked by Node's own parser and by `openssl` in the tests and by hand.

## Consequences

- Passing the address on whole matters: the fingerprint in it is what stops someone in between. Sent over a channel someone else can change, it protects nothing, as with the code before it.
- A server whose `tls.key` is lost has a new fingerprint. Everyone on it takes its address again; nobody loses their name.
- Someone who joined a shared board in the clear is turned away from another machine once the board encrypts, and told to take its address again. Their last request before that went in the clear, as all of them did.
- A proxy on the server's own machine is taken for the machine itself, and may speak plainly to it.
- Whoever controls the server still sees everything on it ([0028](0028-the-server-introduces-the-machines-carry.md)). This is about the network between a host and the server, not about the server.

## Evidence

`packages/server/test/server.test.ts`: the certificate verifies as its own and is kept; a pinned address is joined and used over TLS; a server holding another key, at the right address and knowing the code, is sent nothing; a member whose server is replaced is turned away; plain HTTP is answered from this machine and refused from elsewhere; the server stops at once with connections open. `test/integration/work.test.ts`: a shared board gives out encrypted addresses that a teammate joins with, and someone on a server takes its address again and stays who they are.

By hand: `pi-lattice server` joined from another lattice home and used through `pi-lattice work`; `openssl s_client` shows TLS 1.3 and a certificate whose SHA-256 is the fingerprint in the address.

## Not verified

Two machines on a real network. Every run above is on one machine.
