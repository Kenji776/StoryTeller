/**
 * Runs the narrator model picker against a live `ai:state`.
 *
 * The unit tests for `modelChoices` all passed while the panel told a host that Anthropic needed an
 * API key on a server that had been narrating with Anthropic all day. The fixture was the reason:
 * it omitted the per-provider `ready` flag, so the implementation read the service-level
 * `providerId` — which names the *first* provider that could serve, not the one holding a key — and
 * no assertion could see the difference.
 *
 * This probe closes that gap by feeding the picker the real payload. It asserts nothing about which
 * providers a given server has keys for, because that is deployment configuration; it asserts the
 * two things that are true of any server: what is running must be selectable, and every provider
 * the server reports as ready must not be labelled as needing a key.
 *
 * Usage: node server/test-integration/model-picker-probe.mjs [--url http://localhost:3013]
 */

import { readFile } from "node:fs/promises";
import { io } from "socket.io-client";

import { modelChoices, keyFormFor, credentialSubmission } from "../../client/aiPanel.js";

const args = process.argv.slice(2);
const urlAt = args.indexOf("--url");
const BASE = urlAt >= 0 ? args[urlAt + 1] : "http://localhost:3013";

/**
 * @description Waits for one named event, so a missing emit fails loudly instead of hanging.
 * @param {object} socket - A connected socket.
 * @param {string} event - The event name.
 * @param {number} [ms] - How long to wait.
 * @returns {Promise<object>} The payload.
 * @throws {Error} When the event does not arrive in time.
 */
function once(socket, event, ms = 15000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
		socket.once(event, (payload) => {
			clearTimeout(timer);
			resolve(payload);
		});
	});
}

/**
 * @description Creates a lobby as its host, which is the only role that may change the narrator's
 *   model — a probe joining as a guest would be told "host only" and prove nothing.
 * @returns {Promise<{socket: object, lobbyId: string, lobby: object}>} The joined lobby.
 * @throws {Error} When the lobby cannot be created or joined.
 */
async function hostALobby() {
	const socket = io(BASE, { transports: ["websocket"] });
	await once(socket, "connect");
	socket.emit("lobby:create", {});
	const created = await once(socket, "lobby:created");
	// Joining is by code, not by id, and the settings arrive on the broadcast that follows.
	socket.emit("lobby:join", { code: created.code });
	await once(socket, "lobby:joined");
	const lobby = await once(socket, "state:update");
	return { socket, lobbyId: created.lobbyId, lobby };
}

const failures = [];

/**
 * @description Records a failed expectation rather than throwing, so one probe run reports every
 *   problem instead of only the first.
 * @param {boolean} condition - What must hold.
 * @param {string} message - What it means when it does not.
 * @returns {void}
 */
function expect(condition, message) {
	if (!condition) failures.push(message);
}

const { socket, lobbyId, lobby } = await hostALobby();
console.log(`lobby ${lobbyId}`);

socket.emit("ai:state:request", { lobbyId });
const aiState = await once(socket, "ai:state");
const catalogue = JSON.parse(await readFile(new URL("../../client/config/llm_models.json", import.meta.url), "utf8"));

const chat = aiState.services?.find((s) => s.capability === "chat") ?? null;
console.log("\nai:state chat service, as the server sends it:");
console.log(`  state=${chat?.state} providerId=${chat?.providerId}`);
for (const option of chat?.options ?? []) {
	console.log(`  option ${option.id}: requiresApiKey=${option.requiresApiKey} needsPlayerKey=${option.needsPlayerKey} ready=${option.ready}`);
}

const choices = modelChoices(aiState, lobby, catalogue.providers ?? catalogue);

console.log(`\nrunning now: ${choices.current.providerId} · ${choices.current.modelId}`);
console.log("\nwhat the panel would show:");
for (const provider of choices.providers) {
	const models = choices.modelsFor(provider.id);
	const listing = choices.freeTextFor(provider.id) ? "typed by hand" : `${models.length} models`;
	console.log(`  ${provider.label.padEnd(22)} key: ${String(provider.keySource).padEnd(7)} ${provider.selectable ? "selectable " : "unavailable"} ${listing.padEnd(14)} — ${provider.note}`);
}

// The provider narrating right now must be usable. If the picker disables it, pressing Apply on the
// panel cannot reproduce the state the game is already in — which is how the first version shipped.
const running = choices.providers.find((p) => p.id === choices.current.providerId);
expect(running != null, `the provider in use (${choices.current.providerId}) is missing from the picker entirely`);
if (running) {
	expect(running.selectable, `the provider in use (${running.id}) is not selectable — the panel cannot re-apply what the game is running`);
	expect(running.keySource !== "none", `the provider in use (${running.id}) is marked as having no key`);
}

// A provider the server reports as ready has a key by definition, whoever supplied it.
for (const option of chat?.options ?? []) {
	if (option.ready !== true) continue;
	const shown = choices.providers.find((p) => p.id === option.id);
	expect(shown?.keySource !== "none", `${option.id} is ready on the server but the panel says it needs a key`);
	expect(shown?.selectable === true, `${option.id} is ready on the server but the panel will not let a host pick it`);
}

// The model in force is always offered, even when the shipped catalogue has never heard of it —
// otherwise opening the panel and pressing Apply silently downgrades the lobby.
if (choices.current.providerId && choices.current.modelId && !choices.freeTextFor(choices.current.providerId)) {
	const offered = choices.modelsFor(choices.current.providerId).some((m) => m.id === choices.current.modelId);
	expect(offered, `the model in force (${choices.current.modelId}) is not among the models offered for ${choices.current.providerId}`);
}

// ── Bringing your own key ────────────────────────────────────────────────────

// The picker lists providers this server holds no key for so a host can discover that their own key
// is an option. That promise is only payable if the form actually appears for those providers, and
// the form refuses to render without the server's own consent wording.
const capabilities = await (await fetch(`${BASE}/api/capabilities`)).json();
expect(typeof capabilities.consentTerms === "string" && capabilities.consentTerms.length > 0,
	"/api/capabilities carries no consentTerms — the key form will render a loading notice forever");

console.log("\nwhat supplying your own key would ask for:");
for (const provider of choices.providers) {
	const form = keyFormFor(aiState, provider.id);
	const asks = [form.requiresKey ? "key" : null, form.requiresBaseUrl ? "address" : null].filter(Boolean);
	console.log(`  ${provider.label.padEnd(26)} ${form.needed ? `asks for ${asks.join(" + ") || "nothing"}` : "asks nothing"}`
		+ `${form.keyUrl ? ` · ${form.keyUrl}` : ""}`);

	// The two halves have to agree: a provider the picker calls unusable must be one the form can fix,
	// and a provider that works must not be asked about.
	if (provider.keySource === "none") {
		expect(form.needed, `${provider.id} is unselectable but the key form offers no way to fix that`);
		expect(form.requiresKey || form.requiresBaseUrl,
			`${provider.id} needs setup but the form asks for neither a key nor an address`);
	}
	if (provider.keySource === "server") {
		expect(!form.needed, `${provider.id} is served by this server's key, yet the form still asks for one`);
	}
}

// ── The round trip ───────────────────────────────────────────────────────────

// Everything above checks what the panel would *show*. This checks that pressing Save works: the
// payload `credentialSubmission` builds is one `ai:credential:set` accepts, and the state that comes
// back turns the provider selectable. The key is deliberately fake and this lobby is disposable — it
// never reaches a provider, and nothing here may ever carry a real credential (TDD-14).
const byok = choices.providers.find((p) => keyFormFor(aiState, p.id).needed && keyFormFor(aiState, p.id).requiresKey);

if (!byok) {
	console.log("\nno provider on this server wants a host key — round trip not exercised");
} else {
	const submission = credentialSubmission({
		lobbyId, capability: "chat", providerId: byok.id,
		apiKey: "test-token-DO-NOT-USE", consent: true,
	});
	expect(!Object.values(submission).includes(undefined), "the submission carries an undefined field");

	const saved = await new Promise((resolve) => {
		socket.emit("ai:credential:set", submission, resolve);
		setTimeout(() => resolve({ ok: false, error: "no reply from ai:credential:set" }), 15000);
	});

	console.log(`\nsaving a fake key for ${byok.label}: ${saved?.ok ? "accepted" : `refused — ${saved?.error}`}`);
	expect(saved?.ok === true, `ai:credential:set refused the panel's own payload: ${saved?.error}`);

	if (saved?.ok) {
		const after = modelChoices(saved.state, lobby, catalogue.providers ?? catalogue);
		const now = after.providers.find((p) => p.id === byok.id);
		expect(now?.keySource === "own", `after saving, ${byok.id} reads as "${now?.keySource}" rather than the host's own key`);
		expect(now?.selectable === true, `after saving, ${byok.id} is still not selectable`);

		const form = keyFormFor(saved.state, byok.id);
		expect(form.canReplace, "a host who supplied a key is not offered the chance to change it");
		expect(form.held.length > 0, "the panel shows nothing about the key it is holding");
		expect(!form.held.includes("test-token"), "the key itself is being echoed back into the panel");
		console.log(`  now reads: key ${now?.keySource}, ${now?.selectable ? "selectable" : "unavailable"} — ${form.held}`);
	}
}

// ── What the free-text model field may carry ─────────────────────────────────

// The picker offers a text field for providers whose models cannot be enumerated, and whatever is
// stored there renders into every player's lobby panel. A model id has a shape; markup is not it.
const hostile = `<img src=x onerror="alert(1)">`;
const toasted = new Promise((resolve) => {
	socket.once("toast", resolve);
	setTimeout(() => resolve(null), 8000);
});
socket.emit("lobby:settings", { lobbyId, llmModel: hostile });

const toast = await toasted;
const afterState = await new Promise((resolve) => {
	socket.once("state:update", resolve);
	setTimeout(() => resolve(null), 8000);
});

console.log(`\nstoring markup as the model id: ${toast ? `refused — "${toast.message}"` : "no refusal came back"}`);
expect(toast?.type === "error", "a model id containing markup was accepted without complaint");
expect((afterState ?? lobby).llmModel !== hostile, "markup was stored as the lobby's model id");
expect(!(toast?.message ?? "").includes("<img"), "the refusal echoes the rejected markup back into the page");

socket.disconnect();

if (failures.length) {
	console.log(`\n${failures.length} problem(s):`);
	for (const failure of failures) console.log(`  ✗ ${failure}`);
	process.exit(1);
}
console.log("\n✓ the picker agrees with the server about what can serve");
