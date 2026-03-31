const socket = io();

// Extract query params
const params = new URLSearchParams(window.location.search);
const lobbyId = params.get("lobbyId");
const clientId = params.get("clientId");
let currentUsers = [];

// Generate default name if not provided
let name = params.get("name");
if (!name || name === "null" || name.trim() === "") {
	name = "Anon#" + Math.floor(1000 + Math.random() * 9000);
}

// DOM refs
const msgsEl = document.getElementById("msgs");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");
const usersEl = document.getElementById("users");

let typingTimeout = null;
let isTyping = false;
const typingUsers = new Set();

// === Join chat room ===
console.log("[chat] joining lobby", lobbyId, "as", name, "(", clientId, ")");
socket.emit("chat:join", { lobbyId, name, clientId });

// === Render Chat Messages ===
function addMessage({ name, text, timestamp }) {
	const time = new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	const div = document.createElement("div");
	div.textContent = `[${time}] ${name}: ${text}`;
	msgsEl.appendChild(div);
	msgsEl.scrollTop = msgsEl.scrollHeight;
}

// === Render User List ===
function renderUserList(users, typingList) {
	usersEl.innerHTML = "";
	users.forEach((u) => {
		const entry = document.createElement("div");
		entry.className = "user-entry";
		entry.innerHTML = `
      <span>${u}</span>
      ${typingList.has(u) ? `<span class="typing">typing...</span>` : ""}
    `;
		usersEl.appendChild(entry);
	});
}

// === Send Message ===
function sendMsg() {
	const txt = inputEl.value.trim();
	if (!txt || !lobbyId) return;
	socket.emit("chat:message", { lobbyId, name, text: txt });
	inputEl.value = "";
	stopTyping();
}
sendBtn.addEventListener("click", sendMsg);
inputEl.addEventListener("keydown", (e) => {
	if (e.key === "Enter") sendMsg();
});

// === Typing detection ===
inputEl.addEventListener("input", () => {
	if (!lobbyId) return;
	if (!isTyping) {
		isTyping = true;
		socket.emit("chat:typing", { lobbyId, name, typing: true });
	}
	clearTimeout(typingTimeout);
	typingTimeout = setTimeout(() => {
		if (isTyping) {
			isTyping = false;
			socket.emit("chat:typing", { lobbyId, name, typing: false });
		}
	}, 1500);
});

function stopTyping() {
	if (!isTyping) return;
	isTyping = false;
	socket.emit("chat:typing", { lobbyId, name, typing: false });
}

// === Incoming events ===
socket.on("chat:message", addMessage);

socket.on("chat:users", (users) => {
	currentUsers = users;
	renderUserList(users, typingUsers);
});

socket.on("chat:typing", ({ name, typing }) => {
	if (typing) typingUsers.add(name);
	else typingUsers.delete(name);
	renderUserList(currentUsers, typingUsers);
});

// Load chat history
socket.on("chat:history", (messages) => {
	msgsEl.innerHTML = "";
	messages.forEach(addMessage);
});

socket.on("chat:historyUpdate", (messages) => {
	const wasAtBottom = msgsEl.scrollHeight - msgsEl.scrollTop <= msgsEl.clientHeight + 5;
	msgsEl.innerHTML = "";
	messages.forEach(addMessage);
	if (wasAtBottom) msgsEl.scrollTop = msgsEl.scrollHeight;
});

// Handle name change announcements
socket.on("chat:nameChange", ({ oldName, newName, clientId: changedId }) => {
	console.log("[chat] nameChange received:", oldName, "→", newName, "(", changedId, ")");
	if (changedId === clientId) {
		console.log("[chat] this chat window belongs to that clientId — updating local name to", newName);
		name = newName;
	}

	// Update typing list
	if (typingUsers.has(oldName)) {
		typingUsers.delete(oldName);
		typingUsers.add(newName);
	}

	// Announcement
	const div = document.createElement("div");
	div.style.color = "#888";
	div.style.fontStyle = "italic";
	div.textContent = `${oldName} is now known as ${newName}.`;
	msgsEl.appendChild(div);
	msgsEl.scrollTop = msgsEl.scrollHeight;

	// Replace old message labels
	const allMsgs = msgsEl.querySelectorAll("div");
	for (const el of allMsgs) {
		if (el.textContent.includes(`${oldName}:`)) {
			el.textContent = el.textContent.replace(`${oldName}:`, `${newName}:`);
		}
	}

	// Refresh user list
	currentUsers = currentUsers.map((u) => (u === oldName ? newName : u));
	renderUserList(currentUsers, typingUsers);
});
