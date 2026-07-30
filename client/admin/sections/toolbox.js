/**
 * toolbox — inspecting, editing and re-signing an exported character file.
 *
 * A `.stchar` is a base64 payload with an RSA signature over it. This decodes one,
 * shows whether the signature still verifies, lets the JSON be edited, and asks
 * the server to sign the result — the only route to a valid file, since the
 * private key never leaves the server.
 *
 * Admin-only, and it needs no lobby: it operates on a file, not on a game.
 */

import { h, fill } from "../ui/dom.js";
import { panel, button, textArea, chip, flash } from "../ui/components.js";

/**
 * @description Renders the character-file toolbox.
 * @param {object} ctx - The section context.
 * @returns {HTMLElement} The section.
 */
export function toolbox(ctx) {
	const note = flash();
	const signature = h("span");
	const heading = h("strong.toolbox-name");
	const editor = textArea({
		rows: 22,
		"aria-label": "Character JSON",
		props: { spellcheck: false },
	});
	editor.classList.add("mono");

	const editorPane = h("div.toolbox-editor");
	editorPane.hidden = true;

	const fileInput = h("input", { type: "file", accept: ".stchar", style: { display: "none" } });
	const dropZone = h("div.dropzone", { tabindex: "0", role: "button" },
		h("strong", "Drop a .stchar file here"),
		h("p.muted.small", "or click to browse"),
		fileInput,
	);

	/** The loaded file's name, used when naming the re-signed download. */
	let loadedName = "character";

	/**
	 * @description Loads a file, verifying its signature through the server.
	 * @param {File} file - The chosen file.
	 * @returns {Promise<void>} Resolves once the editor is populated.
	 */
	async function load(file) {
		loadedName = file.name.replace(/\.stchar$/i, "");
		note.show(`Reading ${file.name}…`);

		let parsed;
		try {
			parsed = JSON.parse(await file.text());
		} catch {
			return note.show("That file is not valid JSON.", "danger");
		}

		try {
			const res = await fetch("/api/character/import", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ data: parsed.data, sig: parsed.sig }),
			});
			const body = await res.json();

			if (res.ok) {
				fill(signature, chip("signature valid", "ok"));
				heading.textContent = body.character.name ?? "Unknown";
				editor.value = JSON.stringify({ name: body.character.name, sheet: body.character.sheet }, null, 2);
			} else {
				// A file that fails verification is still worth showing — a tampered or
				// stale export is exactly what someone opens this to look at.
				fill(signature, chip("signature invalid", "danger"));
				try {
					const decoded = JSON.parse(atob(parsed.data));
					heading.textContent = decoded.name ?? "Unknown";
					editor.value = JSON.stringify(decoded, null, 2);
				} catch {
					editor.value = "";
					return note.show("The signature failed and the payload could not be decoded.", "danger");
				}
			}

			editorPane.hidden = false;
			note.show(`Loaded ${file.name}`);
		} catch (err) {
			note.show(`Could not reach the server: ${err.message}`, "danger");
		}
	}

	dropZone.addEventListener("click", () => fileInput.click());
	dropZone.addEventListener("keydown", (event) => {
		if (event.key === "Enter" || event.key === " ") fileInput.click();
	});
	dropZone.addEventListener("dragover", (event) => {
		event.preventDefault();
		dropZone.classList.add("is-over");
	});
	dropZone.addEventListener("dragleave", () => dropZone.classList.remove("is-over"));
	dropZone.addEventListener("drop", (event) => {
		event.preventDefault();
		dropZone.classList.remove("is-over");
		const [file] = event.dataTransfer.files;
		if (file) load(file);
	});
	fileInput.addEventListener("change", (event) => {
		const [file] = event.target.files;
		if (file) load(file);
		event.target.value = "";
	});

	/**
	 * @description Sends the edited sheet back for signing and downloads the result.
	 * @returns {Promise<void>} Resolves once the download is triggered.
	 */
	async function resign() {
		let payload;
		try {
			payload = JSON.parse(editor.value);
		} catch (err) {
			return note.show(`Fix the JSON first: ${err.message}`, "danger");
		}

		const { name, sheet } = payload;
		if (!name || !sheet) return note.show('The JSON needs a "name" and a "sheet".', "warn");

		try {
			const res = await fetch("/api/character/export", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name, sheet }),
			});
			if (!res.ok) throw new Error((await res.json()).error ?? `export failed (${res.status})`);

			const blob = new Blob([JSON.stringify(await res.json(), null, 2)], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const link = h("a", { href: url, download: `${String(name).replace(/\s+/g, "_")}.stchar` });
			link.click();
			URL.revokeObjectURL(url);

			fill(signature, chip("re-signed", "ok"));
			note.show("Re-signed and downloaded");
		} catch (err) {
			note.show(`Re-sign failed: ${err.message}`, "danger");
		}
	}

	fill(editorPane,
		h("div.toolbox-head", heading, signature),
		h("p.muted.small", "Edit any field. The JSON must stay valid; the server signs whatever you send."),
		editor,
		h("div.control-row", { style: { marginTop: "0.6rem" } },
			button({ label: "Re-sign and download", variant: "primary", small: true, onClick: resign }),
			button({
				label: "Format",
				small: true,
				onClick: () => {
					try {
						editor.value = JSON.stringify(JSON.parse(editor.value), null, 2);
						note.clear();
					} catch (err) {
						note.show(`Invalid JSON: ${err.message}`, "danger");
					}
				},
			}),
			note.el,
		),
	);

	return h("div",
		panel({
			title: "Character files",
			description: "Decode an exported .stchar, check its signature, edit it, and have the server sign the result.",
		}, dropZone, editorPane),
		signingKeyPanel(),
	);
}

/**
 * The signing key, and the button that replaces it.
 *
 * @description Sits beside the character-file tools because it is the key those files are signed
 *   with — a reader wondering why a signature stopped verifying is already looking at this screen.
 *
 *   The key is identified by fingerprint only. The server never sends key material and this could not
 *   display it if it did.
 *
 *   Rotation exists because a leaked key cannot be un-leaked, and this one is a plaintext private key
 *   on disk. The confirmation states what it costs in the terms a person will actually experience —
 *   old exports stop importing, a host has to export again — rather than "this is irreversible".
 * @returns {HTMLElement} The panel.
 */
function signingKeyPanel() {
	const note = flash();
	const fingerprint = h("code.mono", "checking…");

	/**
	 * @description Reads the current fingerprint and shows it.
	 * @returns {Promise<void>} Resolves once displayed.
	 */
	async function refresh() {
		try {
			const res = await fetch("/api/admin/character-key");
			const body = await res.json();
			fingerprint.textContent = res.ok ? body.fingerprint : (body.error ?? "unavailable");
		} catch {
			fingerprint.textContent = "unavailable";
		}
	}

	/**
	 * @description Rotates the key and reports both fingerprints, so the change is visible rather
	 *   than merely claimed.
	 * @returns {Promise<void>} Resolves once done.
	 */
	async function rotate() {
		note.show("Generating a new key…");
		try {
			const res = await fetch("/api/admin/character-key/rotate", { method: "POST" });
			const body = await res.json();
			if (!res.ok) return note.show(body.error ?? "Could not rotate the key.", "danger");
			fingerprint.textContent = body.current;
			note.show(`Replaced ${body.previous} with ${body.current}. Existing exports no longer import.`, "ok");
		} catch (err) {
			note.show(`Could not rotate the key: ${err.message}`, "danger");
		}
	}

	refresh();

	return panel({
		title: "Character signing key",
		description: "The RSA key this server signs exported characters with. Replace it if it has leaked.",
	},
	h("div.control-row", h("span.muted.small", "In use:"), fingerprint),
	h("p.muted.small",
		"Replacing it means every .stchar exported before now stops importing, and any host holding "
		+ "one cannot open the DM tools until they export their character again. "),
	h("p.muted.small",
		"Games in progress are not affected at all — characters in a lobby carry no signature, so no "
		+ "campaign, sheet, inventory or progress is touched."),
	h("div.control-row", { style: { marginTop: "0.6rem" } },
		button({
			label: "Replace signing key",
			variant: "danger",
			small: true,
			confirm: "Replace the character signing key?\n\n"
				+ "• Every character file exported before now will stop importing.\n"
				+ "• A host holding an old file cannot reach the DM tools until they export again.\n"
				+ "• Games in progress are unaffected.\n\n"
				+ "Re-exporting affected characters fixes them. This cannot be undone.",
			onClick: rotate,
		}),
		note.el,
	));
}
