import "./styles.css";
import "./arenaBots.css";
import { validateChatMessage } from "@blob/validation";
import { ACCESS_GATE_ENABLED, hasPrivateBuildAccess, unlockPrivateBuild } from "./accessGate.js";
import { setProfileGameName } from "./identity.js";
import { type BlobProfile, PlatformApiError, resolvePlatformApi } from "./platformApi.js";
import { type AvailableWallet, connectWalletAndCreateProfile, watchAvailableSolanaWallets } from "./wallet.js";
import { startLiveMetrics, type LiveMetricsController, type LiveMetricsSnapshot } from "./liveMetrics.js";

const appRoot = document.querySelector<HTMLDivElement>("#app");

if (!appRoot) {
  throw new Error("BLOB app root was not found.");
}
const app: HTMLDivElement = appRoot;

let freeGameController: { leave(): Promise<void>; sendChat(text: string): void } | undefined;
let openingFreeArena = false;
const platformApi = resolvePlatformApi();
let profile: BlobProfile | null = null;
let availableWallets: AvailableWallet[] = [];
let liveMetricsController: LiveMetricsController | undefined;

initializeApplication();

function initializeApplication(): void {
  if (ACCESS_GATE_ENABLED && !hasPrivateBuildAccess()) {
    renderAccessGate();
    return;
  }
  renderSite();
  void initializeProfileExperience();
}

function renderAccessGate(): void {
  app.innerHTML = `
    <main class="access-gate">
      <section class="access-card" aria-labelledby="access-title">
        <div class="access-orb access-orb-one" aria-hidden="true"></div>
        <div class="access-orb access-orb-two" aria-hidden="true"></div>
        <p class="eyebrow">PRIVATE BUILD</p>
        <p class="access-wordmark" aria-hidden="true">BLOB<span>.</span></p>
        <h1 id="access-title">Access<br /><em>required.</em></h1>
        <p class="access-copy">This build is still taking shape. Enter the access code to continue.</p>
        <form class="access-form" id="access-form">
          <label for="access-code">Access code</label>
          <input id="access-code" name="access-code" type="password" autocomplete="current-password" required aria-describedby="access-error" />
          <p class="access-error" id="access-error" role="alert" aria-live="polite" hidden>That access code is not correct.</p>
          <button class="play-button access-submit" type="submit">Unlock build <span>→</span></button>
        </form>
      </section>
    </main>
  `;

  const form = requiredElement<HTMLFormElement>("#access-form");
  const input = requiredElement<HTMLInputElement>("#access-code");
  const error = requiredElement("#access-error");
  input.addEventListener("input", () => {
    input.removeAttribute("aria-invalid");
    error.hidden = true;
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (unlockPrivateBuild(input.value)) {
      renderSite();
      void initializeProfileExperience();
      return;
    }
    input.setAttribute("aria-invalid", "true");
    error.hidden = false;
    input.focus();
    input.select();
  });
}

function renderSite(): void {
  liveMetricsController?.stop();
  app.innerHTML = `
  <main>
    <nav class="site-nav" aria-label="Primary navigation">
      <a class="wordmark" href="#top" aria-label="BLOB home">BLOB<span>.</span></a>
      <div class="nav-actions">
        <div class="nav-links">
        <a href="#about">About</a>
        <a href="#future">Future</a>
        <a href="https://github.com/BLOBLAT/blob" target="_blank" rel="noreferrer">GitHub</a>
        </div>
        <button class="wallet-button" id="wallet-trigger" type="button">Connect wallet</button>
      </div>
    </nav>

    <section class="hero" id="top" aria-labelledby="hero-title">
      <div class="hero-copy">
        <p class="eyebrow">Independent skill game</p>
        <h1 id="hero-title">EAT.<br />GROW.<br /><em>SURVIVE.</em></h1>
        <p class="intro">A multiplayer arena where instinct, movement, and timing decide who gets bigger.</p>
        <div class="hero-actions">
          <button class="play-button" type="button" data-play-free>Play Free <span>→</span></button>
          <span>Wallet not required</span>
        </div>
      </div>
      <div class="hero-mark" aria-hidden="true">
        <div class="blob blob-main"><i></i><b></b></div>
        <div class="orb orb-one"></div>
        <div class="orb orb-two"></div>
        <div class="spark spark-one">✦</div>
        <div class="spark spark-two">✦</div>
      </div>
    </section>

    <section class="arena-section" aria-labelledby="arena-title">
      <div class="section-heading">
        <p class="eyebrow">Central arena</p>
        <h2 id="arena-title">THE PIT</h2>
      </div>
      <div class="arena-shell" id="arena-shell" role="status" aria-live="polite">
        <div class="arena-grid" aria-hidden="true"></div>
        <div class="arena-food food-one" aria-hidden="true"></div>
        <div class="arena-food food-two" aria-hidden="true"></div>
        <div class="arena-food food-three" aria-hidden="true"></div>
        <div class="arena-blob" aria-hidden="true"><i></i><b></b></div>
        <div class="arena-message">
          <span class="status-dot"></span>
          <p>REAL FREE MODE</p>
          <small>Live players plus clearly marked Arena Bots. No fake stats.</small>
          <button class="play-button arena-play" type="button" data-play-free>Play Free <span>→</span></button>
        </div>
      </div>
    </section>

    <section class="info-grid" id="about">
      <article>
        <p class="eyebrow">The game</p>
        <h2>Simple rules.<br />Sharp instincts.</h2>
        <p>Collect food. Build mass. Hunt smaller blobs. Stay alive. When the arena opens, every competitive outcome will come from real, server-authoritative play.</p>
      </article>
      <article id="future">
        <p class="eyebrow">What’s next</p>
        <h2>Free first.<br />Competition later.</h2>
        <p>Free Mode is a real game, not a demo. A future paid mode will use a separate, stablecoin-oriented settlement layer—without changing the skill game underneath.</p>
      </article>
    </section>

    <section class="live-metrics" aria-label="Live BLOB activity" aria-live="polite">
      <div>
        <strong id="live-visitor-count">—</strong>
        <span>LIVE VISITORS</span>
      </div>
      <div>
        <strong id="live-arena-count">—</strong>
        <span>BLOBS IN THE PIT</span>
      </div>
      <p id="live-metrics-status">Live activity updates from the game server.</p>
    </section>

    <footer>
      <p>© ${new Date().getFullYear()} BLOB</p>
      <div>
        <a href="https://github.com/BLOBLAT/blob" target="_blank" rel="noreferrer">GitHub</a>
        <span>Community channels soon</span>
      </div>
    </footer>
    <dialog class="profile-dialog" id="profile-dialog" aria-labelledby="profile-dialog-title">
      <button class="dialog-close" id="profile-dialog-close" type="button" aria-label="Close profile">×</button>
      <div id="profile-dialog-content"></div>
    </dialog>
  </main>
`;

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-play-free]")) {
    button.addEventListener("click", () => void openFreeArena());
  }
  requiredElement<HTMLButtonElement>("#wallet-trigger").addEventListener("click", () => openProfileDialog());
  requiredElement<HTMLButtonElement>("#profile-dialog-close").addEventListener("click", () => closeProfileDialog());
  liveMetricsController = startLiveMetrics(renderLiveMetrics);
}

function renderLiveMetrics(metrics: LiveMetricsSnapshot | undefined): void {
  const visitorCount = requiredElementOrUndefined<HTMLElement>("#live-visitor-count");
  const arenaCount = requiredElementOrUndefined<HTMLElement>("#live-arena-count");
  const status = requiredElementOrUndefined<HTMLElement>("#live-metrics-status");
  if (!visitorCount || !arenaCount || !status) {
    return;
  }
  if (!metrics) {
    visitorCount.textContent = "—";
    arenaCount.textContent = "—";
    status.textContent = "Live activity is unavailable while the game server is offline.";
    return;
  }
  visitorCount.textContent = String(metrics.liveVisitors);
  arenaCount.textContent = String(metrics.arenaPlayers);
  status.textContent = "Live presence only — no historical visitor tracking.";
}

async function initializeProfileExperience(): Promise<void> {
  watchAvailableSolanaWallets((wallets) => {
    availableWallets = wallets;
    if (requiredElementOrUndefined<HTMLDialogElement>("#profile-dialog")?.open) {
      renderProfileDialog();
    }
  });
  if (!platformApi) {
    renderProfileTrigger();
    return;
  }
  try {
    profile = await platformApi.getCurrentProfile();
    setProfileGameName(profile?.displayName);
  } catch (error) {
    console.warn("[BLOB] profile session could not be restored", error);
  }
  renderProfileTrigger();
}

function openProfileDialog(): void {
  const dialog = requiredElement<HTMLDialogElement>("#profile-dialog");
  renderProfileDialog();
  if (!dialog.open) {
    dialog.showModal();
  }
}

function closeProfileDialog(): void {
  requiredElement<HTMLDialogElement>("#profile-dialog").close();
}

function renderProfileTrigger(): void {
  const trigger = requiredElementOrUndefined<HTMLButtonElement>("#wallet-trigger");
  if (!trigger) {
    return;
  }
  trigger.textContent = profile ? profile.displayName : "Connect wallet";
  trigger.classList.toggle("is-connected", Boolean(profile));
}

function renderProfileDialog(message?: string): void {
  const container = requiredElement("#profile-dialog-content");
  container.replaceChildren();
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "BLOB profile";
  const title = document.createElement("h2");
  title.id = "profile-dialog-title";
  title.textContent = profile ? "YOUR PROFILE" : "CONNECT WALLET";
  const notice = document.createElement("p");
  notice.className = "profile-notice";
  if (message) {
    notice.textContent = message;
  }
  container.append(eyebrow, title, notice);

  if (profile) {
    renderAuthenticatedProfile(container);
  } else {
    renderWalletSelection(container);
  }
}

function renderWalletSelection(container: HTMLElement): void {
  const copy = document.createElement("p");
  copy.className = "profile-copy";
  copy.textContent = "Connect a Solana wallet and sign a one-time BLOB message. Signing never sends USDC or approves a transaction.";
  container.append(copy);
  if (!platformApi) {
    const unavailable = document.createElement("p");
    unavailable.className = "profile-state";
    unavailable.textContent = availableWallets.length > 0
      ? availableWallets.map((wallet) => wallet.name).join(", ") + " detected. Wallet profiles are not configured for this deployment yet."
      : "Wallet profiles are not configured for this deployment yet.";
    container.append(unavailable);
    return;
  }
  if (availableWallets.length === 0) {
    const empty = document.createElement("p");
    empty.className = "profile-state";
    empty.textContent = "No compatible Solana wallet was detected. Install or unlock a Wallet Standard-compatible wallet, then reopen this panel.";
    container.append(empty);
    return;
  }
  const list = document.createElement("div");
  list.className = "wallet-list";
  for (const wallet of availableWallets) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "wallet-option";
    const icon = document.createElement("img");
    icon.src = wallet.icon;
    icon.alt = "";
    const label = document.createElement("span");
    label.textContent = wallet.name;
    button.append(icon, label);
    button.addEventListener("click", () => void connectSelectedWallet(wallet, button));
    list.append(button);
  }
  container.append(list);
}

function renderAuthenticatedProfile(container: HTMLElement): void {
  if (!profile || !platformApi) {
    return;
  }
  const wallet = document.createElement("p");
  wallet.className = "profile-wallet";
  wallet.textContent = "SOLANA · " + shortenWalletAddress(profile.walletAddress);
  const copy = document.createElement("p");
  copy.className = "profile-copy";
  copy.textContent = "Your public display name is used in Free Mode. It may be changed once every 24 hours.";
  const form = document.createElement("form");
  form.className = "profile-form";
  const label = document.createElement("label");
  label.htmlFor = "profile-display-name";
  label.textContent = "Display name";
  const input = document.createElement("input");
  input.id = "profile-display-name";
  input.name = "display-name";
  input.value = profile.displayName;
  input.maxLength = 16;
  input.pattern = "[A-Za-z0-9 _-]{3,16}";
  input.required = true;
  input.setAttribute("autocomplete", "nickname");
  const submit = document.createElement("button");
  submit.className = "play-button";
  submit.type = "submit";
  submit.textContent = "Save name";
  form.append(label, input, submit);
  form.addEventListener("submit", (event) => void renameProfile(event, input, submit));
  const signOut = document.createElement("button");
  signOut.className = "profile-signout";
  signOut.type = "button";
  signOut.textContent = "Sign out of BLOB";
  signOut.addEventListener("click", () => void logoutProfile(signOut));
  container.append(wallet, copy, form, signOut);
}

async function connectSelectedWallet(wallet: AvailableWallet, button: HTMLButtonElement): Promise<void> {
  if (!platformApi) {
    renderProfileDialog("Wallet profiles are not configured for this deployment yet.");
    return;
  }
  button.disabled = true;
  button.textContent = "Connecting…";
  try {
    profile = await connectWalletAndCreateProfile(platformApi, wallet);
    setProfileGameName(profile.displayName);
    renderProfileTrigger();
    renderProfileDialog("Wallet verified. Your BLOB profile is ready.");
  } catch (error) {
    console.warn("[BLOB] wallet sign-in failed", error);
    renderProfileDialog(describeProfileError(error));
  }
}

async function renameProfile(event: SubmitEvent, input: HTMLInputElement, submit: HTMLButtonElement): Promise<void> {
  event.preventDefault();
  if (!platformApi || !profile) {
    return;
  }
  submit.disabled = true;
  try {
    profile = await platformApi.renameProfile(input.value);
    setProfileGameName(profile.displayName);
    renderProfileTrigger();
    renderProfileDialog("Display name saved. It will be used the next time you join an arena.");
  } catch (error) {
    renderProfileDialog(describeProfileError(error));
  }
}

async function logoutProfile(button: HTMLButtonElement): Promise<void> {
  if (!platformApi) {
    return;
  }
  button.disabled = true;
  try {
    await platformApi.logout();
    profile = null;
    setProfileGameName(undefined);
    renderProfileTrigger();
    renderProfileDialog("You are signed out of BLOB. Your wallet itself remains connected in its extension.");
  } catch (error) {
    renderProfileDialog(describeProfileError(error));
  }
}

function describeProfileError(error: unknown): string {
  if (error instanceof PlatformApiError) {
    if (error.code === "PROFILE_RENAME_RATE_LIMITED") {
      return "Display names can be changed once every 24 hours.";
    }
    if (error.code === "DISPLAY_NAME_INVALID") {
      return "Use 3–16 letters, numbers, spaces, underscores, or hyphens.";
    }
    return "BLOB could not verify that request. Please try again.";
  }
  return error instanceof Error ? error.message : "The wallet request could not be completed.";
}

function shortenWalletAddress(walletAddress: string): string {
  return walletAddress.slice(0, 4) + "…" + walletAddress.slice(-4);
}

async function openFreeArena(): Promise<void> {
  if (freeGameController || openingFreeArena) {
    return;
  }
  openingFreeArena = true;
  const arenaShell = document.querySelector<HTMLElement>("#arena-shell");
  if (!arenaShell) {
    throw new Error("BLOB arena container was not found.");
  }

  setPlayButtonsDisabled(true);
  arenaShell.classList.add("is-playing");
  arenaShell.innerHTML = `
    <div class="game-stage">
      <div class="game-canvas" id="game-canvas" aria-label="Live BLOB arena"></div>
      <div class="game-hud" aria-label="Your current arena status">
        <div><span>MASS</span><strong id="game-mass">0</strong></div>
        <div><span>RANK</span><strong id="game-rank">—</strong></div>
        <div><span>ALIVE</span><strong id="game-alive">0</strong></div>
        <div><span>FOOD EATEN</span><strong id="game-food-eaten">0</strong></div>
        <div><span>ROUND</span><strong id="game-round-timer">--:--</strong></div>
        <p class="game-controls">Mouse to steer · WASD / arrows · touch joystick on mobile</p>
        <p class="game-death" id="game-death" hidden>You were eaten — respawning…</p>
      </div>
      <aside class="game-instructions" aria-label="How to play">
        <strong>EAT</strong><span>Collect food to grow.</span>
        <strong>HUNT</strong><span>Eat smaller BLOBs.</span>
        <strong>SURVIVE</strong><span>Finish with the most mass.</span>
      </aside>
      <section class="round-results" id="round-results" aria-live="polite" hidden>
        <p class="eyebrow">Round complete</p>
        <h3>FINAL RESULTS</h3>
        <ol id="round-podium"></ol>
        <p class="personal-result" id="personal-result"></p>
        <p class="next-round" id="next-round"></p>
      </section>
    </div>
    <aside class="game-panel" aria-label="Match information">
      <div class="game-panel-heading">
        <p class="eyebrow">Free Mode</p>
        <button class="leave-game" type="button" id="leave-game">Leave</button>
      </div>
      <p class="game-connection" id="game-connection">Connecting…</p>
      <p class="game-status" id="game-status">Preparing arena…</p>
      <p class="game-participants" id="game-participants">Synchronizing participants…</p>
      <p class="game-timer" id="game-timer"></p>
      <h3>LIVE RANKING</h3>
      <ol class="live-leaderboard" id="live-leaderboard"></ol>
    </aside>
  `;
  document.querySelector<HTMLElement>("#arena-chat")?.remove();
  arenaShell.insertAdjacentHTML("afterend", `
    <section class="arena-chat" id="arena-chat" aria-labelledby="arena-chat-title">
      <div class="arena-chat-heading">
        <div>
          <p class="eyebrow">Arena chat</p>
          <h3 id="arena-chat-title">PIT TALK</h3>
        </div>
        <p class="arena-chat-status" id="arena-chat-status" role="status">Chat connects with the arena.</p>
      </div>
      <ol class="arena-chat-messages" id="arena-chat-messages" aria-live="polite" aria-relevant="additions"></ol>
      <form class="arena-chat-form" id="arena-chat-form">
        <label class="sr-only" for="arena-chat-input">Arena message</label>
        <input id="arena-chat-input" name="message" maxlength="240" autocomplete="off" placeholder="Say something to the pit…" required />
        <button type="submit" class="play-button" id="arena-chat-send">Send</button>
      </form>
      <p class="arena-chat-rule">Plain text only. Links are not allowed.</p>
    </section>
  `);

  const status = requiredElement("#game-status");
  const connection = requiredElement("#game-connection");
  const timer = requiredElement("#game-timer");
  const participants = requiredElement("#game-participants");
  const roundTimer = requiredElement("#game-round-timer");
  const leaderboard = requiredElement("#live-leaderboard");
  const mass = requiredElement("#game-mass");
  const rank = requiredElement("#game-rank");
  const alive = requiredElement("#game-alive");
  const foodEaten = requiredElement("#game-food-eaten");
  const death = requiredElement("#game-death");
  const results = requiredElement("#round-results");
  const podium = requiredElement<HTMLOListElement>("#round-podium");
  const personalResult = requiredElement("#personal-result");
  const nextRound = requiredElement("#next-round");
  const chatMessages = requiredElement<HTMLOListElement>("#arena-chat-messages");
  const chatStatus = requiredElement("#arena-chat-status");
  const chatForm = requiredElement<HTMLFormElement>("#arena-chat-form");
  const chatInput = requiredElement<HTMLInputElement>("#arena-chat-input");
  const seenChatMessageIds = new Set<string>();
  requiredElement<HTMLButtonElement>("#leave-game").addEventListener("click", () => void leaveFreeArena());
  chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const parsed = validateChatMessage({ text: chatInput.value });
    if (!parsed.success) {
      chatStatus.textContent = describeChatRejection(parsed.code);
      return;
    }
    if (!freeGameController) {
      chatStatus.textContent = "Wait for the arena connection before sending.";
      return;
    }
    freeGameController.sendChat(parsed.data.text);
    chatInput.value = "";
    chatStatus.textContent = "Sending…";
  });

  try {
    const { startFreeGame } = await import("./game/playFree.js");
    freeGameController = await startFreeGame({
      canvasHost: requiredElement("#game-canvas"),
      onConnectionStatus(message) {
        connection.textContent = message;
        chatStatus.textContent = message.startsWith("Connected") ? "Connected to this arena." : "Chat connects with the arena.";
      },
      getProfileTicket: profile && platformApi
        ? async () => (await platformApi.getGameIdentityTicket()).ticket
        : undefined,
      onChatMessage(message) {
        if (seenChatMessageIds.has(message.id)) {
          return;
        }
        seenChatMessageIds.add(message.id);
        renderArenaChatMessage(chatMessages, message);
        chatStatus.textContent = "Connected to this arena.";
      },
      onChatRejected(code) {
        chatStatus.textContent = describeChatRejection(code);
      },
      onUiState(state) {
        status.textContent = phaseLabel(state.phase, state.humanPlayerCount, state.botPlayerCount);
        participants.textContent = formatParticipantSummary(state.humanPlayerCount, state.botPlayerCount);
        timer.textContent = phaseTimerLabel(state.phase, state.remainingMs);
        roundTimer.textContent = state.phase === "ACTIVE" ? formatClock(state.remainingMs) : "--:--";
        mass.textContent = String(Math.floor(state.localPlayer?.mass ?? 0));
        rank.textContent = state.localPlayer?.rank ? "#" + state.localPlayer.rank : "—";
        alive.textContent = String(state.players.filter((player) => player.alive).length);
        foodEaten.textContent = String(state.localPlayer?.foodCollected ?? 0);
        if (state.phase === "ACTIVE" && state.localPlayer?.inRound === false) {
          death.textContent = "Waiting for the next round…";
          death.hidden = false;
        } else {
          death.textContent = "You were eaten — respawning…";
          death.hidden = state.phase !== "ACTIVE" || state.localPlayer?.alive !== false;
        }
        renderLeaderboard(leaderboard, state.leaderboard, state.localPlayer?.id);
        renderRoundResults(results, podium, personalResult, nextRound, state.result, state.localPlayer?.id, state.phase);
      }
    });
  } catch (error) {
    const failure = describeGameConnectionFailure(error);
    connection.textContent = failure.connection;
    status.textContent = failure.detail;
    timer.textContent = failure.nextStep;
    addRetryButton();
    setPlayButtonsDisabled(false);
  } finally {
    openingFreeArena = false;
  }
}

async function leaveFreeArena(): Promise<void> {
  await freeGameController?.leave();
  window.location.reload();
}

function renderLeaderboard(container: HTMLElement, players: Array<{ playerId: string; name: string; isBot: boolean; mass: number; kills: number; rank: number }>, localPlayerId: string | undefined): void {
  container.replaceChildren();
  for (const player of players) {
    const item = document.createElement("li");
    item.classList.toggle("is-local-player", player.playerId === localPlayerId);
    const name = document.createElement("span");
    name.textContent = player.rank + ". " + (player.playerId === localPlayerId
      ? "YOU"
      : player.isBot ? "BOT · " + player.name : player.name);
    const score = document.createElement("strong");
    score.textContent = Math.floor(player.mass) + " mass · " + player.kills + " K";
    item.append(name, score);
    container.append(item);
  }
  if (players.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "Waiting for active players…";
    container.append(empty);
  }
}

function renderArenaChatMessage(container: HTMLOListElement, message: { name: string; text: string }): void {
  const item = document.createElement("li");
  const name = document.createElement("strong");
  name.textContent = message.name;
  const text = document.createElement("span");
  text.textContent = message.text;
  item.append(name, text);
  container.append(item);
  while (container.childElementCount > 80) {
    container.firstElementChild?.remove();
  }
  container.scrollTop = container.scrollHeight;
}

function describeChatRejection(code: string): string {
  if (code === "CHAT_LINKS_NOT_ALLOWED") {
    return "Links are not allowed in arena chat.";
  }
  if (code === "CHAT_CONTACT_DETAILS_NOT_ALLOWED") {
    return "Contact details and wallet addresses are not allowed in arena chat.";
  }
  if (code === "CHAT_SCAM_CONTENT_NOT_ALLOWED") {
    return "That message contains wording blocked for player safety.";
  }
  if (code === "CHAT_RATE_LIMITED") {
    return "Slow down — chat has a short anti-spam limit.";
  }
  if (code === "CHAT_DUPLICATE") {
    return "That message was already sent.";
  }
  if (code === "CHAT_AUDIT_UNAVAILABLE") {
    return "Chat is temporarily unavailable. The arena is still live.";
  }
  return "That message could not be sent.";
}

function renderRoundResults(
  container: HTMLElement,
  podium: HTMLOListElement,
  personalResult: HTMLElement,
  nextRound: HTMLElement,
  result: {
    matchId: string;
    roundId: string;
    rankings: Array<{
      playerId: string;
      name: string;
      isBot: boolean;
      rank: number;
      finalMass: number;
      foodCollected: number;
      eliminations: number;
      survivalTimeMs: number;
    }>;
  } | undefined,
  localPlayerId: string | undefined,
  phase: string,
): void {
  const visible = Boolean(result) && (phase === "FINISHED" || phase === "RESULTS");
  container.hidden = !visible;
  if (!visible || !result) {
    return;
  }
  podium.replaceChildren();
  for (const entry of result.rankings.slice(0, 3)) {
    const item = document.createElement("li");
    const place = document.createElement("strong");
    place.textContent = placeLabel(entry.rank);
    const name = document.createElement("span");
    name.textContent = entry.playerId === localPlayerId
      ? "YOU"
      : entry.isBot ? "BOT · " + entry.name : entry.name;
    const mass = document.createElement("small");
    mass.textContent = Math.floor(entry.finalMass) + " mass";
    item.append(place, name, mass);
    podium.append(item);
  }
  const mine = result.rankings.find((entry) => entry.playerId === localPlayerId);
  personalResult.textContent = mine
    ? "YOUR RESULT: #" + mine.rank + " · " + Math.floor(mine.finalMass) + " MASS · " + mine.foodCollected + " FOOD · " + mine.eliminations + " ELIMS"
    : "Round result locked by the authoritative server.";
  nextRound.textContent = phase === "RESULTS" ? "NEXT MATCHMAKING STARTS SOON" : "LOCKING FINAL RESULT…";
}

function placeLabel(rank: number): string {
  if (rank === 1) {
    return "WINNER";
  }
  if (rank === 2) {
    return "2ND PLACE";
  }
  if (rank === 3) {
    return "3RD PLACE";
  }
  return "#" + rank;
}

function addRetryButton(): void {
  const panel = requiredElement(".game-panel");
  const retry = document.createElement("button");
  retry.className = "retry-game";
  retry.type = "button";
  retry.textContent = "Retry connection";
  retry.addEventListener("click", () => void openFreeArena());
  panel.append(retry);
}

function setPlayButtonsDisabled(disabled: boolean): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-play-free]")) {
    button.disabled = disabled;
  }
}

function describeGameConnectionFailure(error: unknown): { connection: string; detail: string; nextStep: string } {
  const message = error instanceof Error ? error.message : "";
  if (message === "The game server is not configured for this deployment.") {
    return {
      connection: "Game server not configured",
      detail: "This deployment does not have a game-server URL yet.",
      nextStep: "Set VITE_GAME_SERVER_URL, redeploy, then retry."
    };
  }
  if (message === "The game server health check failed.") {
    return {
      connection: "Game server unavailable",
      detail: "The authoritative arena did not pass its health check.",
      nextStep: "Please retry in a moment."
    };
  }
  if (message === "Connection timed out after 8 seconds.") {
    return {
      connection: "Connection timed out",
      detail: "The authoritative arena did not respond in time.",
      nextStep: "Please retry in a moment."
    };
  }
  return {
    connection: "Could not connect",
    detail: "The secure connection to the authoritative arena could not be completed.",
    nextStep: "Please retry in a moment."
  };
}

function phaseLabel(phase: string, humanPlayerCount: number, botPlayerCount: number): string {
  if (phase === "WAITING") {
    return "Arena waiting for players";
  }
  if (phase === "MATCHMAKING") {
    const humans = humanPlayerCount + " " + (humanPlayerCount === 1 ? "player" : "players");
    const bots = botPlayerCount > 0
      ? " · " + botPlayerCount + " arena " + (botPlayerCount === 1 ? "bot" : "bots")
      : "";
    return "Finding players — " + humans + bots;
  }
  if (phase === "COUNTDOWN") {
    return "Round starting — movement is frozen";
  }
  if (phase === "ACTIVE") {
    return "Live round — server-authoritative";
  }
  if (phase === "FINISHED") {
    return "Round complete — locking results";
  }
  if (phase === "RESULTS") {
    return "Results live — next matchmaking follows";
  }
  return "Synchronizing arena state";
}

function formatParticipantSummary(humanPlayerCount: number, botPlayerCount: number): string {
  const humans = humanPlayerCount + " live " + (humanPlayerCount === 1 ? "player" : "players");
  if (botPlayerCount === 0) {
    return humans;
  }
  return humans + " · " + botPlayerCount + " disclosed Arena " + (botPlayerCount === 1 ? "Bot" : "Bots");
}

function phaseTimerLabel(phase: string, remainingMs: number): string {
  if (phase === "MATCHMAKING") {
    return "MATCHMAKING " + formatClock(remainingMs);
  }
  if (phase === "COUNTDOWN") {
    return "ROUND STARTS IN " + Math.max(1, Math.ceil(remainingMs / 1_000));
  }
  if (phase === "ACTIVE") {
    return "TIME REMAINING " + formatClock(remainingMs);
  }
  if (phase === "RESULTS") {
    return "NEXT ROUND " + formatClock(remainingMs);
  }
  return "";
}

function formatClock(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return minutes + ":" + seconds;
}

function requiredElement<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required BLOB UI element: ${selector}`);
  }
  return element;
}

function requiredElementOrUndefined<T extends HTMLElement = HTMLElement>(selector: string): T | undefined {
  return document.querySelector<T>(selector) ?? undefined;
}
