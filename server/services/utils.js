export function normalizeName(name = "") {
	return String(name || "")
		.replace(/_/g, " ") // Convert underscores to spaces
		.replace(/\s+/g, " ") // Collapse duplicate spaces
		.trim();
}
