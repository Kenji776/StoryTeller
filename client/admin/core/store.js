/**
 * store — the panel's client-side state, and the way sections hear about changes.
 *
 * Sections must not read from each other or from the socket directly. Everything
 * the socket learns lands here; sections subscribe to the slice they render. That
 * is what lets a nav badge track unresolved incidents without the nav knowing
 * anything about incidents beyond how to count them.
 */

/**
 * @description Creates a state container.
 * @param {object} [initial] - The starting state.
 * @returns {{getState: Function, patch: Function, subscribe: Function, watch: Function}}
 *   The container.
 */
export function createStore(initial = {}) {
	let state = { ...initial };

	/** @type {Set<function(object): void>} Called on every change. */
	const listeners = new Set();

	/** @type {Set<{selector: Function, listener: Function, last: *}>} Slice watchers. */
	const watchers = new Set();

	/**
	 * @description Runs a callback, swallowing anything it throws.
	 *
	 *   One section failing to render must not stop the others from being told about
	 *   the update — a panel that goes half-blind because of a bad row is harder to
	 *   diagnose than one that reports the error and carries on.
	 * @param {function(): void} run - The callback.
	 * @param {string} label - What was being attempted, for the console.
	 * @returns {void}
	 */
	function guard(run, label) {
		try {
			run();
		} catch (err) {
			console.error(`[admin/store] ${label} failed:`, err);
		}
	}

	/**
	 * @description Tells every subscriber and every affected watcher about a change.
	 *
	 *   Both sets are copied before iteration so a listener that unsubscribes — or
	 *   subscribes — while being called does not disturb the round in progress.
	 * @returns {void}
	 */
	function notify() {
		for (const listener of [...listeners]) {
			guard(() => listener(state), "subscriber");
		}
		for (const watcher of [...watchers]) {
			guard(() => {
				const next = watcher.selector(state);
				if (Object.is(next, watcher.last)) return;
				const previous = watcher.last;
				watcher.last = next;
				watcher.listener(next, previous);
			}, "watcher");
		}
	}

	return {
		/**
		 * @description Returns the current state.
		 * @returns {object} A shallow copy, so a section cannot mutate shared state
		 *   in place and leave the store unable to notice.
		 */
		getState() {
			return { ...state };
		},

		/**
		 * @description Merges a partial update and notifies subscribers.
		 *
		 *   Notification is suppressed when every key in the patch already holds
		 *   that value, so a socket re-emitting identical state does not re-render
		 *   the interface underneath someone's cursor.
		 * @param {object} partial - Keys to overwrite.
		 * @returns {boolean} Whether anything actually changed.
		 * @throws {TypeError} When `partial` is not a plain object.
		 */
		patch(partial) {
			if (typeof partial !== "object" || partial === null || Array.isArray(partial)) {
				throw new TypeError(`patch needs an object, received ${JSON.stringify(partial) ?? typeof partial}`);
			}

			const keys = Reflect.ownKeys(partial);
			const changed = keys.some((key) => !Object.is(state[key], partial[key]));
			if (!changed) return false;

			state = { ...state, ...partial };
			notify();
			return true;
		},

		/**
		 * @description Subscribes to every change.
		 * @param {function(object): void} listener - Called with the new state.
		 * @returns {function(): void} Unsubscribes when called; safe to call twice.
		 * @throws {TypeError} When `listener` is not a function.
		 */
		subscribe(listener) {
			if (typeof listener !== "function") {
				throw new TypeError(`subscribe needs a listener function, received ${typeof listener}`);
			}
			listeners.add(listener);
			return () => listeners.delete(listener);
		},

		/**
		 * @description Subscribes to one derived value, firing only when it changes.
		 *
		 *   Comparison is `Object.is`, so a selector must reduce to something
		 *   comparable — a count, an id, a flag — rather than returning an object or
		 *   array that is rebuilt on every patch.
		 * @param {function(object): *} selector - Derives the watched value.
		 * @param {function(*, *): void} listener - Called with the new and previous value.
		 * @returns {function(): void} Unsubscribes when called; safe to call twice.
		 * @throws {TypeError} When `selector` or `listener` is not a function.
		 */
		watch(selector, listener) {
			if (typeof selector !== "function") {
				throw new TypeError(`watch needs a selector function, received ${typeof selector}`);
			}
			if (typeof listener !== "function") {
				throw new TypeError(`watch needs a listener function, received ${typeof listener}`);
			}
			let last;
			try {
				last = selector(state);
			} catch {
				last = undefined;
			}
			const watcher = { selector, listener, last };
			watchers.add(watcher);
			return () => watchers.delete(watcher);
		},
	};
}
