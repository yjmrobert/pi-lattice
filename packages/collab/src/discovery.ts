/**
 * Finding teammates on the local network without being told where they are. Each host says,
 * every few seconds and to whoever is listening on the LAN, "a member of this network is
 * working on this, on this port". A host that hears another dials it: as a peer when it is
 * working on the same thing, and otherwise to learn what that person has running.
 *
 * A beacon is a hint, never trusted: it carries a keyed hash so that strangers' beacons are
 * ignored, and the connection it leads to is authenticated like any other. Where multicast
 * does not reach (most VPNs), hosts find each other through the machines they already know
 * and the port they share; see `sharedPort`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
import { networkInterfaces } from "node:os";
import { isPersonName } from "./identity.ts";
import { networkTag, scopeTag } from "./network.ts";

export interface Discovery {
	/** Start announcing `port` and listening. `onPeer` is called with a member's name, `host:port`, and whether they are working on the same thing. */
	start(port: number, onPeer: (name: string, address: string, same: boolean) => void): Promise<void>;
	stop(): Promise<void>;
}

export interface Beacon {
	name: string;
	port: number;
}

export interface HeardBeacon extends Beacon {
	/** Whether it is for the same work as the reader's. */
	same: boolean;
}

const sign = (key: Buffer, net: string, scope: string, beacon: Beacon): Buffer => createHmac("sha256", key).update(`beacon|${net}|${scope}|${beacon.name}|${beacon.port}`).digest();

/** A beacon for one network and one piece of work. Only members can make one, or tell what work it is for. */
export function encodeBeacon(key: Buffer, scope: string, beacon: Beacon): Buffer {
	const net = networkTag(key);
	const s = scopeTag(key, scope);
	return Buffer.from(JSON.stringify({ v: 1, net, s, name: beacon.name, port: beacon.port, mac: sign(key, net, s, beacon).toString("base64") }));
}

/** Read a beacon. Anything not made by a member of this network is nothing. */
export function decodeBeacon(key: Buffer, scope: string, bytes: Buffer): HeardBeacon | undefined {
	try {
		if (bytes.length > 1024) return undefined;
		const value = JSON.parse(bytes.toString("utf8")) as { v?: unknown; net?: unknown; s?: unknown; name?: unknown; port?: unknown; mac?: unknown };
		const net = networkTag(key);
		if (value.v !== 1 || value.net !== net || typeof value.s !== "string" || !isPersonName(value.name) || typeof value.mac !== "string") return undefined;
		if (typeof value.port !== "number" || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) return undefined;
		const beacon = { name: value.name, port: value.port };
		const given = Buffer.from(value.mac, "base64");
		const expected = sign(key, net, value.s, beacon);
		return given.length === expected.length && timingSafeEqual(given, expected) ? { ...beacon, same: value.s === scopeTag(key, scope) } : undefined;
	} catch {
		return undefined;
	}
}

export interface LanDiscoveryOptions {
	key: Buffer;
	scope: string;
	name: string;
	group?: string;
	udpPort?: number;
	intervalMs?: number;
}

const localAddresses = (): string[] =>
	Object.values(networkInterfaces())
		.flatMap((addresses) => addresses ?? [])
		.filter((address) => address.family === "IPv4" && !address.internal)
		.map((address) => address.address);

/** Multicast on the local network. Best effort: where it cannot work it stays silent. */
export class LanDiscovery implements Discovery {
	private readonly options: LanDiscoveryOptions;
	private socket: Socket | undefined;
	private timer: NodeJS.Timeout | undefined;

	constructor(options: LanDiscoveryOptions) {
		this.options = options;
	}

	async start(port: number, onPeer: (name: string, address: string, same: boolean) => void): Promise<void> {
		const { key, scope, name } = this.options;
		const group = this.options.group ?? "239.255.71.71";
		const udpPort = this.options.udpPort ?? 47609;
		const socket = createSocket({ type: "udp4", reuseAddr: true });
		this.socket = socket;
		socket.on("error", () => {});
		socket.on("message", (bytes, from) => {
			const beacon = decodeBeacon(key, scope, bytes);
			if (beacon && beacon.name !== name) onPeer(beacon.name, `${from.address}:${beacon.port}`, beacon.same);
		});
		const bound = await new Promise<boolean>((resolve) => {
			socket.once("error", () => resolve(false));
			socket.bind(udpPort, () => resolve(true));
		});
		if (!bound) return;
		const message = encodeBeacon(key, scope, { name, port });
		const announce = (): void => {
			const interfaces = localAddresses();
			try {
				socket.setMulticastLoopback(true);
				for (const address of interfaces) {
					try {
						socket.addMembership(group, address);
					} catch {
						// Already a member on this interface, or it cannot do multicast.
					}
					try {
						socket.setMulticastInterface(address);
						socket.send(message, udpPort, group);
					} catch {
						// This interface cannot send; the others may.
					}
				}
				if (interfaces.length === 0) socket.send(message, udpPort, group);
			} catch {
				// Discovery is a convenience; a host that cannot announce is still reachable.
			}
		};
		announce();
		this.timer = setInterval(announce, this.options.intervalMs ?? 5000);
		this.timer.unref();
	}

	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		const socket = this.socket;
		this.socket = undefined;
		if (socket) await new Promise<void>((resolve) => socket.close(() => resolve())).catch(() => {});
	}
}
