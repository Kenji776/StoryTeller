/**
 * Injectable JSON/HTTP layer shared by every provider adapter.
 *
 * Adapters differ in their URLs, headers, and payload shapes but not in how
 * they should behave when a request fails, so failure mapping lives here once
 * rather than five times. `fetch` is a parameter rather than a global reach so
 * adapters stay unit-testable without a network (CQ-5, TDD-8).
 */

import { LLMRequestError } from "./errors.js";

/** Longest provider error text we will carry into a message or a log line. */
const MAX_ERROR_TEXT = 500;

/**
 * @description Pulls the most useful human-readable message out of a provider
 *   error body. Providers disagree on the shape: OpenAI and Anthropic nest it
 *   under `error.message`, Ollama and several gateways use a bare `error`
 *   string, and misconfigured proxies return HTML.
 * @param {string} bodyText - The raw response body.
 * @param {number} status - The HTTP status, used when the body says nothing.
 * @returns {string} A message suitable for an LLMRequestError.
 */
function extractErrorMessage(bodyText, status) {
	const trimmed = (bodyText || "").trim();
	if (!trimmed) return `Request failed with HTTP ${status}.`;

	try {
		const parsed = JSON.parse(trimmed);
		const candidate =
			parsed?.error?.message ??
			(typeof parsed?.error === "string" ? parsed.error : null) ??
			parsed?.message ??
			null;
		if (candidate) return truncate(String(candidate));
	} catch {
		// Not JSON — fall through and use the raw text.
	}
	return truncate(trimmed);
}

/**
 * @description Clamps text to `MAX_ERROR_TEXT`, marking it when shortened.
 * @param {string} text - The text to clamp.
 * @returns {string} Text no longer than the cap.
 */
function truncate(text) {
	return text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT)}…` : text;
}

/**
 * @description Performs an HTTP request and returns the parsed JSON response,
 *   translating every failure mode into an `LLMRequestError` attributed to the
 *   calling provider.
 * @param {string} url - The absolute request URL.
 * @param {object} options - Request options.
 * @param {string} options.provider - Provider id, for error attribution. Required.
 * @param {string} [options.method="GET"] - HTTP method.
 * @param {object} [options.headers={}] - Request headers; merged over the defaults.
 * @param {object|null} [options.body=null] - Value to JSON-serialise as the body.
 * @param {Function} [options.fetchImpl] - Fetch implementation; defaults to the
 *   runtime global. Pass an explicit function in tests.
 * @param {AbortSignal} [options.signal] - Signal used to cancel the request.
 * @returns {Promise<object>} The parsed JSON response body, or `{}` when empty.
 * @throws {Error} When no provider id is given, or no fetch implementation exists.
 * @throws {LLMRequestError} With kind "network" when the transport fails,
 *   a status-derived kind when the provider returns a non-2xx response, or
 *   "bad_response" when a successful response is not JSON.
 */
export async function requestJson(url, { provider, method = "GET", headers = {}, body = null, fetchImpl, signal } = {}) {
	if (!provider) throw new Error("requestJson requires a provider id for error attribution.");
	const doFetch = fetchImpl === undefined ? globalThis.fetch : fetchImpl;
	if (typeof doFetch !== "function") throw new Error("requestJson requires a fetch implementation.");

	const init = { method, headers: { ...headers }, signal };
	if (body !== null && body !== undefined) {
		init.headers["Content-Type"] = "application/json";
		init.body = JSON.stringify(body);
	}

	let response;
	try {
		response = await doFetch(url, init);
	} catch (err) {
		throw new LLMRequestError(`Could not reach ${provider}: ${err.message}`, {
			provider,
			kind: "network",
			cause: err,
		});
	}

	const bodyText = await response.text();

	if (!response.ok) {
		throw new LLMRequestError(extractErrorMessage(bodyText, response.status), {
			provider,
			status: response.status,
		});
	}

	const trimmed = (bodyText || "").trim();
	if (!trimmed) return {};

	try {
		return JSON.parse(trimmed);
	} catch (err) {
		throw new LLMRequestError(`${provider} returned a response that was not valid JSON.`, {
			provider,
			kind: "bad_response",
			cause: err,
		});
	}
}
