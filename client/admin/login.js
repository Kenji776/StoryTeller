// Admin login — challenge-response so the password never travels in plaintext.
// 1. GET  /api/admin/challenge  → { nonce }
// 2. Client computes SHA-256(password + nonce)
// 3. POST /api/admin/login      → { nonce, hash }
// Server sets an HttpOnly cookie on success.

(function () {
	const passwordInput = document.getElementById("passwordInput");
	const loginBtn = document.getElementById("loginBtn");
	const errorMsg = document.getElementById("errorMsg");

	// If already logged in, skip straight to the admin panel
	fetch("/api/admin/session")
		.then(r => r.json())
		.then(d => { if (d.authenticated) window.location.href = "/admin/admin.html"; })
		.catch(() => {});

	async function sha256(message) {
		const msgBuffer = new TextEncoder().encode(message);
		const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
		return Array.from(new Uint8Array(hashBuffer))
			.map(b => b.toString(16).padStart(2, "0"))
			.join("");
	}

	async function doLogin() {
		errorMsg.textContent = "";
		const password = passwordInput.value;
		if (!password) { errorMsg.textContent = "Please enter a password."; return; }

		loginBtn.disabled = true;
		loginBtn.textContent = "Authenticating...";

		try {
			// Step 1 — get a one-time nonce from the server
			const challengeRes = await fetch("/api/admin/challenge");
			if (!challengeRes.ok) {
				const err = await challengeRes.json().catch(() => ({}));
				throw new Error(err.error || "Could not reach server");
			}
			const { nonce } = await challengeRes.json();

			// Step 2 — hash the password with the nonce (never send plaintext)
			const hash = await sha256(password + nonce);

			// Step 3 — send the hash for verification
			const loginRes = await fetch("/api/admin/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ nonce, hash }),
			});

			if (!loginRes.ok) {
				const err = await loginRes.json().catch(() => ({}));
				throw new Error(err.error || "Login failed");
			}

			// Success — redirect to admin panel
			window.location.href = "/admin/admin.html";
		} catch (err) {
			errorMsg.textContent = err.message || "Login failed";
		} finally {
			loginBtn.disabled = false;
			loginBtn.textContent = "Login";
		}
	}

	loginBtn.addEventListener("click", doLogin);
	passwordInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter") doLogin();
	});
})();
