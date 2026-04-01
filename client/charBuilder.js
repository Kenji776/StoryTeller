let hasSavedSheet = false;

// === Character Creation Enhancements ===
const basePoints = 27;
const costTable = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
const attrs = ["str", "dex", "con", "int", "wis", "cha"];

const sheetInputs = ["name", "race", "cls", "alignment", "background", "deity", "gender", "age", "height", "weight", "hp", "str", "dex", "con", "int", "wis", "cha", "abilities", "inventory", "desc"];

// Random alignment
const alignments = ["Lawful Good", "Neutral Good", "Chaotic Good", "Lawful Neutral", "True Neutral", "Chaotic Neutral", "Lawful Evil", "Neutral Evil", "Chaotic Evil"];
document.getElementById("alignment").value = alignments[Math.floor(Math.random() * alignments.length)];

// Random background
const backgrounds = ["Acolyte", "Charlatan", "Criminal", "Entertainer", "Folk Hero", "Guild Artisan", "Hermit", "Noble", "Outlander", "Sage", "Sailor", "Soldier", "Urchin"];

// Random deity (fun placeholder flavor)
const deities = ["Bahamut", "Pelor", "Tymora", "Mystra", "Kord", "Lolth", "Moradin", "Corellon", "Vecna", "The Raven Queen"];

const genders = ["Male (he/him)", "Female (she/her)", "Nonbinary (they/them)", "Agender (they/them)", "Fluid (any)"];

// === Race-based name pools (loaded from raceNames.json) ===
let raceNames = {};
fetch("/config/raceNames.json")
	.then((r) => r.json())
	.then((data) => { raceNames = data; })
	.catch((err) => console.warn("Could not load raceNames.json:", err));

// === Weapon data (loaded from weapons.json) ===
let weaponData = [];
fetch("/config/weapons.json")
	.then((r) => r.json())
	.then((data) => {
		weaponData = data;
		const cls = document.getElementById("cls")?.value || "Fighter";
		populateWeaponSelect(cls);
	})
	.catch((err) => console.warn("Could not load weapons.json:", err));

function populateWeaponSelect(cls) {
	const sel = document.getElementById("weaponSelect");
	if (!sel) return;
	const current = sel.value;
	const filtered = weaponData.filter(w => w.classes.includes(cls));
	sel.innerHTML = `<option value="">— Select a weapon —</option>` +
		filtered.map(w => `<option value="${w.name}">${w.name} (${w.damage} ${w.damageType})</option>`).join("");
	if (filtered.some(w => w.name === current)) {
		sel.value = current;
	} else if (filtered.length) {
		sel.value = filtered[0].name;
	}
}

// === Armor data (loaded from armor.json) ===
let armorData = [];
fetch("/config/armor.json")
	.then((r) => r.json())
	.then((data) => {
		armorData = data;
		const cls = document.getElementById("cls")?.value || "Fighter";
		populateArmorSelect(cls);
	})
	.catch((err) => console.warn("Could not load armor.json:", err));

function populateArmorSelect(cls) {
	const sel = document.getElementById("armorSelect");
	if (!sel) return;
	const current = sel.value;
	const filtered = armorData.filter(a => a.startingSelectable && a.classes.includes(cls));
	sel.innerHTML = `<option value="">— Select armor —</option>` +
		filtered.map(a => `<option value="${a.name}">${a.name} (AC ${a.ac}, ${a.type})</option>`).join("");
	if (filtered.some(a => a.name === current)) {
		sel.value = current;
	} else if (filtered.length) {
		sel.value = filtered[0].name;
	}
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function generateRaceName(race, gender) {
	const pool = raceNames[race] || raceNames["Human"] || {};
	const isFemale = gender && gender.startsWith("Female");
	const isMale   = gender && gender.startsWith("Male");
	// Nonbinary / Agender / Fluid / unknown → pick randomly from either pool
	const firstPool = isFemale ? (pool.female_first || pool.male_first || ["Hero"])
	                : isMale   ? (pool.male_first   || pool.female_first || ["Hero"])
	                :            (Math.random() < 0.5 ? (pool.male_first || []) : (pool.female_first || [])).concat() || ["Hero"];
	const lastPool  = pool.last || ["Adventurer"];
	return `${pick(firstPool.length ? firstPool : ["Hero"])} ${pick(lastPool)}`;
}

// Auto-fill defaults when class/race changes
// === CLASS DEFAULT BUILDS (object-based inventory) ===

// === Shared Standard Loadout (everyone gets this) ===
const standardLoadout = [
	{ name: "Backpack", count: 1, description: "A sturdy leather backpack to carry your gear.", attributes: {} },
	{ name: "Bedroll", count: 1, description: "A simple roll for sleeping outdoors.", attributes: {} },
	{ name: "Rations", count: 5, description: "Dried food good for a few days of travel.", attributes: {} },
	{ name: "Waterskin", count: 1, description: "A leather flask for carrying water.", attributes: {} },
	{ name: "Torch", count: 5, description: "Provides bright light in a 20 ft. radius for 1 hour.", attributes: {} },
	{ name: "Tinderbox", count: 1, description: "Used to light torches, campfires, or candles.", attributes: {} },
	{ name: "Rope (50 ft.)", count: 1, description: "A coil of hempen rope useful for climbing or tying.", attributes: {} },
	{ name: "Healing Potion", count: 1, description: "Restores 2d4 + 2 hit points when consumed.", attributes: { healing: "2d4+2" } },
];

// === Default Builds ===
const defaultBuilds = {
	Fighter: {
		abilities: [
			{
				name: "Second Wind",
				description: "You push through pain and fatigue, regaining a small burst of stamina.",
				details: { uses: 1, recharge: "short rest", effect: "Regain a modest amount of HP." },
			},
			{
				name: "Action Surge",
				description: "Summon inner strength to take an extra action in combat.",
				details: { uses: 1, recharge: "short rest", effect: "Gain one additional action this turn." },
			},
		],
		inventory: [
			{ name: "Longsword", count: 1, description: "A balanced, dependable blade for close combat." },
			{ name: "Shield", count: 1, description: "Grants +2 protection when wielded." },
			{ name: "Chain Mail", count: 1, description: "Heavy armor that clinks but protects well." },
		],
	},

	Wizard: {
		abilities: [
			{
				name: "Mage Armor",
				description: "Weave an invisible field of energy around yourself or an ally.",
				details: { duration: "8 hours", effect: "Boosts protection without encumbering movement." },
			},
			{
				name: "Magic Missile",
				description: "Summon glowing bolts of force that unerringly strike their targets.",
				details: { damage: "1d4+1 per bolt", range: "120 ft." },
			},
			{
				name: "Fire Bolt",
				description: "Launch a searing mote of fire at a distant foe.",
				details: { damage: "1d10 fire", range: "120 ft.", effect: "Can ignite flammable objects." },
			},
		],
		inventory: [
			{ name: "Spellbook", count: 1, description: "A tome of arcane theory and practice." },
			{ name: "Wand", count: 1, description: "A conduit for precise magical control." },
			{ name: "Robes", count: 1, description: "Elegant garments imbued with faint protective runes." },
		],
	},

	Cleric: {
		abilities: [
			{
				name: "Cure Wounds",
				description: "Channel divine warmth to mend the injured.",
				details: { range: "Touch", healing: "1d8 + Wisdom modifier" },
			},
			{
				name: "Guiding Bolt",
				description: "Hurl a radiant lance that marks your foe for allies.",
				details: { damage: "4d6 radiant", range: "120 ft.", effect: "Next attack has advantage." },
			},
			{
				name: "Sacred Flame",
				description: "Call down purifying light upon your enemies.",
				details: { damage: "1d8 radiant", save: "Dexterity", effect: "Ignores cover." },
			},
		],
		inventory: [
			{ name: "Mace", count: 1, description: "Weighted head for crushing armor." },
			{ name: "Holy Symbol", count: 1, description: "Focus for channeling divine power." },
			{ name: "Chain Mail", count: 1, description: "Rings of steel offering faithful defense." },
		],
	},

	Rogue: {
		abilities: [
			{
				name: "Sneak Attack",
				description: "Strike from the shadows, exploiting an enemy’s distraction.",
				details: { bonus: "extra damage once per turn", condition: "advantage or ally adjacent" },
			},
			{
				name: "Cunning Action",
				description: "Move swiftly — dash, disengage, or hide in the blink of an eye.",
				details: { usage: "bonus action", recharge: "every turn" },
			},
		],
		inventory: [
			{ name: "Dagger", count: 1, description: "A sharp, easily concealed weapon." },
			{ name: "Lockpicks", count: 1, description: "Essential tools of a discreet profession." },
			{ name: "Leather Armor", count: 1, description: "Supple protection that allows free movement." },
		],
	},

	Ranger: {
		abilities: [
			{
				name: "Hunter’s Mark",
				description: "Mark a foe to track and strike with deadly precision.",
				details: { effect: "Extra damage on hits, advantage on tracking" },
			},
			{
				name: "Cure Wounds",
				description: "Call upon nature’s touch to heal an ally.",
				details: { healing: "1d8 + Wisdom modifier" },
			},
		],
		inventory: [
			{ name: "Longbow", count: 1, description: "A finely crafted bow for distant foes." },
			{ name: "Shortsword", count: 1, description: "Reliable sidearm for close encounters." },
			{ name: "Leather Armor", count: 1, description: "Light armor that blends into the wild." },
		],
	},

	Paladin: {
		abilities: [
			{
				name: "Lay on Hands",
				description: "Your touch channels divine vitality to heal wounds or purge disease.",
				details: { pool: "5 × level HP", usage: "action" },
			},
			{
				name: "Divine Smite",
				description: "Unleash radiant power through your weapon upon striking a foe.",
				details: { bonusDamage: "2d8 radiant", effect: "extra damage on hit" },
			},
		],
		inventory: [
			{ name: "Longsword", count: 1, description: "Holy blade, polished and purposeful." },
			{ name: "Shield", count: 1, description: "Inscribed with your order’s emblem." },
			{ name: "Chain Mail", count: 1, description: "Blessed armor that gleams in sunlight." },
		],
	},

	Barbarian: {
		abilities: [
			{
				name: "Rage",
				description: "Enter a primal fury, shrugging off pain and striking harder.",
				details: { duration: "1 minute", bonus: "+damage, resistance to physical hits" },
			},
			{
				name: "Reckless Attack",
				description: "Throw caution aside for a brutal assault, leaving yourself exposed.",
				details: { effect: "Advantage on attacks, enemies gain advantage vs. you until next turn" },
			},
		],
		inventory: [
			{ name: "Greataxe", count: 1, description: "A heavy blade for splitting foes in two." },
			{ name: "Javelin", count: 3, description: "Thrown spear for medium range." },
			{ name: "Hide Armor", count: 1, description: "Fur and leather bound by sinew." },
		],
	},

	Bard: {
		abilities: [
			{
				name: "Inspiration",
				description: "Bolster an ally with music or words that stir the soul.",
				details: { effect: "Grants a bonus die to an ally’s roll" },
			},
			{
				name: "Vicious Mockery",
				description: "Hurl a cutting insult so powerful it damages the ego and body.",
				details: { damage: "1d4 psychic", effect: "Target has disadvantage on next attack" },
			},
		],
		inventory: [
			{ name: "Lute", count: 1, description: "Beloved companion of a wandering performer." },
			{ name: "Dagger", count: 1, description: "A hidden blade for emergencies." },
			{ name: "Leather Armor", count: 1, description: "Flexible armor suitable for travel and showmanship." },
		],
	},

	Monk: {
		abilities: [
			{
				name: "Flurry of Blows",
				description: "Channel your ki to unleash a flurry of rapid strikes.",
				details: { usage: "bonus action", attacks: "+2 unarmed strikes" },
			},
			{
				name: "Deflect Missiles",
				description: "Use your reflexes to catch or deflect incoming projectiles.",
				details: { reaction: "reduce damage by roll; can throw it back with ki" },
			},
		],
		inventory: [
			{ name: "Quarterstaff", count: 1, description: "Balanced staff perfect for fluid combat." },
			{ name: "Robes", count: 1, description: "Simple garments that move with the body." },
		],
	},

	Druid: {
		abilities: [
			{
				name: "Wild Shape",
				description: "Transform into a beast form of nature’s choosing.",
				details: { duration: "hours", limitation: "small or medium beasts at low level" },
			},
			{
				name: "Entangle",
				description: "Summon roots and vines to restrain your enemies.",
				details: { area: "20 ft. square", save: "Strength", duration: "1 minute" },
			},
		],
		inventory: [
			{ name: "Staff", count: 1, description: "Carved with symbols of the natural world." },
			{ name: "Herbalism Kit", count: 1, description: "Used to craft balms and salves." },
		],
	},

	Sorcerer: {
		abilities: [
			{
				name: "Fire Bolt",
				description: "Channel raw magical flame through your fingertips.",
				details: { damage: "1d10 fire", range: "120 ft." },
			},
			{
				name: "Shield",
				description: "A reactionary barrier of force that turns aside attacks.",
				details: { bonus: "+5 AC until start of next turn" },
			},
			{
				name: "Magic Missile",
				description: "A trio of energy bolts that seek their marks unerringly.",
				details: { bolts: 3, damage: "1d4+1 each" },
			},
		],
		inventory: [
			{ name: "Wand", count: 1, description: "A focus for the chaos within." },
			{ name: "Component Pouch", count: 1, description: "Filled with strange arcane trinkets." },
		],
	},

	Warlock: {
		abilities: [
			{
				name: "Eldritch Blast",
				description: "Channel your patron’s power into a crackling beam of force.",
				details: { damage: "1d10 force", range: "120 ft." },
			},
			{
				name: "Hex",
				description: "Curse an enemy to suffer and falter under your gaze.",
				details: { effect: "Extra damage; target rolls disadvantage on chosen stat" },
			},
		],
		inventory: [
			{ name: "Rod", count: 1, description: "A conduit gifted by your patron." },
			{ name: "Leather Armor", count: 1, description: "Dark leather, faintly warm to the touch." },
		],
	},
};

// === Merge standard loadout into every build ===
for (const build of Object.values(defaultBuilds)) {
	build.inventory = [...standardLoadout, ...build.inventory];
}

// Race modifiers (auto adjust stats a bit)
const raceMods = {
	Human: { note: "Versatile +1 all stats", mod: { str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1 } },
	Elf: { note: "+2 DEX", mod: { dex: 2 } },
	Dwarf: { note: "+2 CON", mod: { con: 2 } },
	Halfling: { note: "+2 DEX", mod: { dex: 2 } },
	"Half-Orc": { note: "+2 STR, +1 CON", mod: { str: 2, con: 1 } },
	Tiefling: { note: "+2 CHA, +1 INT", mod: { cha: 2, int: 1 } },
	Dragonborn: { note: "+2 STR, +1 CHA", mod: { str: 2, cha: 1 } },
	Gnome: { note: "+2 INT", mod: { int: 2 } },
};

const races = Object.keys(raceMods);
const classes = Object.keys(defaultBuilds);

function buildCurrentSheet() {
	// === Basic Character Info ===
	const cls = els.charClass?.value.trim() || "Adventurer";
	const race = els.raceSelect?.value.trim() || "";
	const alignment = els.alignment?.value.trim() || "";
	const background = els.background?.value.trim() || "";
	const deity = els.deity?.value.trim() || "";
	const gender = els.gender?.value.trim() || "";
	const age = els.age?.value.trim() || "";
	const height = els.height?.value.trim() || "";
	const weight = els.weight?.value.trim() || "";
	const level = Number(els.level?.value || 1);

	// === Voice ===
	const voice_id = els.voiceSelect?.value || null;

	// === Stats ===
	const stats = {
		hp: Number(els.hp?.value || 10),
		max_hp: Number(els.hp?.value || 10),
		str: Number(document.getElementById("str_slider")?.value || els.str?.value || 10),
		dex: Number(document.getElementById("dex_slider")?.value || els.dex?.value || 10),
		con: Number(document.getElementById("con_slider")?.value || document.getElementById("con")?.value || 10),
		int: Number(document.getElementById("int_slider")?.value || els.int?.value || 10),
		wis: Number(document.getElementById("wis_slider")?.value || document.getElementById("wis")?.value || 10),
		cha: Number(document.getElementById("cha_slider")?.value || document.getElementById("cha")?.value || 10),
	};

	// === Class Abilities & Inventory ===
	let abilities = [];
	let inventory = [];
    let conditions = [];

	if (defaultBuilds[cls]) {
		abilities = structuredClone(defaultBuilds[cls].abilities || []);
		inventory = structuredClone(defaultBuilds[cls].inventory || []);
	} else {
		console.warn(`⚠️ No default build found for class "${cls}".`);
	}

	// === Race Stat Modifiers ===
	if (raceMods[race]) {
		const mods = raceMods[race].mod;
		for (const key in mods) {
			if (stats[key] !== undefined) stats[key] += mods[key];
		}
	}

	// === Description ===
	const description = els.desc?.value.trim() || "";

	// === Weapon ===
	const weaponName = document.getElementById("weaponSelect")?.value || "";
	const weaponEntry = weaponData.find(w => w.name === weaponName) || null;
	const weapon = weaponEntry
		? { name: weaponEntry.name, damage: weaponEntry.damage, damageType: weaponEntry.damageType, range: weaponEntry.range }
		: null;

	// === Armor ===
	const armorName = document.getElementById("armorSelect")?.value || "";
	const armorEntry = armorData.find(a => a.name === armorName) || null;
	const armor = armorEntry
		? { name: armorEntry.name, ac: armorEntry.ac, type: armorEntry.type, material: armorEntry.material, note: armorEntry.note }
		: null;

	// Read gold from the UI (populated on import or state update)
	const goldEl = document.getElementById("charGold");
	const gold = Number(goldEl?.textContent) || 0;

	return {
		class: cls,
		race,
		alignment,
		background,
		deity,
		gender,
		age,
		height,
		weight,
		level,
		stats,
		abilities,
		inventory,
		description,
		voice_id,
		conditions,
		weapon,
		armor,
		gold,
	};
}

async function randomizeCharacter() {
	const raceEl = document.getElementById("race");
	const clsEl = document.getElementById("cls");
	const nameEl = document.getElementById("name");

	// Random race, class, and gender (gender picked first so name pool matches)
	raceEl.value = races[Math.floor(Math.random() * races.length)];
	clsEl.value = classes[Math.floor(Math.random() * classes.length)];
	const genderEl = document.getElementById("gender");
	genderEl.value = genders[Math.floor(Math.random() * genders.length)];
	nameEl.value = generateRaceName(raceEl.value, genderEl.value);

	// === Randomize Attributes ===
	let remaining = basePoints;
	const vals = {};
	attrs.forEach((a) => (vals[a] = 8));
	while (remaining > 0) {
		const stat = attrs[Math.floor(Math.random() * attrs.length)];
		if (vals[stat] < 15) {
			const nextCost = costTable[vals[stat] + 1] - costTable[vals[stat]];
			if (remaining - nextCost >= 0) {
				vals[stat]++;
				remaining -= nextCost;
			} else break;
		}
	}

	// Update sliders and inputs
	attrs.forEach((a) => {
		const slider = document.getElementById(a + "_slider");
		if (slider) slider.value = vals[a];
		const num = document.getElementById(a);
		if (num) num.value = vals[a];
		const span = document.querySelector(`#${a}_slider ~ .attr-value`);
		if (span) span.textContent = vals[a];
	});

	// === Fill Random Character Metadata ===
	document.getElementById("background").value = backgrounds[Math.floor(Math.random() * backgrounds.length)];
	document.getElementById("deity").value = deities[Math.floor(Math.random() * deities.length)];
	document.getElementById("age").value = Math.floor(Math.random() * 80) + 18;
	const heights = ["4'8\"", "5'0\"", "5'4\"", "5'8\"", "6'0\"", "6'2\"", "6'5\""];
	const weights = ["110 lb", "130 lb", "150 lb", "170 lb", "190 lb", "210 lb"];
	document.getElementById("height").value = heights[Math.floor(Math.random() * heights.length)];
	document.getElementById("weight").value = weights[Math.floor(Math.random() * weights.length)];

	updatePointsDisplay();

	// === Auto-select weapon and armor for random class ===
	populateWeaponSelect(clsEl.value);
	populateArmorSelect(clsEl.value);

	// === Build Complete Sheet ===
	const sheet = buildCurrentSheet();

	// === Update UI Components ===
	drawInventoryComponent("charBuilderInventoryContainer", sheet.inventory);
	drawAttributesComponent("charBuilderAttributesContainer", sheet.stats);
	drawAbilitiesComponent("charBuilderAbilitiesContainer", sheet.abilities);

    drawInventoryComponent("gameInventoryContainer", sheet.inventory);
    drawAbilitiesComponent("gameAbilitiesContainer", sheet.abilities, false, true);

	console.log("✅ Character randomized:", sheet);
}

function calcPoints() {
	let spent = 0;
	attrs.forEach((a) => {
		// Try to find the original number input first, else fall back to the slider
		const el = document.getElementById(a) || document.getElementById(a + "_slider");
		if (!el) return; // skip if not found
		const v = Number(el.value);
		spent += costTable[v] || 0;
	});
	return spent;
}

function updatePointsDisplay() {
	const spent = calcPoints();
	const rem = basePoints - spent;
	const el = document.getElementById("pointsRemaining");
	if (el) {
		el.textContent = `Points remaining: ${rem}`;
		el.style.color = rem < 0 ? "red" : "white";
	}

	// Disable save if overspent OR if the sheet is locked (player is ready)
	if (els.saveSheet) {
		els.saveSheet.disabled = rem < 0 || (typeof ready !== "undefined" && ready);
	}
	return rem >= 0;
}

// Watch attribute changes
if (attrs) {
	attrs.forEach((a) => {
		const input = document.getElementById(a);
		if (!input) return;

		// Refresh the point counter immediately while the user is typing — no clamping here
		// because "1" is typed before "12" and we must not snap it to 8 mid-keystroke.
		input.addEventListener("input", updatePointsDisplay);

		// Clamp to 8–15 and enforce budget only when the user commits the value
		// (tabbing away, pressing Enter, or clicking away).
		input.addEventListener("change", () => {
			let v = parseInt(input.value, 10);
			if (isNaN(v) || v < 8) v = 8;
			if (v > 15) v = 15;
			input.value = v;
			// If this change pushed us over budget, pull it back until we're within 27 pts
			while (calcPoints() > basePoints && v > 8) {
				v--;
				input.value = v;
			}
			updatePointsDisplay();
		});
	});
} else {
	console.warn("Attributes elements could not be found. Cannot apply limit math");
}

// Repopulate weapon and armor selectors when class changes
const clsSelectEl = document.getElementById("cls");
if (clsSelectEl) {
	clsSelectEl.addEventListener("change", () => {
		populateWeaponSelect(clsSelectEl.value);
		populateArmorSelect(clsSelectEl.value);
	});
}

function updateInventory(inventory=[]){
    drawInventoryComponent("charBuilderInventoryContainer", inventory, true);
}

function updateAttributes(attributes=[]){
    drawAttributesComponent("charBuilderAttributesContainer", attributes, true);
}

function updateAbilities(abilities = []) {
	drawAbilitiesComponent("charBuilderInventoryContainer", abilities, true);
}

function showAddModal(type, onSubmit) {
	const modal = document.createElement("div");
	modal.className = "add-modal";
	modal.innerHTML = `
		<div class="add-modal-content">
			<button class="modal-close">✕</button>
			<h3>Add New ${type}</h3>
			<label>Name</label>
			<input id="addName" />
			<label>Description</label>
			<textarea id="addDesc"></textarea>
			<button id="addConfirm">Add</button>
		</div>
	`;
	document.body.appendChild(modal);

	modal.querySelector("#addConfirm").onclick = () => {
		const name = modal.querySelector("#addName").value.trim();
		const desc = modal.querySelector("#addDesc").value.trim();
		if (name) onSubmit({ name, description: desc });
		modal.remove();
	};
}