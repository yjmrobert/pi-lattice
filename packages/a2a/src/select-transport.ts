import type { HostAssignment } from "@pi-lattice/protocol";
import { FileTransport } from "./file-transport.ts";
import { HostTransport } from "./host-transport.ts";
import type { SelfInfo, Transport } from "./transport.ts";

/**
 * Choose the transport for a node (ADR 0009): the host's broker when a host has assigned
 * this session a node and is reachable, otherwise the local file spool.
 */
export async function selectTransport(home: string, self: SelfInfo, assignment: HostAssignment | undefined): Promise<Transport> {
	if (assignment) {
		try {
			return await HostTransport.connect({ socketPath: assignment.socket, token: assignment.token, self, sessionId: self.sessionId, sessionFile: self.sessionFile });
		} catch {
			// Host unreachable: fall back to the file spool so local messaging keeps working.
		}
	}
	return new FileTransport({ home, self });
}
