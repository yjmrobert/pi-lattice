/**
 * An authenticated, encrypted channel between two hosts, over any byte stream.
 *
 * Handshake (a signed ephemeral Diffie-Hellman exchange):
 *
 *   1. initiator -> responder   hello: name, identity key, ephemeral X25519 key, nonce
 *   2. responder -> initiator   hello: the same, plus a signature over both hellos
 *   3. initiator -> responder   a signature over both hellos (first encrypted frame)
 *
 * Each side checks the other's signature against the key it has pinned for that name. Frame
 * keys come from the ephemeral exchange, so recorded traffic cannot be decrypted later with
 * an identity key. Frames are length-prefixed ChaCha20-Poly1305 with a per-direction counter.
 *
 * Inside a network, steps 2 and 3 also carry a keyed hash of the handshake under the
 * network's secret. That is what lets a member in: someone whose name is not pinned yet is
 * pinned once they prove they hold the secret, and nobody without it connects at all. A
 * pinned name that turns up with a different key is still refused, secret or not.
 *
 * This is a standard construction built from Node's primitives. It has tests, but it has
 * not had an independent security review.
 */
import { createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, type KeyObject, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";
import { canonicalJson } from "./canonical.ts";
import { type Identity, isPersonName, verifyBytes } from "./identity.ts";
import { checkMemberProof, memberProof, networkTag } from "./network.ts";

const VERSION = 1;
const CONTEXT = "pi-lattice-peer-v1";
const MAX_FRAME = 128 * 1024 * 1024;
const MAX_HELLO = 4096;

interface Hello {
	v: number;
	name: string;
	key: string;
	e: string;
	n: string;
	/** The network's public label, when the sender is in one. */
	net?: string;
	/** What the sender is working on. Two hosts connect only when it is the same thing. */
	scope?: string;
}

export interface ChannelOptions {
	identity: Identity;
	/** True for the side that opened the connection. */
	initiator: boolean;
	/** The pinned public key for a person, or undefined when they are not trusted. */
	keyOf(name: string): string | undefined;
	/** The name the initiator expects to reach. A different name fails the handshake. */
	expect?: string;
	/** The network's secret. With it, the other side must prove they hold it too, and that is enough to let a new name in. */
	network?: Buffer;
	/** What this host is working on, such as a repository. The other side must say the same. */
	scope?: string;
	/** Told when someone new proved they are in the network, so their key can be pinned. */
	onMember?(name: string, publicKey: string): void;
	/** Told about an authenticated-looking peer whose key is not pinned and who is not let in. */
	onStranger?(name: string, publicKey: string): void;
	/** Told when someone uses a paired name with a key other than the pinned one. */
	onChangedKey?(name: string, publicKey: string): void;
	timeoutMs?: number;
}

export class HandshakeError extends Error {
	override readonly name = "HandshakeError";
}

export interface ChannelEvents {
	message: [value: unknown];
	close: [];
}

/** An open channel. `send` takes any JSON value; `message` delivers the peer's. */
export class SecureChannel extends EventEmitter<ChannelEvents> {
	/** The authenticated name of the person at the other end. */
	readonly peer: string;
	private readonly stream: Duplex;
	private readonly sendKey: Buffer;
	private readonly receiveKey: Buffer;
	private sendCounter = 0n;
	private receiveCounter = 0n;
	private buffer: Buffer;
	private closed = false;

	/** @internal Use {@link openChannel}. */
	constructor(stream: Duplex, peer: string, sendKey: Buffer, receiveKey: Buffer, leftover: Buffer, sendCounter: bigint, receiveCounter: bigint) {
		super();
		this.stream = stream;
		this.peer = peer;
		this.sendKey = sendKey;
		this.receiveKey = receiveKey;
		this.buffer = leftover;
		this.sendCounter = sendCounter;
		this.receiveCounter = receiveCounter;
		stream.on("data", (chunk: Buffer) => {
			this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
			this.drain();
		});
		stream.on("close", () => this.finish());
		stream.on("error", () => this.finish());
		// Frames can arrive in the same packet as the end of the handshake, before the caller
		// has had a chance to listen. They wait in the buffer until someone does.
		(this as EventEmitter).on("newListener", (event: string | symbol) => {
			if (event === "message") queueMicrotask(() => this.drain());
		});
	}

	private drain(): void {
		try {
			for (;;) {
				if (this.listenerCount("message") === 0) return;
				const result = readFrame(this.buffer, this.receiveKey, this.receiveCounter);
				if (!result) return;
				this.buffer = result.rest;
				this.receiveCounter++;
				this.emit("message", JSON.parse(result.plain.toString("utf8")));
			}
		} catch {
			this.close(); // a frame that does not authenticate ends the channel
		}
	}

	send(value: unknown): void {
		if (this.closed) return;
		this.stream.write(sealFrame(Buffer.from(JSON.stringify(value), "utf8"), this.sendKey, this.sendCounter++));
	}

	get isClosed(): boolean {
		return this.closed;
	}

	close(): void {
		if (this.closed) return;
		this.stream.destroy();
		this.finish();
	}

	private finish(): void {
		if (this.closed) return;
		this.closed = true;
		this.emit("close");
	}
}

function nonceFor(counter: bigint): Buffer {
	const nonce = Buffer.alloc(12);
	nonce.writeBigUInt64BE(counter, 4);
	return nonce;
}

function sealFrame(plain: Buffer, key: Buffer, counter: bigint): Buffer {
	const cipher = createCipheriv("chacha20-poly1305", key, nonceFor(counter), { authTagLength: 16 });
	const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
	if (body.length > MAX_FRAME) throw new Error("That is too large to send in one piece.");
	const header = Buffer.alloc(4);
	header.writeUInt32BE(body.length);
	return Buffer.concat([header, body]);
}

/** Read one frame if the buffer holds a whole one. Throws when it does not authenticate. */
function readFrame(buffer: Buffer, key: Buffer, counter: bigint): { plain: Buffer; rest: Buffer } | undefined {
	if (buffer.length < 4) return undefined;
	const length = buffer.readUInt32BE(0);
	if (length < 16 || length > MAX_FRAME) throw new Error("bad frame length");
	if (buffer.length < 4 + length) return undefined;
	const body = buffer.subarray(4, 4 + length);
	const decipher = createDecipheriv("chacha20-poly1305", key, nonceFor(counter), { authTagLength: 16 });
	decipher.setAuthTag(body.subarray(length - 16));
	const plain = Buffer.concat([decipher.update(body.subarray(0, length - 16)), decipher.final()]);
	return { plain, rest: buffer.subarray(4 + length) };
}

function transcriptHash(role: "init" | "resp", first: Hello, second: Hello): Buffer {
	return createHash("sha256").update(`${CONTEXT}|${role}|${canonicalJson(first)}|${canonicalJson(second)}`).digest();
}

function parseHello(line: string): Hello {
	let value: Partial<Hello>;
	try {
		value = JSON.parse(line) as Partial<Hello>;
	} catch {
		throw new HandshakeError("The other side did not speak the pi-lattice protocol.");
	}
	if (value.v !== VERSION) throw new HandshakeError(`The other side uses protocol version ${String(value.v)}; this one uses ${VERSION}.`);
	if (!isPersonName(value.name) || typeof value.key !== "string" || typeof value.e !== "string" || typeof value.n !== "string") {
		throw new HandshakeError("The other side sent a malformed greeting.");
	}
	return {
		v: VERSION, name: value.name, key: value.key, e: value.e, n: value.n,
		...(typeof value.net === "string" ? { net: value.net } : {}),
		...(typeof value.scope === "string" ? { scope: value.scope } : {}),
	};
}

/** Run the handshake over a fresh stream. Resolves with an open channel, or rejects and destroys the stream. */
export function openChannel(stream: Duplex, options: ChannelOptions): Promise<SecureChannel> {
	return new Promise<SecureChannel>((resolve, reject) => {
		const ephemeral = generateKeyPairSync("x25519");
		const mine: Hello = {
			v: VERSION,
			name: options.identity.name,
			key: options.identity.publicKey,
			e: ephemeral.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
			n: randomBytes(16).toString("base64"),
			...(options.network ? { net: networkTag(options.network) } : {}),
			...(options.scope !== undefined ? { scope: options.scope } : {}),
		};
		/** Someone not pinned yet, who gets in only by proving they hold the network's secret. */
		let newcomer = false;
		let buffer: Buffer = Buffer.alloc(0);
		let settled = false;
		let theirs: Hello | undefined;
		let keys: { send: Buffer; receive: Buffer } | undefined;

		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			stream.destroy();
			reject(error);
		};
		const timer = setTimeout(() => fail(new HandshakeError("The other side did not complete the handshake in time.")), options.timeoutMs ?? 10_000);
		const onClose = (): void => fail(new HandshakeError("The connection closed during the handshake."));
		const cleanup = (): void => {
			clearTimeout(timer);
			stream.off("data", onData);
			stream.off("close", onClose);
			stream.off("error", onClose);
		};

		/** Check who they claim to be against what the human has pinned, and derive the frame keys. */
		const accept = (hello: Hello): void => {
			if (options.expect !== undefined && hello.name !== options.expect) throw new HandshakeError(`Expected to reach ${options.expect}, but ${hello.name} answered.`);
			if (hello.name === options.identity.name) throw new HandshakeError("Refusing a connection from someone using your own name.");
			if (options.network && hello.net !== mine.net) throw new HandshakeError(`${hello.name} is not in your network.`);
			if (hello.scope !== mine.scope) throw new HandshakeError(`${hello.name} is working on something else.`);
			const pinned = options.keyOf(hello.name);
			if (pinned === undefined) {
				if (!options.network) {
					options.onStranger?.(hello.name, hello.key);
					throw new HandshakeError(`${hello.name} is not someone you have paired with.`);
				}
				newcomer = true;
			} else if (pinned !== hello.key) {
				options.onChangedKey?.(hello.name, hello.key);
				throw new HandshakeError(`${hello.name} presented a different key from the one you know them by.`);
			}
			let theirEphemeral: KeyObject;
			try {
				theirEphemeral = createPublicKey({ key: Buffer.from(hello.e, "base64"), type: "spki", format: "der" });
			} catch {
				throw new HandshakeError("The other side sent a malformed key.");
			}
			const [first, second] = options.initiator ? [mine, hello] : [hello, mine];
			const secret = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: theirEphemeral });
			const salt = createHash("sha256").update(`${CONTEXT}|${canonicalJson(first)}|${canonicalJson(second)}`).digest();
			const toResponder = Buffer.from(hkdfSync("sha256", secret, salt, "initiator to responder", 32));
			const toInitiator = Buffer.from(hkdfSync("sha256", secret, salt, "responder to initiator", 32));
			keys = options.initiator ? { send: toResponder, receive: toInitiator } : { send: toInitiator, receive: toResponder };
			theirs = hello;
		};

		/** Inside a network, the other side must show the keyed hash of this handshake. */
		const member = (transcript: Buffer, proof: unknown, who: string): void => {
			if (options.network && !checkMemberProof(options.network, transcript, proof)) throw new HandshakeError(`${who} could not prove they are in your network.`);
		};
		const proofOf = (transcript: Buffer): { mac?: string } => (options.network ? { mac: memberProof(options.network, transcript) } : {});

		const finish = (sendCounter: bigint, receiveCounter: bigint): void => {
			if (settled || !theirs || !keys) return;
			settled = true;
			cleanup();
			if (newcomer) options.onMember?.(theirs.name, theirs.key);
			resolve(new SecureChannel(stream, theirs.name, keys.send, keys.receive, buffer, sendCounter, receiveCounter));
		};

		const takeLine = (): string | undefined => {
			const newline = buffer.indexOf(0x0a);
			if (newline < 0) {
				if (buffer.length > MAX_HELLO) throw new HandshakeError("The other side sent an oversized greeting.");
				return undefined;
			}
			const line = buffer.subarray(0, newline).toString("utf8");
			buffer = buffer.subarray(newline + 1);
			return line;
		};

		const onData = (chunk: Buffer): void => {
			buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
			try {
				if (options.initiator) {
					if (theirs) return;
					const line = takeLine();
					if (line === undefined) return;
					const parsed = JSON.parse(line) as Hello & { sig?: unknown; mac?: unknown };
					const hello = parseHello(line);
					accept(hello);
					if (typeof parsed.sig !== "string" || !verifyBytes(transcriptHash("resp", mine, hello), parsed.sig, hello.key)) {
						throw new HandshakeError(`${hello.name} could not prove who they are.`);
					}
					member(transcriptHash("resp", mine, hello), parsed.mac, hello.name);
					// Step 3: prove ourselves, as the first encrypted frame.
					const ours = transcriptHash("init", mine, hello);
					const proof = Buffer.from(JSON.stringify({ sig: options.identity.signBytes(ours), ...proofOf(ours) }), "utf8");
					stream.write(sealFrame(proof, (keys as { send: Buffer }).send, 0n));
					finish(1n, 0n);
				} else if (!theirs) {
					const line = takeLine();
					if (line === undefined) return;
					const hello = parseHello(line);
					accept(hello);
					const ours = transcriptHash("resp", hello, mine);
					stream.write(`${JSON.stringify({ ...mine, sig: options.identity.signBytes(ours), ...proofOf(ours) })}\n`);
					onData(Buffer.alloc(0));
				} else {
					const frame = readFrame(buffer, (keys as { receive: Buffer }).receive, 0n);
					if (!frame) return;
					buffer = frame.rest;
					const proof = JSON.parse(frame.plain.toString("utf8")) as { sig?: unknown; mac?: unknown };
					if (typeof proof.sig !== "string" || !verifyBytes(transcriptHash("init", theirs, mine), proof.sig, theirs.key)) {
						throw new HandshakeError(`${theirs.name} could not prove who they are.`);
					}
					member(transcriptHash("init", theirs, mine), proof.mac, theirs.name);
					finish(0n, 1n);
				}
			} catch (error) {
				fail(error instanceof HandshakeError ? error : new HandshakeError("The handshake failed: the other side's messages did not verify."));
			}
		};

		stream.on("data", onData);
		stream.on("close", onClose);
		stream.on("error", onClose);
		if (options.initiator) stream.write(`${JSON.stringify(mine)}\n`);
	});
}
