import { test } from "node:test";
import assert from "node:assert/strict";

import { isPrivateAddress, validatePrivateServiceUrl } from "./privateUrl.js";

/**
 * Builds a DNS lookup double.
 *
 * @description Resolution is injected so the unit tier never depends on a real
 *   resolver, a network, or what a hostname happens to point at today (`TDD-8`).
 * @param {object} table - Hostname → array of address records, or an Error to throw.
 * @returns {Function} A `dns.promises.lookup`-shaped function.
 */
function makeLookup(table) {
	return async (hostname) => {
		const entry = table[hostname];
		if (entry instanceof Error) throw entry;
		if (!entry) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
		return entry;
	};
}

const lookup = makeLookup({
	"192.168.1.20": [{ address: "192.168.1.20", family: 4 }],
	"127.0.0.1": [{ address: "127.0.0.1", family: 4 }],
	"ollama-box": [{ address: "10.0.0.5", family: 4 }],
	"public.example.com": [{ address: "93.184.216.34", family: 4 }],
	"rebind.example.com": [{ address: "192.168.1.20", family: 4 }, { address: "93.184.216.34", family: 4 }],
	"v6local": [{ address: "fd00::1", family: 6 }],
	"v6public": [{ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }],
});

const deps = { lookup };

// ── isPrivateAddress ─────────────────────────────────────────────────────────

test("loopback, RFC1918 and CGNAT ranges are private", () => {
	for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.4.1", "172.31.255.254", "192.168.1.20", "100.64.0.1"]) {
		assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
	}
});

test("public addresses are not private", () => {
	for (const ip of ["93.184.216.34", "8.8.8.8", "172.15.0.1", "172.32.0.1", "100.128.0.1"]) {
		assert.equal(isPrivateAddress(ip), false, `${ip} should not be private`);
	}
});

test("IPv6 loopback and unique-local addresses are private", () => {
	assert.equal(isPrivateAddress("::1"), true);
	assert.equal(isPrivateAddress("fd00::1"), true);
	assert.equal(isPrivateAddress("fc00::abcd"), true);
});

test("a public IPv6 address is not private", () => {
	assert.equal(isPrivateAddress("2606:2800:220:1:248:1893:25c8:1946"), false);
});

test("an IPv4-mapped IPv6 address is judged on the address it carries", () => {
	assert.equal(isPrivateAddress("::ffff:192.168.1.20"), true);
	assert.equal(isPrivateAddress("::ffff:93.184.216.34"), false);
});

test("anything that is not an address string is not private", () => {
	for (const value of [null, undefined, 42, {}, [], "", "not an ip"]) {
		assert.equal(isPrivateAddress(value), false);
	}
});

// ── validatePrivateServiceUrl: accepted ──────────────────────────────────────

test("a LAN address with an explicit port is accepted and returned canonically", async () => {
	assert.equal(await validatePrivateServiceUrl("http://192.168.1.20:11434", deps), "http://192.168.1.20:11434");
});

test("a hostname resolving onto the LAN is accepted", async () => {
	assert.equal(await validatePrivateServiceUrl("http://ollama-box:11434", deps), "http://ollama-box:11434");
});

test("a missing scheme is filled in rather than rejected", async () => {
	assert.equal(await validatePrivateServiceUrl("192.168.1.20:11434", deps), "http://192.168.1.20:11434");
});

test("trailing slashes and surrounding whitespace are stripped", async () => {
	assert.equal(await validatePrivateServiceUrl("  http://192.168.1.20:11434/  ", deps), "http://192.168.1.20:11434");
});

test("an IPv6 unique local address is accepted", async () => {
	assert.equal(await validatePrivateServiceUrl("http://v6local:11434", deps), "http://v6local:11434");
});

// ── validatePrivateServiceUrl: refused ───────────────────────────────────────

test("a public address is refused and the offending address is named", async () => {
	await assert.rejects(
		() => validatePrivateServiceUrl("http://public.example.com", deps),
		{ message: /93\.184\.216\.34.*private network/i },
	);
});

test("a name resolving to both a private and a public address is refused", async () => {
	await assert.rejects(
		() => validatePrivateServiceUrl("http://rebind.example.com", deps),
		{ message: /private network/i },
	);
});

test("a public IPv6 address is refused", async () => {
	await assert.rejects(() => validatePrivateServiceUrl("http://v6public", deps), { message: /private network/i });
});

test("a hostname that does not resolve is refused", async () => {
	await assert.rejects(() => validatePrivateServiceUrl("http://nosuchhost:11434", deps), { message: /could not resolve/i });
});

test("a non-http scheme is refused", async () => {
	await assert.rejects(() => validatePrivateServiceUrl("ftp://192.168.1.20:11434", deps), { message: /http/i });
	await assert.rejects(() => validatePrivateServiceUrl("file:///etc/passwd", deps), { message: /http/i });
});

test("an address carrying a path is refused", async () => {
	await assert.rejects(() => validatePrivateServiceUrl("http://192.168.1.20:11434/api", deps), { message: /path/i });
});

test("an address embedding credentials is refused", async () => {
	await assert.rejects(
		() => validatePrivateServiceUrl("http://user:pass@192.168.1.20:11434", deps),
		{ message: /username|password|credential/i },
	);
});

test("an empty or absent address is refused with a usable message", async () => {
	for (const value of ["", "   ", null, undefined, 42]) {
		await assert.rejects(() => validatePrivateServiceUrl(value, deps), { message: /enter an address/i });
	}
});

test("an unparseable address is refused", async () => {
	await assert.rejects(() => validatePrivateServiceUrl("http://", deps), { message: /valid address|enter an address/i });
});

// ── The messages name the service being configured ───────────────────────────

test("the service name given by the caller appears in the empty-value message", async () => {
	await assert.rejects(
		() => validatePrivateServiceUrl("", { ...deps, serviceName: "Ollama server" }),
		{ message: /Ollama server/ },
	);
});

test("the service name given by the caller appears in the public-address message", async () => {
	await assert.rejects(
		() => validatePrivateServiceUrl("http://public.example.com", { ...deps, serviceName: "Ollama server" }),
		{ message: /Ollama server/ },
	);
});

test("the example address given by the caller is the one suggested", async () => {
	await assert.rejects(
		() => validatePrivateServiceUrl("", { ...deps, example: "http://10.0.0.5:11434" }),
		{ message: /10\.0\.0\.5:11434/ },
	);
});

test("a caller naming no service still produces a message that reads properly", async () => {
	await assert.rejects(() => validatePrivateServiceUrl("", deps), { message: /enter an address for the/i });
});

// ── Property ─────────────────────────────────────────────────────────────────

test("validation is idempotent over its own output", async () => {
	const once = await validatePrivateServiceUrl("192.168.1.20:11434/", deps);
	assert.equal(await validatePrivateServiceUrl(once, deps), once);
});
