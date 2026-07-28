/**
 * audio — the music mood, and the sound-effect pipeline.
 *
 * Both are here because both are "what the lobby is hearing", and both are things
 * an admin reaches for mid-scene rather than while configuring a game.
 *
 * The sound-effect control is a genuine test of the resolution path: it reports
 * whether the clip came from the library or had to be generated, which is the only
 * place that distinction is visible.
 */

import { h, fill } from "../ui/dom.js";
import { panel, button, select, textInput, chip, flash } from "../ui/components.js";
import { selectVitals } from "../core/selectors.js";

/**
 * @description Renders the audio section.
 * @param {object} ctx - The section context.
 * @returns {HTMLElement} The section.
 */
export function audio(ctx) {
	const { store, bridge } = ctx;

	const moodHost = h("div");
	const nowPlaying = h("span.muted.small");
	const sfxHost = h("div.sfx-result");
	const note = flash();

	/**
	 * @description Reports what is playing now.
	 * @returns {void}
	 */
	function drawNowPlaying() {
		nowPlaying.textContent = `Now: ${selectVitals(store.getState().lobbyState).music}`;
	}

	ctx.onCleanup(store.watch((s) => s.lobbyState?.currentMusic ?? null, drawNowPlaying));
	drawNowPlaying();

	// The mood list is a config file the server already serves to the game client;
	// fetching it keeps the console's options and the game's in step without a
	// second copy of the list living here.
	fetch("/config/music_moods.json")
		.then((res) => res.json())
		.then(({ moods = [] }) => {
			const picker = select({ options: moods.map((m) => ({ value: m.id, label: m.label })) });
			fill(moodHost, h("div.control-row",
				picker,
				button({ label: "Play", variant: "primary", onClick: () => {
					if (bridge.setMusic(picker.value)) note.show(`Playing ${picker.value.replace(/_/g, " ")}`);
				} }),
				button({ label: "Stop", onClick: () => {
					if (bridge.setMusic(null)) note.show("Music stopped");
				} }),
				nowPlaying,
			));
		})
		.catch(() => fill(moodHost, h("p.muted.small", "Could not load the mood list from /config/music_moods.json.")));

	// ── sound effects ─────────────────────────────────────────────────────────

	const description = textInput({ placeholder: 'e.g. "sword clash", "dragon roar"' });
	const testButton = button({
		label: "Test",
		variant: "primary",
		onClick: () => {
			const wanted = description.value.trim();
			if (!wanted) return note.show("Describe a sound first.", "warn");
			if (!bridge.testSfx(wanted)) return note.show("Not connected to a lobby.", "danger");
			testButton.disabled = true;
			testButton.textContent = "Resolving…";
			fill(sfxHost);
		},
	});

	/**
	 * @description Shows the outcome of a sound-effect test.
	 * @param {object|null} result - The server's reply.
	 * @returns {void}
	 */
	function drawSfxResult(result) {
		testButton.disabled = false;
		testButton.textContent = "Test";
		if (!result) return fill(sfxHost);

		if (!result.ok) {
			fill(sfxHost, chip("failed", "danger"), h("span.muted.small", result.error ?? "No reason given."));
			return;
		}

		const generated = result.source === "generated";
		const player = h("audio", { controls: true, src: `/sfx/game/${result.effect.file}` });
		fill(sfxHost,
			chip(generated ? "generated" : "library match", generated ? "warn" : "ok"),
			h("strong", result.effect.name),
			h("span.muted.small.mono", result.effect.file),
			player,
		);
		player.play().catch(() => {
			// Browsers block autoplay until the page has been interacted with. The
			// controls are right there, so this is not worth reporting.
		});
	}

	ctx.onCleanup(store.watch((s) => s.sfxResult, drawSfxResult));

	return h("div",
		panel({ title: "Music", description: "Changes the mood for everyone in the lobby." }, moodHost),
		panel({
			title: "Sound effects",
			description: "Resolves a description against the library, generating a clip if nothing matches, and plays it to the lobby.",
		},
			h("div.control-row", description, testButton, note.el),
			sfxHost,
		),
	);
}
