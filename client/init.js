// Warn the player before leaving if they're mid-game (so they remember to export)
window.addEventListener("beforeunload", (e) => {
	if (lobbyId) {
		socket.disconnect();
	}

	// Only prompt when actively playing — not on the landing page or during lobby setup
	const inActiveGame = lobbyId && me?.name && currentState?.phase === "running";
	if (inActiveGame) {
		// Modern browsers ignore custom messages and show their own generic text,
		// but setting returnValue is required to trigger the dialog at all.
		e.preventDefault();
		e.returnValue = ""; // triggers "Leave site? Changes you made may not be saved."
	}
});

function init() {
	registerSocketEvents();
	rigUI();
	loadVoices();
	fetchActiveLobbies();

	// Apply saved story font preference
	const savedFont = localStorage.getItem("storyFont") || "Lora";
	if (typeof applyStoryFont === "function") applyStoryFont(savedFont);

	const refreshBtn = document.getElementById("refreshLobbies");
	if (refreshBtn) refreshBtn.addEventListener("click", fetchActiveLobbies);

	// Show appropriate Quick Start button based on devMode
	fetch("/api/features").then(r => r.json()).then(f => {
		if (f.devMode) {
			const btn = document.getElementById("quickStartBtn");
			if (btn) {
				btn.style.display = "";
				btn.addEventListener("click", handleQuickStart);
			}
		} else {
			const btn = document.getElementById("quickStartPublicBtn");
			if (btn) btn.style.display = "";
		}
	}).catch(() => {});
}


init();
