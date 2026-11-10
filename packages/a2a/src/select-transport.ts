import { HOST_ENV } from "@pi-lattice/protocol";
import { FileTransport } from "./file-transport.ts";
import { HostTransport } from "./host-transport.ts";
import type { SelfInfo, Transport } from "./transport.ts";

type Env = Record<string, string | undefined>;

/**
 * Choose the transport for this session. Decided once at session start (ADR 0009):
 * the host broker when a host spawned us and is reachable, otherwise the local file spool.
 */
export async function selectTransport(home: string, self: SelfInfo, env: Env = process.env): Promise<Transport> {
	const socketPath = env[HOST_ENV.socket];
	const token = env[HOST_ENV.token];
	if (socketPath && token) {
		try {
			return await HostTransport.connect({ socketPath, token, self, sessionId: self.sessionId, sessionFile: self.sessionFile });
		} catch {
			// Host unreachable: fall back to the file spool so local messaging keeps working.
		}
	}
	return new FileTransport({ home, self });
}
