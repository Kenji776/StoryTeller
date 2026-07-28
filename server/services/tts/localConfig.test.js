import { test } from "node:test";
import assert from "node:assert/strict";

import {
	isPrivateAddress,
	validateLocalTtsUrl,
	loadLocalTtsUrl,
	saveLocalTtsUrl,
} from "./localConfig.js";

/**
 * Builds an in-memory stand-in for the filesystem calls the config makes.
 *
 * @param {object} [seed] - Initial path→contents map.
 * @returns {object} An fs-shaped double exposing the seeded `files` map.
 */
function makeFs(seed = {}) {
	const files = { ...seed };
	return {
		files,
		existsSync: (p) => Object.hasOwn(files, p),
		readFileSync: (p) => {
			if (!Object.hasOwn(files, p)) throw new Error(`ENOENT: ${p}`);
			return files[p];
		},
		writeFileSync: (p, data) => { files[p] = data; },
		mkdirSync: () => {},
	};
}

/**
 * Builds a DNS lookup double.
 *
 * @description Resolution is injected so the unit tier never depends on a real
 *   resolver, a network, or what a hostname happens to point at today (`TDD-8`).
 * @param {object} table - Hostname → array of addresses, or an Error to throw.
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

const LAN = makeLookup({
	"192.168.1.50": [{ address: "192.168.1.50", family: 4 }],
	"127.0.0.1": [{ address: "127.0.0.1", family: 4 }],
	"localhost": [{ address: "127.0.0.1", family: 4 }],
	"tts-box.local": [{ address: "192.168.1.77", family: 4 }],
	"nas": [{ address: "10.1.2.3", family: 4 }],
	"evil.example.com": [{ address: "93.184.216.34", family: 4 }],
	"rebind.example.com": [{ address: "192.168.1.5", family: 4 }, { address: "8.8.8.8", family: 4 }],
	"v6box": [{ address: "fd00::1", family: 6 }],
	"v6public": [{ address: "2606:4700::1111", family: 6 }],
	"metadata": [{ address: "169.254.169.254", family: 4 }],
	"tailscale-box": [{ address: "100.101.102.103", family: 4 }],
});

const deps = { lookup: LAN };

// ===== isPrivateAddress =====

test("isPrivateAddress accepts the three RFC1918 ranges", () => {
	assert.equal(isPrivateAddress("10.0.0.1"), true);
	assert.equal(isPrivateAddress("172.16.5.4"), true);
	assert.equal(isPrivateAddress("192.168.1.50"), true);
});

test("isPrivateAddress accepts loopback", () => {
	assert.equal(isPrivateAddress("127.0.0.1"), true);
	assert.equal(isPrivateAddress("127.1.2.3"), true);
	assert.equal(isPrivateAddress("::1"), true);
});

test("isPrivateAddress accepts the carrier-grade NAT range Tailscale uses", () => {
	assert.equal(isPrivateAddress("100.64.0.1"), true);
	assert.equal(isPrivateAddress("100.101.102.103"), true);
});

test("isPrivateAddress accepts IPv6 unique local addresses", () => {
	assert.equal(isPrivateAddress("fd00::1"), true);
	assert.equal(isPrivateAddress("fc00::abcd"), true);
});

test("isPrivateAddress accepts an IPv4-mapped IPv6 private address", () => {
	assert.equal(isPrivateAddress("::ffff:192.168.1.50"), true);
});

test("isPrivateAddress rejects public addresses", () => {
	assert.equal(isPrivateAddress("93.184.216.34"), false);
	assert.equal(isPrivateAddress("8.8.8.8"), false);
	assert.equal(isPrivateAddress("2606:4700::1111"), false);
});

test("isPrivateAddress rejects the link-local range that holds the cloud metadata endpoint", () => {
	// 169.254.169.254 serves instance credentials on every major cloud. Nobody runs
	// a speech server on an autoconfiguration address, so the whole range stays out.
	assert.equal(isPrivateAddress("169.254.169.254"), false);
	assert.equal(isPrivateAddress("169.254.1.1"), false);
	assert.equal(isPrivateAddress("fe80::1"), false);
});

test("isPrivateAddress rejects boundary addresses just outside the private ranges", () => {
	assert.equal(isPrivateAddress("9.255.255.255"), false);
	assert.equal(isPrivateAddress("11.0.0.0"), false);
	assert.equal(isPrivateAddress("172.15.255.255"), false);
	assert.equal(isPrivateAddress("172.32.0.0"), false);
	assert.equal(isPrivateAddress("192.167.255.255"), false);
	assert.equal(isPrivateAddress("192.169.0.0"), false);
	assert.equal(isPrivateAddress("100.63.255.255"), false);
	assert.equal(isPrivateAddress("100.128.0.0"), false);
});

test("isPrivateAddress accepts the first and last address of each private range", () => {
	assert.equal(isPrivateAddress("10.0.0.0"), true);
	assert.equal(isPrivateAddress("10.255.255.255"), true);
	assert.equal(isPrivateAddress("172.16.0.0"), true);
	assert.equal(isPrivateAddress("172.31.255.255"), true);
	assert.equal(isPrivateAddress("192.168.0.0"), true);
	assert.equal(isPrivateAddress("192.168.255.255"), true);
});

test("isPrivateAddress rejects junk rather than throwing", () => {
	for (const junk of ["", "not-an-ip", null, undefined, 42, {}, "999.999.999.999"]) {
		assert.equal(isPrivateAddress(junk), false, `${JSON.stringify(junk)} must not be treated as private`);
	}
});

// ===== validateLocalTtsUrl =====

test("validateLocalTtsUrl accepts a LAN address with an explicit port", async () => {
	assert.equal(await validateLocalTtsUrl("http://192.168.1.50:8199", deps), "http://192.168.1.50:8199");
});

test("validateLocalTtsUrl accepts loopback", async () => {
	assert.equal(await validateLocalTtsUrl("http://127.0.0.1:8199", deps), "http://127.0.0.1:8199");
});

test("validateLocalTtsUrl accepts a hostname that resolves onto the LAN", async () => {
	assert.equal(await validateLocalTtsUrl("http://tts-box.local:8199", deps), "http://tts-box.local:8199");
});

test("validateLocalTtsUrl accepts a bare hostname on the LAN", async () => {
	assert.equal(await validateLocalTtsUrl("http://nas:8199", deps), "http://nas:8199");
});

test("validateLocalTtsUrl accepts an IPv6 unique local address", async () => {
	assert.equal(await validateLocalTtsUrl("http://v6box:8199", deps), "http://v6box:8199");
});

test("validateLocalTtsUrl strips a trailing slash", async () => {
	assert.equal(await validateLocalTtsUrl("http://192.168.1.50:8199/", deps), "http://192.168.1.50:8199");
});

test("validateLocalTtsUrl trims surrounding whitespace a paste can leave behind", async () => {
	assert.equal(await validateLocalTtsUrl("  http://192.168.1.50:8199  ", deps), "http://192.168.1.50:8199");
});

test("validateLocalTtsUrl supplies http:// when the scheme is omitted", async () => {
	// Typing "192.168.1.50:8199" is the obvious thing to do and should just work.
	assert.equal(await validateLocalTtsUrl("192.168.1.50:8199", deps), "http://192.168.1.50:8199");
});

test("validateLocalTtsUrl rejects an empty value with a usable message", async () => {
	await assert.rejects(() => validateLocalTtsUrl("", deps), { message: /enter an address/i });
	await assert.rejects(() => validateLocalTtsUrl("   ", deps), { message: /enter an address/i });
	await assert.rejects(() => validateLocalTtsUrl(null, deps), { message: /enter an address/i });
});

test("validateLocalTtsUrl rejects a non-http scheme", async () => {
	await assert.rejects(() => validateLocalTtsUrl("ftp://192.168.1.50:8199", deps), { message: /http/i });
	await assert.rejects(() => validateLocalTtsUrl("file:///etc/passwd", deps), { message: /http/i });
});

test("validateLocalTtsUrl rejects a public address and says why", async () => {
	await assert.rejects(
		() => validateLocalTtsUrl("http://evil.example.com", deps),
		{ message: /93\.184\.216\.34.*private network|not on a private network/i },
	);
});

test("validateLocalTtsUrl rejects a hostname that does not resolve", async () => {
	await assert.rejects(() => validateLocalTtsUrl("http://nosuchhost:8199", deps), { message: /could not resolve/i });
});

test("validateLocalTtsUrl rejects when any resolved address is public", async () => {
	// A name resolving to both a LAN address and a public one is the shape a DNS
	// rebinding attempt takes; accepting it because one entry looked fine would
	// defeat the check entirely.
	await assert.rejects(() => validateLocalTtsUrl("http://rebind.example.com", deps), { message: /private network/i });
});

test("validateLocalTtsUrl rejects the cloud metadata endpoint", async () => {
	await assert.rejects(() => validateLocalTtsUrl("http://metadata", deps), { message: /private network/i });
});

test("validateLocalTtsUrl rejects a public IPv6 address", async () => {
	await assert.rejects(() => validateLocalTtsUrl("http://v6public", deps), { message: /private network/i });
});

test("validateLocalTtsUrl accepts a Tailscale address", async () => {
	assert.equal(await validateLocalTtsUrl("http://tailscale-box:8199", deps), "http://tailscale-box:8199");
});

test("validateLocalTtsUrl rejects a URL carrying a path, which would break endpoint joins", async () => {
	await assert.rejects(() => validateLocalTtsUrl("http://192.168.1.50:8199/some/path", deps), { message: /path/i });
});

test("validateLocalTtsUrl rejects embedded credentials", async () => {
	await assert.rejects(() => validateLocalTtsUrl("http://user:pass@192.168.1.50:8199", deps), { message: /username|password|credential/i });
});

// ===== loadLocalTtsUrl / saveLocalTtsUrl =====

test("loadLocalTtsUrl returns the fallback when no config has been written", () => {
	const fsImpl = makeFs();
	assert.equal(loadLocalTtsUrl({ fsImpl, configPath: "/cfg/tts.json", fallback: "http://127.0.0.1:8199" }), "http://127.0.0.1:8199");
});

test("loadLocalTtsUrl returns the saved address", () => {
	const fsImpl = makeFs({ "/cfg/tts.json": JSON.stringify({ localTtsUrl: "http://192.168.1.50:9000" }) });
	assert.equal(loadLocalTtsUrl({ fsImpl, configPath: "/cfg/tts.json", fallback: "http://127.0.0.1:8199" }), "http://192.168.1.50:9000");
});

test("loadLocalTtsUrl prefers the saved address over the environment fallback", () => {
	// Once a host has configured a server through the UI, a stale env var must not
	// silently win on the next restart.
	const fsImpl = makeFs({ "/cfg/tts.json": JSON.stringify({ localTtsUrl: "http://10.0.0.9:8199" }) });
	assert.equal(loadLocalTtsUrl({ fsImpl, configPath: "/cfg/tts.json", fallback: "http://127.0.0.1:8199" }), "http://10.0.0.9:8199");
});

test("loadLocalTtsUrl falls back when the config file is corrupt", () => {
	const fsImpl = makeFs({ "/cfg/tts.json": "{ not json" });
	assert.equal(loadLocalTtsUrl({ fsImpl, configPath: "/cfg/tts.json", fallback: "http://127.0.0.1:8199" }), "http://127.0.0.1:8199");
});

test("loadLocalTtsUrl falls back when the config holds no address", () => {
	const fsImpl = makeFs({ "/cfg/tts.json": JSON.stringify({ somethingElse: true }) });
	assert.equal(loadLocalTtsUrl({ fsImpl, configPath: "/cfg/tts.json", fallback: "http://127.0.0.1:8199" }), "http://127.0.0.1:8199");
});

test("saveLocalTtsUrl writes an address that loadLocalTtsUrl reads back", () => {
	const fsImpl = makeFs();
	const opts = { fsImpl, configPath: "/cfg/tts.json", fallback: "http://127.0.0.1:8199" };
	saveLocalTtsUrl("http://192.168.1.50:9000", opts);
	assert.equal(loadLocalTtsUrl(opts), "http://192.168.1.50:9000");
});

test("saveLocalTtsUrl overwrites a previously saved address", () => {
	const fsImpl = makeFs({ "/cfg/tts.json": JSON.stringify({ localTtsUrl: "http://10.0.0.9:8199" }) });
	const opts = { fsImpl, configPath: "/cfg/tts.json", fallback: "" };
	saveLocalTtsUrl("http://192.168.1.50:9000", opts);
	assert.equal(loadLocalTtsUrl(opts), "http://192.168.1.50:9000");
});

test("saveLocalTtsUrl writes readable JSON rather than an opaque blob", () => {
	const fsImpl = makeFs();
	saveLocalTtsUrl("http://192.168.1.50:9000", { fsImpl, configPath: "/cfg/tts.json" });
	assert.equal(JSON.parse(fsImpl.files["/cfg/tts.json"]).localTtsUrl, "http://192.168.1.50:9000");
});

test("saveLocalTtsUrl surfaces a write failure rather than silently discarding the setting", () => {
	const fsImpl = makeFs();
	fsImpl.writeFileSync = () => { throw new Error("EACCES: permission denied"); };
	assert.throws(
		() => saveLocalTtsUrl("http://192.168.1.50:9000", { fsImpl, configPath: "/cfg/tts.json" }),
		{ message: /EACCES/ },
	);
});
