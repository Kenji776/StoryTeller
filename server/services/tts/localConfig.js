/**
 * Where the local speech server lives, and whether we are willing to dial it.
 *
 * The address is host-configurable through the settings window, because a
 * self-hosted TTS server can be on any machine and any port on the operator's
 * network and there is no way to guess it. That makes it untrusted input reaching
 * a `fetch` the *server* performs, so every address is resolved and required to
 * land on a private network before it is accepted — see
 * [ADR 0006](../../../docs/decisions/0006-host-configurable-local-tts-address.md).
 *
 * The chosen address is server-wide, not per lobby: it describes the deployment,
 * not the story, and nobody wants to retype it for every new game.
 */

import fs from "fs";
import path from "path";
import { isPrivateAddress, validatePrivateServiceUrl } from "../net/privateUrl.js";

/** How an address is described to a host configuring the speech server. */
const SERVICE_NAME = "speech server";
const EXAMPLE_URL = "http://192.168.1.50:8199";

export { isPrivateAddress };

/**
 * Validates a host-supplied speech server address.
 *
 * @description The guard itself lives in `services/net/privateUrl.js`, because the
 *   speech server is no longer the only self-hosted service an operator can point
 *   this app at — Ollama and a local image server need exactly the same check, and
 *   a second copy of an SSRF guard is how one of them ends up subtly weaker.
 * @param {string} raw - Whatever the host typed.
 * @param {{lookup?: Function}} [deps] - Injected DNS resolver, for testability.
 * @returns {Promise<string>} The canonical origin, with no trailing slash.
 * @throws {Error} With a message written to be shown directly to the host.
 */
export async function validateLocalTtsUrl(raw, deps = {}) {
	return validatePrivateServiceUrl(raw, { lookup: deps.lookup, serviceName: SERVICE_NAME, example: EXAMPLE_URL });
}

/**
 * Reads the configured speech server address.
 *
 * @description A saved address beats the environment: once a host has pointed the
 *   game at a real server through the settings window, a stale `LOCAL_TTS_URL`
 *   left over in a compose file must not silently win on the next restart.
 * @param {{fsImpl?: object, configPath: string, fallback?: string}} opts
 * @returns {string} The saved address, or the fallback when none is stored.
 */
export function loadLocalTtsUrl({ fsImpl = fs, configPath, fallback = "" }) {
	try {
		if (!fsImpl.existsSync(configPath)) return fallback;
		const parsed = JSON.parse(fsImpl.readFileSync(configPath, "utf8"));
		return parsed?.localTtsUrl || fallback;
	} catch {
		// A corrupt config must not stop the server booting; the host can simply
		// re-enter the address.
		return fallback;
	}
}

/**
 * Persists the speech server address so it survives a restart.
 *
 * @description Write failures are deliberately *not* swallowed. Silently
 *   discarding the setting would leave the host looking at a working connection
 *   that vanishes on the next restart, with nothing to explain it.
 * @param {string} url - An address already through `validateLocalTtsUrl`.
 * @param {{fsImpl?: object, configPath: string}} opts
 * @returns {void}
 * @throws {Error} If the file cannot be written.
 */
export function saveLocalTtsUrl(url, { fsImpl = fs, configPath }) {
	fsImpl.mkdirSync(path.dirname(configPath), { recursive: true });
	fsImpl.writeFileSync(configPath, JSON.stringify({ localTtsUrl: url }, null, 2));
}
