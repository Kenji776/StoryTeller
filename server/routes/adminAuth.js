import { randomBytes, createHash, createVerify } from "crypto";

/**
 * Registers all admin authentication routes and middleware onto the Express app.
 * Sets up challenge/response login, session management, host-as-admin verification,
 * and protection middleware for the /admin/ route prefix.
 *
 * @param {import('express').Application} app - The Express application instance.
 * @param {{ store: object, charPublicKey: string, log: Function }} options - Configuration dependencies.
 * @param {object} options.store - The lobby/game state store.
 * @param {string} options.charPublicKey - PEM-encoded RSA public key used to verify character file signatures.
 * @param {Function} options.log - Logging function.
 * @returns {{ adminSessions: Map, hostAdminTokens: Map, hostAdminSockets: Map, isAdminAuthenticated: Function, isHostToken: Function, parseCookie: Function, cleanExpired: Function }}
 *   Exported helpers and session maps for use by other modules (e.g. socket handlers).
 */
export function registerAdminAuth(app, { store, charPublicKey, log }) {
	// === ADMIN AUTH STATE ===
	const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
	if (!ADMIN_PASSWORD) console.warn("⚠️  ADMIN_PASSWORD not set in .env — admin panel will be inaccessible.");

	// Pending nonces (challenge-response): Map<nonce, expiresAt>
	const adminNonces = new Map();
	// Active sessions: Map<token, expiresAt>
	const adminSessions = new Map();
	const SESSION_TTL = 8 * 60 * 60 * 1000; // 8 hours
	const NONCE_TTL = 60 * 1000;             // 60 seconds

	// Host-as-admin tokens: Map<token, { lobbyCode, expiresAt }>
	const hostAdminTokens = new Map();
	const HOST_TOKEN_TTL = 8 * 60 * 60 * 1000; // 8 hours
	// Track which sockets are authorized as host-admin: Map<socketId, lobbyCode>
	const hostAdminSockets = new Map();

	// === HELPER FUNCTIONS ===

	/**
	 * Removes all expired entries from a TTL map.
	 * Supports maps whose values are either a raw timestamp (number) or an object with an `expiresAt` property.
	 *
	 * @param {Map<string, number|{ expiresAt: number }>} map - The map to purge expired entries from.
	 * @returns {void}
	 */
	function cleanExpired(map) {
		const now = Date.now();
		for (const [k, v] of map) {
			const exp = typeof v === "number" ? v : v?.expiresAt;
			if (exp < now) map.delete(k);
		}
	}

	/**
	 * Parses a raw HTTP `Cookie` header string into a key/value object.
	 *
	 * @param {string} cookieStr - The raw cookie header string (e.g. `"a=1; b=2"`).
	 * @returns {Record<string, string>} A plain object mapping cookie names to their decoded values.
	 */
	function parseCookie(cookieStr) {
		const obj = {};
		cookieStr.split(";").forEach(pair => {
			const [k, ...v] = pair.trim().split("=");
			if (k) obj[k.trim()] = decodeURIComponent(v.join("="));
		});
		return obj;
	}

	/**
	 * Checks whether the incoming request carries a valid full-admin session token.
	 * Accepts the token from either the `admin_token` cookie or the `Authorization: Bearer` header.
	 *
	 * @param {import('express').Request} req - The incoming Express request.
	 * @returns {boolean} `true` if the request has a valid, non-expired admin session token.
	 */
	function isAdminAuthenticated(req) {
		// Check cookie first, then Authorization header
		const token =
			parseCookie(req.headers.cookie || "").admin_token ||
			(req.headers.authorization || "").replace("Bearer ", "");
		if (!token) return false;
		cleanExpired(adminSessions);
		return adminSessions.has(token);
	}

	/**
	 * Checks whether the incoming request carries a valid host-admin token.
	 * Returns the lobby code the token is scoped to, or `null` if the token is absent or expired.
	 *
	 * @param {import('express').Request} req - The incoming Express request.
	 * @returns {string|null} The lobby code associated with the host token, or `null` if not authenticated as host.
	 */
	function isHostToken(req) {
		const token =
			parseCookie(req.headers.cookie || "").admin_token ||
			(req.headers.authorization || "").replace("Bearer ", "");
		if (!token) return null;
		cleanExpired(hostAdminTokens);
		const entry = hostAdminTokens.get(token);
		return entry ? entry.lobbyCode : null;
	}

	// === ADMIN AUTH ENDPOINTS (before static middleware) ===

	/**
	 * GET /api/admin/challenge
	 * Issues a one-time cryptographic nonce for the challenge-response login flow.
	 * The nonce expires after NONCE_TTL (60 seconds).
	 */
	app.get("/api/admin/challenge", (req, res) => {
		if (!ADMIN_PASSWORD) return res.status(503).json({ error: "Admin login not configured" });
		cleanExpired(adminNonces);
		const nonce = randomBytes(32).toString("hex");
		adminNonces.set(nonce, Date.now() + NONCE_TTL);
		res.json({ nonce });
	});

	/**
	 * POST /api/admin/login
	 * Validates a challenge-response login attempt using SHA-256(password + nonce).
	 * On success, sets an `admin_token` cookie and issues a session valid for SESSION_TTL (8 hours).
	 */
	app.post("/api/admin/login", (req, res) => {
		if (!ADMIN_PASSWORD) return res.status(503).json({ error: "Admin login not configured" });
		const { nonce, hash } = req.body;
		if (!nonce || !hash) return res.status(400).json({ error: "Missing nonce or hash" });

		cleanExpired(adminNonces);
		if (!adminNonces.has(nonce)) return res.status(401).json({ error: "Invalid or expired challenge" });
		adminNonces.delete(nonce);

		// Server computes expected hash the same way the client does
		const expected = createHash("sha256").update(ADMIN_PASSWORD + nonce).digest("hex");
		if (hash !== expected) return res.status(401).json({ error: "Incorrect password" });

		// Issue session token
		const token = randomBytes(32).toString("hex");
		adminSessions.set(token, Date.now() + SESSION_TTL);
		res.setHeader("Set-Cookie", `admin_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}`);
		res.json({ ok: true });
	});

	/**
	 * GET /api/admin/session
	 * Returns the authentication state and auth type for the current request.
	 * `authType` is `"admin"` for password sessions and `"host"` for host-verified tokens.
	 */
	// Check if current session is valid — also return authType so the client
	// can gate features (e.g. char-file tool is admin-only, not host).
	app.get("/api/admin/session", (req, res) => {
		if (isAdminAuthenticated(req)) return res.json({ authenticated: true, authType: "admin" });
		if (isHostToken(req))          return res.json({ authenticated: true, authType: "host" });
		res.json({ authenticated: false });
	});

	/**
	 * POST /api/admin/logout
	 * Invalidates the current admin session token and clears the `admin_token` cookie.
	 */
	// Logout
	app.post("/api/admin/logout", (req, res) => {
		const token = parseCookie(req.headers.cookie || "").admin_token;
		if (token) adminSessions.delete(token);
		res.setHeader("Set-Cookie", "admin_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
		res.json({ ok: true });
	});

	/**
	 * POST /api/admin/host-verify
	 * Verifies a base64-encoded, RSA-signed character file against the server's public key,
	 * then confirms the character is the registered host of the given lobby.
	 * On success, issues a scoped host-admin token valid for HOST_TOKEN_TTL (8 hours).
	 */
	// === HOST-AS-ADMIN: verify character file and issue token ===
	app.post("/api/admin/host-verify", (req, res) => {
		const { lobbyCode, data, sig } = req.body;
		if (!lobbyCode || !data || !sig) return res.status(400).json({ error: "Missing fields" });

		// Verify the character file signature
		const verifier = createVerify("SHA256");
		verifier.update(data);
		verifier.end();
		if (!verifier.verify(charPublicKey, sig, "base64")) {
			return res.status(401).json({ error: "Invalid character file signature" });
		}

		// Parse character data and extract characterId
		let parsed;
		try {
			parsed = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
		} catch { return res.status(400).json({ error: "Malformed character data" }); }

		const charId = parsed.sheet?.characterId;
		if (!charId) return res.status(400).json({ error: "Character file has no characterId" });

		// Find the lobby and check hostCharacterId
		const lobbyId = store.findLobbyByCode(lobbyCode);
		if (!lobbyId) return res.status(404).json({ error: "Lobby not found" });

		const lobby = store.index[lobbyId];
		if (!lobby.hostCharacterId) return res.status(403).json({ error: "Lobby has no host character on record" });
		if (lobby.hostCharacterId !== charId) return res.status(403).json({ error: "Character file does not match the game host" });

		// Issue a host admin token scoped to this lobby
		cleanExpired(hostAdminTokens);
		const token = randomBytes(32).toString("hex");
		hostAdminTokens.set(token, { lobbyCode, expiresAt: Date.now() + HOST_TOKEN_TTL });
		res.setHeader("Set-Cookie", `admin_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${HOST_TOKEN_TTL / 1000}`);
		res.json({ ok: true, lobbyCode });
	});

	// Redirect old /admin.html to new location
	app.get("/admin.html", (req, res) => res.redirect("/admin/login.html"));

	/**
	 * Middleware: GET /admin/*
	 * Guards all files under the /admin/ prefix. The login page and its JS bundle are
	 * publicly accessible; everything else requires either a valid admin session or a
	 * valid host token. HTML requests are redirected to the login page; API/asset
	 * requests receive a 401 JSON response.
	 */
	// === PROTECT /admin/ — gate all files except login.html and login.js ===
	app.use("/admin", (req, res, next) => {
		// Root → login page
		if (req.path === "/") return res.redirect("/admin/login.html");
		// Allow the login page and its JS without auth
		const allowed = ["/login.html", "/login.js"];
		if (allowed.includes(req.path)) return next();
		// Everything else requires admin password auth OR a valid host token
		if (!isAdminAuthenticated(req) && !isHostToken(req)) {
			// If requesting HTML, redirect to login
			if (req.headers.accept?.includes("text/html")) {
				return res.redirect("/admin/login.html");
			}
			return res.status(401).json({ error: "Unauthorized" });
		}
		next();
	});

	return {
		adminSessions,
		hostAdminTokens,
		hostAdminSockets,
		isAdminAuthenticated,
		isHostToken,
		parseCookie,
		cleanExpired,
	};
}
