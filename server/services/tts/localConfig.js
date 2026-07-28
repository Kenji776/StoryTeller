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
import dns from "dns";

/** Parses a dotted-quad into its four octets, or null if it is not one. */
function ipv4Octets(ip) {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
	if (!m) return null;
	const parts = m.slice(1).map(Number);
	return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

/**
 * Whether an IP address belongs to a network the server may reach.
 *
 * @description The allowlist is deliberately narrow: loopback, the three RFC1918
 *   ranges, the carrier-grade NAT block Tailscale hands out, and IPv6 unique local
 *   addresses. Everything else — including the whole 169.254.0.0/16 link-local
 *   range, which is where every major cloud serves instance credentials — is
 *   refused. Nobody runs a speech server on an autoconfiguration address, so
 *   excluding the range costs nothing and removes the metadata-endpoint problem
 *   outright.
 * @param {*} ip - An address string; anything else is not private.
 * @returns {boolean} True when the address is on an allowed private network.
 */
export function isPrivateAddress(ip) {
	if (typeof ip !== "string" || !ip) return false;

	const lower = ip.toLowerCase();

	// IPv4-mapped IPv6 (::ffff:192.168.1.1) is judged on the address it carries.
	const mapped = /^::ffff:(.+)$/.exec(lower);
	if (mapped) return isPrivateAddress(mapped[1]);

	const v4 = ipv4Octets(lower);
	if (v4) {
		const [a, b] = v4;
		if (a === 127) return true;                       // 127.0.0.0/8   loopback
		if (a === 10) return true;                        // 10.0.0.0/8    private
		if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
		if (a === 192 && b === 168) return true;          // 192.168.0.0/16 private
		if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT / Tailscale
		return false;
	}

	if (lower === "::1") return true;                     // IPv6 loopback
	if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;    // fc00::/7 unique local

	return false;
}

/**
 * Validates a host-supplied speech server address.
 *
 * @description Shape is checked first so an obvious typo gets an obvious message,
 *   then the hostname is resolved and *every* returned address must be private.
 *   Requiring all of them matters: a name resolving to one LAN address and one
 *   public address is the shape a DNS rebinding attempt takes, and accepting it
 *   because one entry looked fine would defeat the check.
 *
 *   A missing scheme is filled in rather than rejected, because typing
 *   `192.168.1.50:8199` is the obvious thing to do.
 * @param {string} raw - Whatever the host typed.
 * @param {{lookup?: Function}} [deps] - Injected DNS resolver, for testability.
 * @returns {Promise<string>} The canonical origin, with no trailing slash.
 * @throws {Error} With a message written to be shown directly to the host.
 */
export async function validateLocalTtsUrl(raw, deps = {}) {
	const lookup = deps.lookup || dns.promises.lookup;
	const trimmed = typeof raw === "string" ? raw.trim() : "";

	if (!trimmed) throw new Error("Enter an address for the speech server, like http://192.168.1.50:8199");

	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

	let url;
	try {
		url = new URL(withScheme);
	} catch {
		throw new Error(`"${trimmed}" is not a valid address. Try something like http://192.168.1.50:8199`);
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`Only http and https addresses are supported, not "${url.protocol.replace(":", "")}"`);
	}
	if (url.username || url.password) {
		throw new Error("Remove the username and password from the address — credentials are not supported here");
	}
	if (url.pathname && url.pathname !== "/") {
		throw new Error(`Leave off the path ("${url.pathname}") — just the host and port, like http://192.168.1.50:8199`);
	}

	const hostname = url.hostname.replace(/^\[|\]$/g, "");

	let addresses;
	try {
		const result = await lookup(hostname, { all: true, verbatim: true });
		addresses = (Array.isArray(result) ? result : [result]).map((a) => a.address).filter(Boolean);
	} catch (err) {
		throw new Error(`Could not resolve "${hostname}" — check the name or use its IP address (${err.code || err.message})`);
	}

	if (!addresses.length) throw new Error(`Could not resolve "${hostname}" to any address`);

	const offender = addresses.find((a) => !isPrivateAddress(a));
	if (offender) {
		throw new Error(
			`"${hostname}" resolves to ${offender}, which is not on a private network. ` +
			"The speech server must be on your LAN, a VPN, or this machine.",
		);
	}

	return `${url.protocol}//${url.host}`;
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
