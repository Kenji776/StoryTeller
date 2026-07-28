/**
 * providers — where the operator decides who pays for every third-party call.
 *
 * The only section that talks to a REST endpoint rather than the socket bridge:
 * `/api/admin/providers` is gated on a password admin session, which the socket
 * is not, and credentials have no business travelling over a channel every lobby
 * shares.
 *
 * All the logic lives in `core/providers.js` and is unit tested; this file
 * arranges elements and nothing else (see `docs/testing.md`).
 */

import { h, fill } from "../ui/dom.js";
import { panel, group, field, row, textInput, numberInput, select, button, empty, flash, chip } from "../ui/components.js";
import { providerRows, policyOptions, keyStatusLabel, readinessLabel, policyPayload } from "../core/providers.js";

/** What each policy means, in the operator's terms. */
const POLICY_LABELS = Object.freeze({
	local: "Local service — free, no key",
	shared: "Share this server's key",
	byok: "Players bring their own key",
	off: "Not offered",
});

/**
 * Which chip tone suits a readiness line.
 *
 * Only the tones `components.js` actually styles — `ok`, `warn`, `danger`, `info`.
 * An invented one renders as an unstyled `is-whatever` class, which looks like a
 * missing state rather than a broken stylesheet.
 */
const TONE_BY_POLICY = Object.freeze({ local: "ok", shared: "ok", byok: "warn", off: "info" });

/**
 * @description Calls the provider admin API and parses its answer.
 * @param {string} url - The endpoint, relative to the origin.
 * @param {object} [options] - Method and body.
 * @returns {Promise<object>} The parsed response body.
 * @throws {Error} When the request failed, carrying the server's own message.
 */
async function api(url, { method = "GET", body } = {}) {
	const res = await fetch(url, {
		method,
		headers: body ? { "Content-Type": "application/json" } : {},
		body: body ? JSON.stringify(body) : undefined,
	});
	const payload = await res.json().catch(() => ({}));
	if (!res.ok) throw Object.assign(new Error(payload.error || `Request failed (${res.status})`), { field: payload.field });
	return payload;
}

/**
 * @description Renders the Providers section.
 * @param {object} ctx - The section context.
 * @returns {HTMLElement} The section.
 */
export function providers(ctx) {
	const host = h("div");
	const note = flash();

	/**
	 * @description Reloads everything from the server and redraws.
	 * @returns {Promise<void>} Resolves once drawn.
	 */
	async function reload() {
		try {
			const { capabilities } = await api("/api/admin/providers");
			draw(providerRows(capabilities));
		} catch (err) {
			fill(host, empty(`Could not load provider configuration: ${err.message}`));
		}
	}

	/**
	 * @description Builds the editor for one provider.
	 * @param {object} entry - A provider row.
	 * @returns {HTMLElement} The card.
	 */
	function card(entry) {
		const options = policyOptions(entry);
		const policyPicker = select({
			options: options.map((id) => ({ value: id, label: POLICY_LABELS[id] })),
			value: options.includes(entry.policy) ? entry.policy : "off",
			props: { "aria-label": `${entry.label} policy` },
		});

		const allowlist = textInput({
			value: (entry.sharedModels ?? []).join(", "),
			placeholder: "Any model — or list them, comma separated",
			"aria-label": `${entry.label} shared models`,
		});
		const cap = numberInput({
			value: entry.maxCallsPerLobby ?? "",
			min: 1,
			placeholder: "Unlimited",
			"aria-label": `${entry.label} call cap`,
		});
		const address = textInput({
			value: entry.baseUrl ?? "",
			placeholder: entry.defaultBaseUrl || "http://192.168.1.50:11434",
			"aria-label": `${entry.label} address`,
		});
		const keyField = textInput({
			type: "password",
			placeholder: entry.key?.configured ? "Replace the stored key" : "Paste an API key",
			"aria-label": `${entry.label} API key`,
		});

		const keyLine = h("span.muted.small", {}, keyStatusLabel(entry.key));
		const cardNote = flash();

		/** Shows only the controls the chosen policy actually uses. */
		const sharedBlock = h("div", {}, field("Models this key may be used for", allowlist, "Leave blank to allow any."), field("Calls per game", cap, "Leave blank for no limit."));
		const localBlock = h("div", {}, field("Address", address, "Must be on your LAN, a VPN, or this machine."));
		const keyBlock = h("div", {},
			field("API key", keyField, "Stored encrypted. It is never sent back to this page."),
			row(
				button({
					label: "Save key",
					variant: "primary",
					small: true,
					onClick: async () => {
						try {
							const { provider } = await api(`/api/admin/providers/${entry.capability}/${entry.id}/key`, {
								method: "PUT",
								body: { apiKey: keyField.value },
							});
							keyField.value = "";
							keyLine.textContent = keyStatusLabel(provider.key);
							cardNote.show("Key saved.");
						} catch (err) { cardNote.show(err.message, "danger"); }
					},
				}),
				button({
					label: "Remove key",
					small: true,
					confirm: `Remove the stored ${entry.label} key?`,
					onClick: async () => {
						try {
							const { provider } = await api(`/api/admin/providers/${entry.capability}/${entry.id}/key`, { method: "DELETE" });
							keyLine.textContent = keyStatusLabel(provider.key);
							cardNote.show("Key removed.");
						} catch (err) { cardNote.show(err.message, "danger"); }
					},
				}),
				keyLine,
			),
		);

		/**
		 * @description Shows only the blocks the selected policy uses, so an
		 *   operator is never looking for a field that does not apply.
		 * @returns {void}
		 */
		function syncVisibility() {
			sharedBlock.style.display = policyPicker.value === "shared" ? "" : "none";
			localBlock.style.display = policyPicker.value === "local" ? "" : "none";
			// A key is worth keeping visible for `byok` too: an operator may want one
			// stored ready to switch to sharing later.
			keyBlock.style.display = entry.requiresApiKey ? "" : "none";
		}
		policyPicker.addEventListener("change", syncVisibility);
		syncVisibility();

		return group(
			`${entry.label}`,
			row(
				chip(entry.capability),
				chip(readinessLabel(entry), TONE_BY_POLICY[entry.policy] ?? "info"),
				entry.keyUrl ? h("a.small", { href: entry.keyUrl, target: "_blank", rel: "noopener noreferrer" }, "Get a key") : null,
			),
			field("Who pays", policyPicker),
			sharedBlock,
			localBlock,
			keyBlock,
			row(
				button({
					label: "Save",
					variant: "primary",
					onClick: async () => {
						try {
							await api(`/api/admin/providers/${entry.capability}/${entry.id}/policy`, {
								method: "PUT",
								body: policyPayload({
									policy: policyPicker.value,
									sharedModels: allowlist.value,
									maxCallsPerLobby: cap.value,
									baseUrl: address.value,
								}),
							});
							cardNote.show("Saved.");
							reload();
						} catch (err) { cardNote.show(err.message, "danger"); }
					},
				}),
				button({
					label: "Test connection",
					onClick: async () => {
						cardNote.show("Testing…");
						try {
							const result = await api(`/api/admin/providers/${entry.capability}/${entry.id}/test`, { method: "POST" });
							if (result.ok) {
								cardNote.show("Answered successfully.");
								keyLine.textContent = keyStatusLabel(result.provider.key);
							} else {
								cardNote.show(result.error, "danger");
								keyLine.textContent = keyStatusLabel(result.provider.key);
							}
						} catch (err) { cardNote.show(err.message, "danger"); }
					},
				}),
				cardNote.el,
			),
		);
	}

	/**
	 * @description Redraws every provider card.
	 * @param {Array<object>} rows - Provider rows.
	 * @returns {void}
	 */
	function draw(rows) {
		if (!rows.length) {
			fill(host, empty("No providers are registered."));
			return;
		}
		fill(host, ...rows.map(card));
	}

	fill(host, h("p.muted.small", {}, "Loading…"));
	reload();

	return h("div", panel({
		title: "Providers",
		description: "Which AI, narration and image services this server offers, and whether it pays for them or players bring their own keys. "
			+ "Keys are stored encrypted and are never sent back to this page.",
	}, note.el, host));
}
