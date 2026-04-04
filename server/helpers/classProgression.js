// Loads class progression data from the shared JSON config file and exposes
// the same helper functions that the old data/classProgression.js module did.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "..", "..", "client", "config", "classProgression.json");

export const classProgression = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

/**
 * Returns the ability granted at a given level for a class.
 * Returns the first option (auto-grant). When multiple options exist
 * the caller should present a picker instead of auto-selecting index 0.
 *
 * @param {string} className - The name of the character class (e.g. "Warrior").
 * @param {number|string} level - The character level to look up.
 * @returns {object|null} The first ability option object for the given class and level,
 *   or null if no ability is defined at that level.
 */
export function getAbilityForLevel(className, level) {
  const options = classProgression[className]?.[level];
  if (!options || options.length === 0) return null;
  return options[0];
}

/**
 * Returns true if this level has a defined ability for the given class.
 *
 * @param {string} className - The name of the character class (e.g. "Warrior").
 * @param {number|string} level - The character level to check.
 * @returns {boolean} True if at least one ability option is defined for the class
 *   at the given level, false otherwise.
 */
export function hasAbilityForLevel(className, level) {
  return !!(classProgression[className]?.[level]?.length);
}
