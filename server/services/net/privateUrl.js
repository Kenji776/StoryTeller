/**
 * The private-network guard for operator-supplied service addresses.
 *
 * Several features let an operator point StoryTeller at a self-hosted service —
 * the speech server (ADR 0006), an Ollama instance, an image server. In every
 * case the *server* issues the request, not the browser, so an unvalidated
 * address is a server-side request forgery vector: whatever the server can reach,
 * a form field could reach.
 *
 * The rule is that the address must land on a private network, and it lives here
 * once rather than beside each feature. `services/tts/localConfig.js` was its
 * first home and now delegates; a second copy for Ollama is exactly the outcome
 * this module exists to prevent.
 *
 * DNS is injected, so the whole guard is exercised without a resolver and without
 * depending on what a hostname happens to point at today (CQ-5, TDD-8).
 */

import dns from "dns";

/** What an address is suggested to look like when the caller offers no example. */
const DEFAULT_EXAMPLE = "http://192.168.1.50:8199";

/**
 * @description Splits an IPv4 address into its four octets.
 * @param {string} ip - The candidate address.
 * @returns {number[]|null} The octets, or null when the value is not IPv4.
 */
function ipv4Octets(ip) {
	const parts = String(ip).split(".");
	if (parts.length !== 4) return null;
	const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
	return octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? octets : null;
}

/**
 * Reports whether an address is on a network the server is willing to dial.
 *
 * @description The allowlist is deliberately narrow: loopback, the three RFC1918
 *   ranges, the carrier-grade NAT block Tailscale hands out, and IPv6 unique local
 *   addresses. Everything else — including the whole 169.254.0.0/16 link-local
 *   range, which is where every major cloud serves instance credentials — is
 *   refused. Nobody runs a self-hosted service on an autoconfiguration address, so
 *   excluding the range costs nothing and removes the metadata-endpoint problem
 *   outright. Anything unparseable is treated as public.
 * @param {*} ip - An address string; anything else is not private.
 * @returns {boolean} True when the address is on an allowed private network.
 */
export function isPrivateAddress(ip) {
	if (typeof ip !== "string" || !ip.trim()) return false;
	const lower = ip.trim().toLowerCase();

	// IPv4-mapped IPv6 (::ffff:192.168.1.1) is judged on the address it carries.
	const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
	if (mapped) return isPrivateAddress(mapped[1]);

	const octets = ipv4Octets(lower);
	if (octets) {
		const [a, b] = octets;
		if (a === 127) return true;                        // 127.0.0.0/8   loopback
		if (a === 10) return true;                         // 10.0.0.0/8    private
		if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12 private
		if (a === 192 && b === 168) return true;           // 192.168.0.0/16 private
		if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT / Tailscale
		return false;
	}

	if (lower === "::1") return true;                      // IPv6 loopback
	if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;     // fc00::/7 unique local

	return false;
}

/**
 * Validates an operator-supplied address for a self-hosted service.
 *
 * @description Shape is checked first so an obvious typo gets an obvious message,
 *   then the hostname is resolved and *every* returned address must be private.
 *   Requiring all of them matters: a name resolving to one LAN address and one
 *   public address is the shape a DNS rebinding attempt takes, and accepting it
 *   because one entry looked fine would defeat the check.
 *
 *   A missing scheme is filled in rather than rejected, because typing
 *   `192.168.1.50:8199` is the obvious thing to do.
 * @param {string} raw - Whatever the operator typed.
 * @param {object} [deps] - Injected dependencies and message wording.
 * @param {Function} [deps.lookup] - A `dns.promises.lookup`-shaped resolver.
 * @param {string} [deps.serviceName] - What is being configured, so the message
 *   says "Ollama server" rather than something generic.
 * @param {string} [deps.example] - An address to suggest in error messages.
 * @returns {Promise<string>} The canonical origin, with no trailing slash.
 * @throws {Error} With a message written to be shown directly to the operator.
 */
export async function validatePrivateServiceUrl(raw, deps = {}) {
	const lookup = deps.lookup || dns.promises.lookup;
	const serviceName = deps.serviceName || "service";
	const example = deps.example || DEFAULT_EXAMPLE;

	const trimmed = typeof raw === "string" ? raw.trim() : "";
	if (!trimmed) throw new Error(`Enter an address for the ${serviceName}, like ${example}`);

	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

	let url;
	try {
		url = new URL(withScheme);
	} catch {
		throw new Error(`"${trimmed}" is not a valid address. Try something like ${example}`);
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`Only http and https addresses are supported, not "${url.protocol.replace(":", "")}"`);
	}
	if (url.username || url.password) {
		throw new Error("Remove the username and password from the address — credentials are not supported here");
	}
	if (url.pathname && url.pathname !== "/") {
		throw new Error(`Leave off the path ("${url.pathname}") — just the host and port, like ${example}`);
	}

	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	if (!hostname) throw new Error(`"${trimmed}" is not a valid address. Try something like ${example}`);

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
			`The ${serviceName} must be on your LAN, a VPN, or this machine.`,
		);
	}

	return `${url.protocol}//${url.host}`;
}
