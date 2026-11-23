
const $ = id => document.getElementById(id);

let socket = null;
let currentToken = localStorage.getItem("connectU_token") || "";
let currentUsername = "";
let profile = null;
let authMode = "login";

let activeChat = { type: "group", username: null };
let conversations = {};
let onlineUsers = [];
let typingTimer = null;

let peerConnection = null;
let localStream = null;
let remoteStream = null;
let activeCall = null;
let incomingOffer = null;
let queuedIceCandidates = [];

const rtcConfiguration = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun.cloudflare.com:3478" }
    ]
};

/* AUTHENTICATION */

function setAuthMode(mode) {
    authMode = mode;

    $("loginTab").classList.toggle("active", mode === "login");
    $("registerTab").classList.toggle("active", mode === "register");

    $("authDescription").textContent = mode === "login"
        ? "Welcome back. Sign in to continue."
        : "Create your student account.";

    $("confirmPasswordField").hidden = mode !== "register";

    $("authSubmit").textContent = mode === "login"
        ? "Login"
        : "Create account";

    $("loginError").textContent = "";
}

$("loginTab").addEventListener("click", () => setAuthMode("login"));
$("registerTab").addEventListener("click", () => setAuthMode("register"));

async function apiRequest(endpoint, method = "GET", data = null) {
    const options = {
        method,
        headers: {}
    };

    if (data) {
        options.headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(data);
    }

    if (currentToken) {
        options.headers.Authorization = `Bearer ${currentToken}`;
    }

    const response = await fetch(endpoint, options);
    const result = await response.json();

    if (!response.ok) {
        throw new Error(result.error || "Something went wrong.");
    }

    return result;
}

$("authForm").addEventListener("submit", async event => {
    event.preventDefault();

    const username = $("usernameInput").value.trim();
    const password = $("passwordInput").value;
    const confirm = $("confirmPasswordInput").value;

    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
        $("loginError").textContent =
            "Username must be 3–20 letters, numbers or underscores.";
        return;
    }

    if (password.length < 8 || password.length > 72) {
        $("loginError").textContent =
            "Password must be 8–72 characters.";
        return;
    }

    if (authMode === "register" && password !== confirm) {
        $("loginError").textContent = "Passwords do not match.";
        return;
    }

    $("authSubmit").disabled = true;
    $("authSubmit").textContent = "Please wait...";

    try {
        const result = await apiRequest(
            authMode === "register" ? "/api/register" : "/api/login",
            "POST",
            { username, password }
        );

        currentToken = result.token;
        localStorage.setItem("connectU_token", currentToken);

        $("passwordInput").value = "";
        $("confirmPasswordInput").value = "";

        connectToServer();
    } catch (error) {
        $("loginError").textContent = error.message;
    } finally {
        $("authSubmit").disabled = false;
        $("authSubmit").textContent =
            authMode === "login" ? "Login" : "Create account";
    }
});

async function restoreSession() {
    if (!currentToken) return;

    try {
        const result = await apiRequest("/api/me");
        profile = result.profile;
        connectToServer();
    } catch {
        currentToken = "";
        localStorage.removeItem("connectU_token");
    }
}

/* PROFILE */

function updateProfileUI() {
    if (!profile) return;

    $("myDisplayName").textContent =
        profile.displayName || profile.username;

    $("myUsername").textContent = `@${profile.username}`;

    $("myBio").textContent =
        profile.bio || "Available to connect";

    const avatarText = (profile.displayName || profile.username)
        .charAt(0).toUpperCase();

    $("myAvatar").textContent = avatarText;
    $("editAvatar").textContent = avatarText;
}

function openProfileEditor() {
    if (!profile) return;

    $("displayNameInput").value = profile.displayName || profile.username;
    $("bioInput").value = profile.bio || "";
    $("profileError").textContent = "";

    $("profileModal").hidden = false;
    $("profileDropdown").hidden = true;
}

$("openProfile").addEventListener("click", openProfileEditor);
$("profileAvatarButton").addEventListener("click", openProfileEditor);
$("editProfileButton").addEventListener("click", openProfileEditor);

$("openProfileMenu").addEventListener("click", () => {
    $("profileDropdown").hidden = !$("profileDropdown").hidden;
});

$("closeProfile").addEventListener("click", () => {
    $("profileModal").hidden = true;
});

$("profileModal").addEventListener("click", event => {
    if (event.target === $("profileModal")) {
        $("profileModal").hidden = true;
    }
});

$("saveProfile").addEventListener("click", async () => {
    const displayName = $("displayNameInput").value.trim();
    const bio = $("bioInput").value.trim();

    $("profileError").textContent = "";
    $("saveProfile").disabled = true;

    try {
        const result = await apiRequest("/api/profile", "PATCH", {
            displayName,
            bio
        });

        profile = result.profile;
        updateProfileUI();

        $("profileModal").hidden = true;
    } catch (error) {
        $("profileError").textContent = error.message;
    } finally {
        $("saveProfile").disabled = false;
    }
});

/* CONNECTION */

function setConnectionStatus(connected) {
    $("connectionDot").classList.toggle("connected", connected);
    $("connectionText").textContent =
        connected ? "Connected" : "Disconnected";
}

function connectToServer() {
    if (socket && (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
    )) return;

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";

    socket = new WebSocket(
        `${protocol}//${location.host}/?token=${encodeURIComponent(currentToken)}`
    );

    socket.addEventListener("open", () => {
        setConnectionStatus(true);
    });

    socket.addEventListener("message", event => {
        try {
            handleServerMessage(JSON.parse(event.data));
        } catch (error) {
            console.error(error);
        }
    });

    socket.addEventListener("close", event => {
        setConnectionStatus(false);

        if (event.code === 4001) {
            logout("Your account was connected in another session.");
        }
    });

    socket.addEventListener("error", () => {
        setConnectionStatus(false);
    });
}

function sendServer(data) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;

    socket.send(JSON.stringify(data));
    return true;
}

/* SERVER EVENTS */

function handleServerMessage(data) {
    switch (data.type) {
        case "joined":
            currentUsername = data.profile.username;
            profile = data.profile;
            showApplication();
            (data.history || []).forEach(addGroupMessage);
            break;

        case "users":
            onlineUsers = data.users || [];
            renderUsers();
            break;

        case "message":
            addGroupMessage(data);
            break;

        case "private":
            addPrivateMessage(data);
            break;

        case "system":
            addSystemMessage(data.text);
            break;

        case "typing":
            if (
                activeChat.type === "private" &&
                activeChat.username === data.from
            ) {
                $("typingStatus").textContent =
                    `${data.from} is typing...`;

                clearTimeout(typingTimer);
                typingTimer = setTimeout(() => {
                    $("typingStatus").textContent = "";
                }, 1800);
            }
            break;

        case "call:offer":
            receiveCallOffer(data);
            break;

        case "call:answer":
            receiveCallAnswer(data);
            break;

        case "call:ice":
            receiveIceCandidate(data);
            break;

        case "call:reject":
            if (activeCall && activeCall.peer === data.from) {
                finishCall(false, `${data.from} declined your call.`);
            }
            break;

        case "call:end":
            if (activeCall && activeCall.peer === data.from) {
                finishCall(false, "The other student ended the call.");
            }
            break;

        case "call:unavailable":
            if (activeCall && activeCall.peer === data.to) {
                finishCall(false, "That student is unavailable.");
            }
            break;
    }
}

function showApplication() {
    $("loginScreen").hidden = true;
    $("app").hidden = false;
    updateProfileUI();
}

/* STUDENT LIST */

function renderUsers() {
    $("usersList").replaceChildren();

    const others = onlineUsers.filter(
        name => name.toLowerCase() !== currentUsername.toLowerCase()
    );

    $("onlineCount").textContent = `${onlineUsers.length} online`;

    others.forEach(username => {
        const item = document.createElement("div");
        item.className = "user-item";
        item.dataset.username = username;

        const avatar = document.createElement("div");
        avatar.className = "user-avatar";
        avatar.textContent = username[0].toUpperCase();

        const details = document.createElement("div");
        details.className = "user-details";

        const name = document.createElement("strong");
        name.textContent = username;

        const status = document.createElement("small");
        status.textContent = "Online";

        details.append(name, status);
        item.append(avatar, details);

        item.addEventListener("click", () => openPrivateChat(username));

        const controls = document.createElement("div");
        controls.className = "user-call-buttons";

        const voice = document.createElement("button");
        voice.className = "user-call-button";
        voice.type = "button";
        voice.textContent = "☎";
        voice.title = "Voice call";

        voice.addEventListener("click", event => {
            event.stopPropagation();
            startCall(username, "audio");
        });

        const video = document.createElement("button");
        video.className = "user-call-button";
        video.type = "button";
        video.textContent = "▣";
        video.title = "Video call";

        video.addEventListener("click", event => {
            event.stopPropagation();
            startCall(username, "video");
        });

        controls.append(voice, video);
        item.append(controls);

        $("usersList").append(item);
    });

    updateActiveUser();
}

function updateActiveUser() {
    document.querySelectorAll(".user-item").forEach(item => {
        item.classList.toggle(
            "active",
            activeChat.type === "group"
                ? item.id === "groupButton"
                : item.dataset.username === activeChat.username
        );
    });
}

/* MESSAGING */

function openGroupChat() {
    activeChat = { type: "group", username: null };

    $("chatTitle").textContent = "Student Lounge";
    $("chatSubtitle").textContent = "Connect with everyone";
    $("headerChatIcon").textContent = "#";
    $("typingStatus").textContent = "";

    renderConversation("group");
    updateActiveUser();
    closeMobileSidebar();
}

function openPrivateChat(username) {
    activeChat = { type: "private", username };

    $("chatTitle").textContent = username;
    $("chatSubtitle").textContent = "Private conversation";
    $("headerChatIcon").textContent = username[0].toUpperCase();
    $("typingStatus").textContent = "";

    renderConversation(username);
    updateActiveUser();
    closeMobileSidebar();
}

function renderConversation(key) {
    $("messagesList").replaceChildren();

    (conversations[key] || []).forEach(message => {
        if (message.system) {
            addSystemMessage(message.text, false);
        } else {
            renderMessage(message, false);
        }
    });

    scrollToBottom();
}

function addGroupMessage(data) {
    if (!conversations.group) conversations.group = [];

    conversations.group.push({
        from: data.from,
        text: data.text,
        time: data.time
    });

    if (activeChat.type === "group") renderMessage(data);
}

function addPrivateMessage(data) {
    const otherPerson = data.from;

    if (!otherPerson) return;

    if (!conversations[otherPerson]) {
        conversations[otherPerson] = [];
    }

    const message = {
        from: data.from,
        text: data.text,
        time: data.time
    };

    conversations[otherPerson].push(message);

    if (
        activeChat.type === "private" &&
        activeChat.username === otherPerson
    ) {
        renderMessage(message);
    }
}

function renderMessage(data, shouldScroll = true) {
    const wrapper = document.createElement("div");
    wrapper.className = "message" +
        (data.from === currentUsername ? " mine" : "");

    const meta = document.createElement("div");
    meta.className = "message-meta";

    meta.textContent = `${data.from} · ${new Date(
        data.time || Date.now()
    ).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
    })}`;

    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    bubble.textContent = data.text;

    wrapper.append(meta, bubble);
    $("messagesList").append(wrapper);

    if (shouldScroll) scrollToBottom();
}

function addSystemMessage(text, save = true) {
    if (save) {
        if (!conversations.group) conversations.group = [];
        conversations.group.push({ system: true, text });
    }

    if (activeChat.type !== "group") return;

    const element = document.createElement("div");
    element.className = "system-message";
    element.textContent = text;

    $("messagesList").append(element);
    scrollToBottom();
}

function scrollToBottom() {
    $("messagesArea").scrollTop = $("messagesArea").scrollHeight;
}

$("groupButton").addEventListener("click", openGroupChat);

$("messageForm").addEventListener("submit", event => {
    event.preventDefault();

    const text = $("messageInput").value.trim();
    if (!text) return;

    if (activeChat.type === "group") {
        sendServer({ type: "message", text });
    } else {
        const sent = sendServer({
            type: "private",
            to: activeChat.username,
            text
        });

        if (sent) {
            if (!conversations[activeChat.username]) {
                conversations[activeChat.username] = [];
            }

            const message = {
                from: currentUsername,
                text,
                time: Date.now()
            };

            conversations[activeChat.username].push(message);
            renderMessage(message);
        }
    }

    $("messageInput").value = "";
});

$("messageInput").addEventListener("input", () => {
    if (activeChat.type === "private") {
        sendServer({
            type: "typing",
            to: activeChat.username
        });
    }
});

/* WEBRTC CALLS */

function callSignal(type, extra = {}) {
    if (!activeCall) return;

    sendServer({
        type,
        to: activeCall.peer,
        ...extra
    });
}

async function getMedia(mode) {
    if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera and microphone require HTTPS or localhost.");
    }

    return navigator.mediaDevices.getUserMedia({
        audio: true,
        video: mode === "video" ? { facingMode: "user" } : false
    });
}

function showCallScreen() {
    $("callScreen").hidden = false;
    $("callPerson").textContent = activeCall.peer;
    $("callStatus").textContent = "Connecting...";
    $("remoteVideo").srcObject = null;
    $("localVideo").srcObject = localStream;
    $("remotePlaceholder").hidden = false;
}

function createPeerConnection() {
    peerConnection = new RTCPeerConnection(rtcConfiguration);
    remoteStream = new MediaStream();

    $("remoteVideo").srcObject = remoteStream;

    peerConnection.ontrack = event => {
        event.streams[0].getTracks().forEach(track => {
            if (!remoteStream.getTracks().some(t => t.id === track.id)) {
                remoteStream.addTrack(track);
            }
        });

        $("remotePlaceholder").hidden =
            remoteStream.getVideoTracks().length > 0;
    };

    peerConnection.onicecandidate = event => {
        if (event.candidate) {
            callSignal("call:ice", {
                candidate: event.candidate
            });
        }
    };

    peerConnection.onconnectionstatechange = () => {
        if (!peerConnection || !activeCall) return;

        const state = peerConnection.connectionState;

        if (state === "connected") {
            $("callStatus").textContent = "Connected";
        }

        if (state === "failed") {
            finishCall(true, "Connection failed. Check your network.");
        }

        if (state === "disconnected") {
            $("callStatus").textContent = "Connection interrupted...";
        }
    };

    if (localStream) {
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
    }
}

async function startCall(username, mode) {
    if (activeCall || incomingOffer) {
        alert("You are already in a call.");
        return;
    }

    if (!sendServer({
        type: "typing",
        to: username
    }) && (!socket || socket.readyState !== WebSocket.OPEN)) {
        alert("You are not connected.");
        return;
    }

    activeCall = {
        peer: username,
        mode,
        initiator: true
    };

    try {
        showCallScreen();

        $("callStatus").textContent = "Requesting permissions...";

        localStream = await getMedia(mode);
        $("localVideo").srcObject = localStream;

        createPeerConnection();

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        callSignal("call:offer", {
            offer,
            mode
        });

        $("callStatus").textContent = "Calling...";
    } catch (error) {
        console.error(error);
        finishCall(false, error.message || "Could not start call.");
    }
}

function receiveCallOffer(data) {
    if (activeCall || incomingOffer) {
        sendServer({
            type: "call:reject",
            to: data.from
        });
        return;
    }

    incomingOffer = data;

    $("incomingCaller").textContent = data.from;
    $("incomingAvatar").textContent = data.from[0].toUpperCase();

    $("incomingCallType").textContent =
        data.mode === "video" ? "Incoming video call" : "Incoming voice call";

    $("incomingCall").hidden = false;
}

$("acceptCall").addEventListener("click", async () => {
    if (!incomingOffer) return;

    const offerData = incomingOffer;
    incomingOffer = null;
    $("incomingCall").hidden = true;

    activeCall = {
        peer: offerData.from,
        mode: offerData.mode,
        initiator: false
    };

    try {
        showCallScreen();

        $("callStatus").textContent = "Requesting permissions...";

        localStream = await getMedia(activeCall.mode);
        $("localVideo").srcObject = localStream;

        createPeerConnection();

        await peerConnection.setRemoteDescription(
            new RTCSessionDescription(offerData.offer)
        );

        await processQueuedIce();

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        callSignal("call:answer", { answer });

        $("callStatus").textContent = "Connecting...";
    } catch (error) {
        console.error(error);
        finishCall(true, error.message || "Could not accept call.");
    }
});

$("declineCall").addEventListener("click", () => {
    if (incomingOffer) {
        sendServer({
            type: "call:reject",
            to: incomingOffer.from
        });
    }

    incomingOffer = null;
    $("incomingCall").hidden = true;
});

async function receiveCallAnswer(data) {
    if (!activeCall || !peerConnection) return;
    if (activeCall.peer !== data.from) return;

    try {
        await peerConnection.setRemoteDescription(
            new RTCSessionDescription(data.answer)
        );

        await processQueuedIce();
    } catch (error) {
        console.error(error);
        finishCall(true, "Could not establish the call.");
    }
}

async function receiveIceCandidate(data) {
    if (
        (!activeCall || activeCall.peer !== data.from) &&
        (!incomingOffer || incomingOffer.from !== data.from)
    ) return;

    if (!data.candidate) return;

    const candidate = new RTCIceCandidate(data.candidate);

    if (!peerConnection || !peerConnection.remoteDescription) {
        queuedIceCandidates.push(candidate);
        return;
    }

    try {
        await peerConnection.addIceCandidate(candidate);
    } catch (error) {
        console.error(error);
    }
}

async function processQueuedIce() {
    if (!peerConnection || !peerConnection.remoteDescription) return;

    const candidates = [...queuedIceCandidates];
    queuedIceCandidates = [];

    for (const candidate of candidates) {
        try {
            await peerConnection.addIceCandidate(candidate);
        } catch (error) {
            console.error(error);
        }
    }
}

function finishCall(notifyPeer = true, message = "") {
    const previousCall = activeCall;

    if (notifyPeer && previousCall) {
        sendServer({
            type: "call:end",
            to: previousCall.peer
        });
    }

    if (peerConnection) {
        peerConnection.ontrack = null;
        peerConnection.onicecandidate = null;
        peerConnection.close();
        peerConnection = null;
    }

    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }

    if (remoteStream) {
        remoteStream.getTracks().forEach(track => track.stop());
        remoteStream = null;
    }

    $("localVideo").srcObject = null;
    $("remoteVideo").srcObject = null;
    $("callScreen").hidden = true;
    $("remotePlaceholder").hidden = false;
    $("muteButton").textContent = "Mute";
    $("cameraButton").textContent = "Camera off";

    activeCall = null;
    incomingOffer = null;
    queuedIceCandidates = [];

    if (message) alert(message);
}

$("endCallButton").addEventListener("click", () => finishCall(true));

$("muteButton").addEventListener("click", () => {
    const track = localStream?.getAudioTracks()[0];
    if (!track) return;

    track.enabled = !track.enabled;
    $("muteButton").textContent = track.enabled ? "Mute" : "Unmute";
});

$("cameraButton").addEventListener("click", () => {
    const track = localStream?.getVideoTracks()[0];
    if (!track) return;

    track.enabled = !track.enabled;
    $("cameraButton").textContent =
        track.enabled ? "Camera off" : "Camera on";
});

/* MOBILE SIDEBAR */

$("openSidebar").addEventListener("click", () => {
    $("sidebar").classList.add("open");
});

$("closeSidebar").addEventListener("click", closeMobileSidebar);

function closeMobileSidebar() {
    $("sidebar").classList.remove("open");
}

/* LOGOUT */

function logout(message = "") {
    finishCall(true);

    currentToken = "";
    localStorage.removeItem("connectU_token");

    if (socket) {
        socket.close();
        socket = null;
    }

    currentUsername = "";
    profile = null;
    conversations = {};
    onlineUsers = [];
    activeChat = { type: "group", username: null };

    $("app").hidden = true;
    $("loginScreen").hidden = false;
    $("profileModal").hidden = true;
    $("profileDropdown").hidden = true;
    $("usersList").replaceChildren();
    $("messagesList").replaceChildren();

    $("loginError").textContent = message;

    setAuthMode("login");
    setConnectionStatus(false);
}

$("logoutButton").addEventListener("click", () => logout());

/* START */

setAuthMode("login");
setConnectionStatus(false);
restoreSession();
