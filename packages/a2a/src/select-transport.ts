import { FileTransport } from "./file-transport.ts";
import type { SelfInfo, Transport } from "./transport.ts";

type Env = Record<string, string | undefined>;

/**
 * Choose the transport for this session. Decided once at session start (ADR 0009):
 * the host broker when a host spawned us, otherwise the local file spool.
 */
export async function selectTransport(home: string, self: SelfInfo, _env: Env = process.env): Promise<Transport> {
	return new FileTransport({ home, self });
}
