/**
 * health — what is broken, and everything that can fix it.
 *
 * In the old panel this lived inside a tab called "Event Feed", two levels down
 * from anything: the place you go when the game is broken was the hardest place
 * to find. It is now top-level with a live badge in the sidebar.
 *
 * The full repair catalogue is here, including the player-scoped repairs the Party
 * inspector also offers. That is deliberate rather than duplication — the
 * inspector is the in-context route ("this character is wrong"), this is the
 * out-of-context one ("something is wrong, show me every tool"). Both build from
 * the same catalogue and coerce through the same function, so they cannot disagree.
 */

import { h, fill } from "../ui/dom.js";
import { panel, group, button, select, multiSelect, selectedValues, numberInput, chip, empty, flash } from "../ui/components.js";
import { sortIncidents, unresolvedCount, severityTone } from "../core/incidents.js";
import { playerRepairs, lobbyRepairs, fieldsExcludingPlayer } from "../core/repairs.js";
import { buildRepairPayload, coerceField } from "../core/coerce.js";
import { selectPlayers } from "../core/selectors.js";
import { CONDITIONS } from "../core/vocab.js";

/**
 * @description Renders the health section.
 * @param {object} ctx - The section context.
 * @returns {HTMLElement} The section.
 */
export function health(ctx) {
	const { store, bridge } = ctx;

	const incidentHost = h("div");
	const repairHost = h("div");
	const note = flash();

	// ── incidents ─────────────────────────────────────────────────────────────

	/**
	 * @description Draws the incident list, unresolved first.
	 * @returns {void}
	 */
	function drawIncidents() {
		const incidents = sortIncidents(store.getState().incidents);
		if (!incidents.length) {
			fill(incidentHost, empty("Nothing has gone wrong that the server could not fix itself."));
			return;
		}

		fill(incidentHost, h("ul.plain-list.incident-list", incidents.map((incident) => h("li.incident", {
			class: incident.resolved ? "is-resolved" : "",
		},
			h("div.incident-head",
				chip(incident.severity ?? "warning", severityTone(incident.severity)),
				h("strong", incident.kind ?? "problem"),
				// A repeat is one ongoing fault, not many; the server collapses them
				// and the count is how often it has recurred.
				incident.count > 1 && h("span.muted.small", `seen ${incident.count}×`),
				h("span.muted.small.incident-when", incident.lastAt ? new Date(incident.lastAt).toLocaleTimeString() : ""),
			),
			h("div.incident-message", incident.message ?? ""),
			incident.suggestedFix && h("div.muted.small.incident-fix", `→ ${incident.suggestedFix}`),
			incident.resolved
				? h("div.muted.small", `handled: ${incident.resolution ?? ""}`)
				: h("div", button({
					label: "Mark handled",
					small: true,
					onClick: () => bridge.resolveIncident(incident.id),
				})),
		))));
	}

	// ── repairs ───────────────────────────────────────────────────────────────

	/**
	 * @description Builds a form for one repair.
	 * @param {object} repair - A catalogue entry.
	 * @param {function(): string|null} [whoever] - Supplies the chosen character for
	 *   a player-scoped repair.
	 * @returns {HTMLElement} The form.
	 */
	function repairForm(repair, whoever) {
		const fields = whoever ? fieldsExcludingPlayer(repair) : (repair.fields ?? []);
		const inputs = new Map();

		for (const name of fields) {
			inputs.set(name, name === "conditions"
				? multiSelect({ options: CONDITIONS, size: 4, props: { "aria-label": "Conditions to set" } })
				: numberInput({ placeholder: name, "aria-label": `${repair.label}: ${name}` }));
		}

		return h("div.repair-form",
			h("div.repair-label", repair.label),
			repair.note && h("div.muted.small", repair.note),
			h("div.control-row",
				...fields.map((name) => inputs.get(name)),
				button({
					label: "Apply",
					small: true,
					onClick: () => {
						const payload = buildRepairPayload(fields, (name) => {
							const el = inputs.get(name);
							return name === "conditions" ? selectedValues(el).join(",") : el.value;
						});

						if (whoever) {
							const player = whoever();
							if (!player) return note.show("Choose a character first.", "warn");
							payload.player = player;
						}

						// A conditions field with nothing selected must still be sent, as
						// an empty list is how conditions are cleared.
						for (const name of fields) {
							if (name !== "conditions" || name in payload) continue;
							payload.conditions = coerceField("conditions", "").value;
						}

						if (bridge.sendRepair(repair.type, payload)) note.show(`${repair.label} sent`);
						else note.show("Not connected to a lobby.", "danger");
					},
				}),
			),
		);
	}

	/**
	 * @description Draws the repair catalogue, split by what each one acts on.
	 * @returns {void}
	 */
	function drawRepairs() {
		const catalogue = store.getState().repairs;
		if (!catalogue?.length) {
			fill(repairHost, empty("The server has not sent its repair catalogue."));
			return;
		}

		const names = selectPlayers(store.getState().lobbyState).map((p) => p.name);
		// A dropdown of who is actually in the lobby, rather than the free-text box
		// the old panel had: mistyping the name was the likeliest way to use it.
		const who = select({
			options: [{ value: "", label: "— choose a character —" }, ...names.map((n) => ({ value: n, label: n }))],
			props: { "aria-label": "Character to repair" },
		});

		fill(repairHost,
			group("The whole lobby", lobbyRepairs(catalogue).map((repair) => repairForm(repair))),
			group("One character",
				h("p.muted.small", "The Party inspector offers these with the character already chosen."),
				h("div.control-row", { style: { marginBottom: "0.7rem" } }, who),
				playerRepairs(catalogue).map((repair) => repairForm(repair, () => who.value || null)),
			),
		);
	}

	ctx.onCleanup(store.watch((s) => (s.incidents ?? []).map((i) => `${i.id}:${i.resolved}:${i.count}`).join(","), drawIncidents));
	ctx.onCleanup(store.watch((s) => (s.repairs ?? []).length, drawRepairs));
	ctx.onCleanup(store.watch((s) => selectPlayers(s.lobbyState).map((p) => p.name).join(","), drawRepairs));

	drawIncidents();
	drawRepairs();

	const open = unresolvedCount(store.getState().incidents);

	return h("div",
		panel({
			title: "Incidents",
			description: open
				? `${open} still need attention. These are problems the server detected and could not put right on its own.`
				: "Problems the server detected and could not put right on its own.",
		}, incidentHost),
		panel({
			title: "Manual repairs",
			description: "Values are absolute, not adjustments. Every repair ends with fresh state pushed to the lobby.",
		}, repairHost, h("div.control-row", note.el)),
	);
}
