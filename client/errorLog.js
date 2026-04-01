// === Client-side Error Log ===
// Captures console.error, unhandled exceptions, and unhandled promise rejections.
// Call downloadErrorLog() to save the accumulated log as a .txt file.

const _errorLog = [];
const MAX_LOG_ENTRIES = 2000;

function _pushEntry(type, args) {
	const ts = new Date().toISOString();
	const message = args
		.map((a) => {
			if (a instanceof Error) return `${a.message}\n${a.stack || ""}`;
			if (typeof a === "object") {
				try { return JSON.stringify(a); } catch { return String(a); }
			}
			return String(a);
		})
		.join(" ");
	_errorLog.push({ ts, type, message });
	if (_errorLog.length > MAX_LOG_ENTRIES) _errorLog.shift();
}

// Intercept console.error
const _origConsoleError = console.error.bind(console);
console.error = function (...args) {
	_pushEntry("console.error", args);
	_origConsoleError(...args);
};

// Intercept console.warn
const _origConsoleWarn = console.warn.bind(console);
console.warn = function (...args) {
	_pushEntry("console.warn", args);
	_origConsoleWarn(...args);
};

// Global unhandled errors
window.addEventListener("error", (event) => {
	_pushEntry("window.error", [
		`${event.message} at ${event.filename}:${event.lineno}:${event.colno}`,
	]);
});

// Unhandled promise rejections
window.addEventListener("unhandledrejection", (event) => {
	_pushEntry("unhandledrejection", [event.reason]);
});

/** Return a copy of the collected error log entries. */
function getErrorLog() {
	return _errorLog.slice();
}

/** Download the error log as a timestamped .txt file. */
function downloadErrorLog() {
	if (_errorLog.length === 0) {
		alert("Error log is empty.");
		return;
	}
	const lines = _errorLog.map(
		(e) => `[${e.ts}] [${e.type}] ${e.message}`
	);
	const blob = new Blob([lines.join("\n")], { type: "text/plain" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = `error-log-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}
