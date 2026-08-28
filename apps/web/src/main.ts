import "./styles.css";
import "./arenaBots.css";
import { validateChatMessage } from "@blob/validation";
import { ACCESS_GATE_ENABLED, hasPrivateBuildAccess, unlockPrivateBuild } from "./accessGate.js";
import { setProfileGameName } from "./identity.js";
import { type BlobProfile, type ReferralDashboard, PlatformApiError, resolvePlatformApi } from "./platformApi.js";
import { hasUsdcModePreviewAccess, unlockUsdcModePreview } from "./usdcMode.js";
import { type AvailableWallet, connectWalletAndCreateProfile, isMobileBrowser, openInPhantomMobileBrowser, watchAvailableSolanaWallets } from "./wallet.js";
import { startLiveMetrics, type LiveMetricsController, type LiveMetricsSnapshot } from "./liveMetrics.js";
import type { TouchJoystickHand } from "./game/arenaPresentation.js";

const appRoot = document.querySelector<HTMLDivElement>("#app");

if (!appRoot) {
  throw new Error("BLOB app root was not found.");
}
const app: HTMLDivElement = appRoot;
const BLOB_TOKEN_ADDRESS = "6htcaSYtVdDaGtRGn2jPnxc1q2hsAyYCECxteodipump";
const BLOB_TOKEN_PUMP_URL = `https://pump.fun/coin/${BLOB_TOKEN_ADDRESS}`;
const REFERRAL_CANDIDATE_STORAGE_KEY = "blob.referral-candidate";
const FREE_ARENA_LANDING = `
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
`;

let freeGameController: {
  leave(): Promise<void>;
  sendChat(text: string): void;
  setTouchHand(hand: TouchJoystickHand): void;
  getTouchHand(): TouchJoystickHand;
  setTouchIntent(input: { x: number; y: number }): void;
  clearTouchIntent(): void;
} | undefined;
let openingFreeArena = false;
const platformApi = resolvePlatformApi();
let profile: BlobProfile | null = null;
let referralDashboard: ReferralDashboard | undefined;
let referralNotice: string | undefined;
let availableWallets: AvailableWallet[] = [];
let liveMetricsController: LiveMetricsController | undefined;

initializeApplication();

function initializeApplication(): void {
  if (ACCESS_GATE_ENABLED && !hasPrivateBuildAccess()) {
    renderAccessGate();
    return;
  }
  renderSite();
  captureReferralCandidateFromLocation();
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
      captureReferralCandidateFromLocation();
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
        <a class="nav-buy-button" href="${BLOB_TOKEN_PUMP_URL}" target="_blank" rel="noreferrer noopener">Buy $BLOB <span aria-hidden="true">↗</span></a>
        <button class="wallet-button" data-wallet-trigger type="button">Connect wallet</button>
      </div>
    </nav>

    <section class="hero" id="top" aria-labelledby="hero-title">
      <div class="hero-copy">
        <p class="eyebrow">Independent skill game</p>
        <h1 id="hero-title">EAT.<br />GROW.<br /><em>SURVIVE.</em></h1>
        <p class="intro">A multiplayer arena where instinct, movement, and timing decide who gets bigger.</p>
        <div class="hero-actions">
          <button class="play-button" type="button" data-play-free>Play Free <span>→</span></button>
          <a class="token-button token-button-hero" href="${BLOB_TOKEN_PUMP_URL}" target="_blank" rel="noreferrer noopener">Buy $BLOB <span aria-hidden="true">↗</span></a>
          <button class="wallet-button hero-wallet-button" data-wallet-trigger type="button">Connect wallet</button>
          <span>Free Mode · wallet optional</span>
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
      <div class="arena-mode-tabs" role="tablist" aria-label="Arena mode">
        <button class="arena-mode-tab is-active" id="free-mode-tab" type="button" role="tab" aria-selected="true" aria-controls="arena-shell" data-arena-mode="free">Free Mode</button>
        <button class="arena-mode-tab" id="usdc-mode-tab" type="button" role="tab" aria-selected="false" aria-controls="arena-shell" data-arena-mode="usdc">USDC Mode <span aria-hidden="true">🔒</span></button>
      </div>
      <div class="arena-shell" id="arena-shell" role="status" aria-live="polite"></div>
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

    <section class="token-section" id="token" aria-labelledby="token-title">
      <div class="token-copy">
        <p class="eyebrow">BLOB.LAT token</p>
        <h2 id="token-title">The blob has<br /><em>a ticker.</em></h2>
        <p>$BLOB is the BLOB.LAT community token on Solana. Free Mode stays free: holding it does not change gameplay, matchmaking, or competitive outcomes.</p>
      </div>
      <div class="token-details">
        <p class="token-label">Solana contract</p>
        <code id="blob-token-address">${BLOB_TOKEN_ADDRESS}</code>
        <div class="token-actions">
          <button class="contract-copy-button" id="copy-token-contract" type="button">Copy address</button>
          <a class="token-button" href="${BLOB_TOKEN_PUMP_URL}" target="_blank" rel="noreferrer noopener">View on Pump.fun <span aria-hidden="true">↗</span></a>
        </div>
        <p class="token-note">Third-party trading link. Memecoins are volatile — verify the contract address before trading.</p>
      </div>
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
        <a href="/terms.html">Terms &amp; Risk</a>
        <span>Community channels soon</span>
      </div>
    </footer>
    <dialog class="profile-dialog" id="profile-dialog" aria-labelledby="profile-dialog-title">
      <button class="dialog-close" id="profile-dialog-close" type="button" aria-label="Close profile">×</button>
      <div id="profile-dialog-content"></div>
    </dialog>
    <dialog class="profile-dialog usdc-access-dialog" id="usdc-access-dialog" aria-labelledby="usdc-access-title">
      <button class="dialog-close" id="usdc-access-close" type="button" aria-label="Close USDC Mode">×</button>
      <div id="usdc-access-content"></div>
    </dialog>
  </main>
`;

  renderFreeArenaLanding();
  bindFreePlayButtons();
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-wallet-trigger]")) {
    button.addEventListener("click", () => openProfileDialog());
  }
  requiredElement<HTMLButtonElement>("#free-mode-tab").addEventListener("click", () => void openFreeArena());
  requiredElement<HTMLButtonElement>("#usdc-mode-tab").addEventListener("click", () => void openUsdcMode());
  requiredElement<HTMLButtonElement>("#profile-dialog-close").addEventListener("click", () => closeProfileDialog());
  requiredElement<HTMLButtonElement>("#usdc-access-close").addEventListener("click", () => closeUsdcAccessDialog());
  requiredElement<HTMLButtonElement>("#copy-token-contract").addEventListener("click", () => void copyTokenAddress());
  liveMetricsController = startLiveMetrics(renderLiveMetrics);
}

function bindFreePlayButtons(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-play-free]")) {
    if (button.dataset.freePlayBound === "true") {
      continue;
    }
    button.dataset.freePlayBound = "true";
    button.addEventListener("click", () => void openFreeArena());
  }
}

function renderFreeArenaLanding(): void {
  const arenaShell = requiredElement<HTMLElement>("#arena-shell");
  arenaShell.className = "arena-shell";
  arenaShell.setAttribute("role", "status");
  arenaShell.setAttribute("aria-live", "polite");
  arenaShell.innerHTML = FREE_ARENA_LANDING;
  document.querySelector<HTMLElement>("#arena-chat")?.remove();
  bindFreePlayButtons();
  setArenaModeTabs("free");
}

async function openUsdcMode(): Promise<void> {
  if (!hasUsdcModePreviewAccess()) {
    openUsdcAccessDialog();
    return;
  }
  if (freeGameController) {
    await leaveFreeArena();
  }

  const arenaShell = requiredElement<HTMLElement>("#arena-shell");
  arenaShell.className = "arena-shell usdc-mode-shell";
  arenaShell.setAttribute("role", "region");
  arenaShell.setAttribute("aria-live", "polite");
  arenaShell.setAttribute("aria-label", "USDC Mode private preview");
  arenaShell.innerHTML = `
    <section class="usdc-mode-preview" aria-labelledby="usdc-mode-title">
      <div class="usdc-mode-heading">
        <div>
          <p class="eyebrow">USDC MODE · PRIVATE PREVIEW</p>
          <h3 id="usdc-mode-title">COMPETE.<br /><em>WHEN READY.</em></h3>
        </div>
        <span class="usdc-mode-locked">ENTRIES DISABLED</span>
      </div>
      <p class="usdc-mode-copy">USDC Mode will use the same server-authoritative arena as Free Mode. These are the intended disclosed rules; this private preview has no entry form, pool, transfer, or payout request.</p>
      <div class="usdc-mode-grid">
        <section class="usdc-wallet-card" aria-labelledby="usdc-wallet-title">
          <p class="token-label" id="usdc-wallet-title">Wallet profile</p>
          <strong id="usdc-profile-state">Checking profile…</strong>
          <p id="usdc-profile-copy">Connect a Solana wallet to reserve your BLOB identity. A login signature is never a USDC transfer.</p>
          <button class="play-button" id="usdc-wallet-action" type="button">Connect wallet <span>→</span></button>
        </section>
        <section class="usdc-rules-card" aria-labelledby="usdc-rules-title">
          <p class="token-label" id="usdc-rules-title">Locked competitive rules</p>
          <dl>
            <div><dt>Asset</dt><dd>Native USDC · Solana</dd></div>
            <div><dt>Players</dt><dd>Minimum 6 confirmed</dd></div>
            <div><dt>Round</dt><dd>10 minutes · authoritative</dd></div>
            <div><dt>Fee</dt><dd>10% of all contributions</dd></div>
            <div><dt>Podium</dt><dd>Top 3 · 55% / 30% / 15%</dd></div>
            <div><dt>Rebate</dt><dd>Ranks 4+ · 10% of entry</dd></div>
            <div><dt>Revive</dt><dd>0.50 USDC · unavailable at 03:00</dd></div>
          </dl>
        </section>
      </div>
      <div class="usdc-mode-footer">
        <div class="usdc-mode-disclosure">
          <aside class="usdc-safety-card" aria-labelledby="usdc-safety-title">
            <p class="token-label" id="usdc-safety-title">Wallet safety checklist</p>
            <ul>
              <li>Use a separate wallet and keep only the amount you are prepared to lose.</li>
              <li>Verify <strong>blob.lat</strong>, the wallet request, network, recipient and amount before signing.</li>
              <li>Never share a seed phrase or private key. BLOB login signs a message; it is never a USDC transfer.</li>
            </ul>
          </aside>
          <label class="usdc-risk-ack"><input id="usdc-risk-ack" type="checkbox" /> <span>I understand that crypto assets can lose all value, participation is voluntary, I should use a separate wallet, and I must review the <a href="/terms.html" target="_blank" rel="noreferrer">BLOB Terms &amp; Risk Disclosure</a>.</span></label>
          <p id="usdc-risk-ack-status"><strong>NOT OPEN FOR PAYMENT.</strong> This preview acknowledgement is not an entry acceptance. Any future paid action must request its own dated acceptance.</p>
        </div>
        <button class="leave-game" id="return-to-free-mode" type="button">Return to Free Mode</button>
      </div>
    </section>
  `;
  requiredElement<HTMLButtonElement>("#usdc-wallet-action").addEventListener("click", () => openProfileDialog());
  requiredElement<HTMLButtonElement>("#return-to-free-mode").addEventListener("click", () => renderFreeArenaLanding());
  requiredElement<HTMLInputElement>("#usdc-risk-ack").addEventListener("change", (event) => {
    const checked = (event.currentTarget as HTMLInputElement).checked;
    requiredElement<HTMLElement>("#usdc-risk-ack-status").textContent = checked
      ? "Preview acknowledgement recorded only in this browser. No payment, entry, or transfer has been authorized."
      : "NOT OPEN FOR PAYMENT. This preview acknowledgement is not an entry acceptance. Any future paid action must request its own dated acceptance.";
  });
  renderUsdcProfileState();
  setArenaModeTabs("usdc");
}

function setArenaModeTabs(mode: "free" | "usdc"): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-arena-mode]")) {
    const selected = button.dataset.arenaMode === mode;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-selected", String(selected));
  }
}

function openUsdcAccessDialog(): void {
  const dialog = requiredElement<HTMLDialogElement>("#usdc-access-dialog");
  const container = requiredElement<HTMLElement>("#usdc-access-content");
  container.innerHTML = `
    <p class="eyebrow">USDC MODE</p>
    <h2 id="usdc-access-title">PRIVATE<br />PREVIEW.</h2>
    <p class="profile-copy">This temporary code only limits access to an unfinished interface. It is not wallet authentication and it never authorizes a transaction.</p>
    <form class="profile-form" id="usdc-access-form">
      <label for="usdc-access-code">Access code</label>
      <input id="usdc-access-code" name="usdc-access-code" type="password" inputmode="numeric" autocomplete="off" required aria-describedby="usdc-access-error" />
      <p class="profile-notice" id="usdc-access-error" role="alert" hidden>That access code is not correct.</p>
      <button class="play-button" type="submit">Open preview <span>→</span></button>
    </form>
  `;
  const form = requiredElement<HTMLFormElement>("#usdc-access-form");
  const input = requiredElement<HTMLInputElement>("#usdc-access-code");
  const error = requiredElement<HTMLElement>("#usdc-access-error");
  input.addEventListener("input", () => {
    input.removeAttribute("aria-invalid");
    error.hidden = true;
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!unlockUsdcModePreview(input.value)) {
      input.setAttribute("aria-invalid", "true");
      error.hidden = false;
      input.focus();
      input.select();
      return;
    }
    dialog.close();
    void openUsdcMode();
  });
  if (!dialog.open) {
    dialog.showModal();
  }
  input.focus();
}

function closeUsdcAccessDialog(): void {
  requiredElement<HTMLDialogElement>("#usdc-access-dialog").close();
}

function renderUsdcProfileState(): void {
  const state = requiredElementOrUndefined<HTMLElement>("#usdc-profile-state");
  const copy = requiredElementOrUndefined<HTMLElement>("#usdc-profile-copy");
  const action = requiredElementOrUndefined<HTMLButtonElement>("#usdc-wallet-action");
  if (!state || !copy || !action) {
    return;
  }
  if (profile) {
    state.textContent = profile.displayName + " · " + shortenWalletAddress(profile.walletAddress);
    copy.textContent = "Your BLOB profile is connected. Paid entry is still disabled, so this screen cannot request USDC.";
    action.textContent = "Manage profile";
    return;
  }
  state.textContent = platformApi ? "Wallet not connected" : "Profile service unavailable";
  copy.textContent = platformApi
    ? "Connect a Solana wallet to reserve your BLOB identity. A login signature is never a USDC transfer."
    : "The wallet profile service is unavailable for this deployment. No payment capability is enabled.";
  action.textContent = "Connect wallet";
  action.disabled = !platformApi;
}

async function copyTokenAddress(): Promise<void> {
  const button = requiredElement<HTMLButtonElement>("#copy-token-contract");
  const originalLabel = button.textContent;

  try {
    await navigator.clipboard.writeText(BLOB_TOKEN_ADDRESS);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Copy unavailable";
  }

  window.setTimeout(() => {
    button.textContent = originalLabel;
  }, 2_000);
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
    if (profile) {
      await refreshReferralExperience();
    }
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
  for (const trigger of document.querySelectorAll<HTMLButtonElement>("[data-wallet-trigger]")) {
    trigger.textContent = profile ? profile.displayName : "Connect wallet";
    trigger.classList.toggle("is-connected", Boolean(profile));
  }
  renderUsdcProfileState();
}

function renderProfileDialog(message?: string, offerArenaRejoin = false): void {
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
    if (offerArenaRejoin && freeGameController) {
      const rejoin = document.createElement("button");
      rejoin.type = "button";
      rejoin.className = "profile-rejoin";
      rejoin.textContent = "Apply name to this arena";
      rejoin.addEventListener("click", () => void rejoinFreeArenaForProfile());
      container.append(rejoin);
    }
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
    empty.textContent = isMobileBrowser()
      ? "No wallet is available in this browser. Open BLOB in Phantom to connect your existing Solana wallet safely."
      : "No compatible Solana wallet was detected. Install or unlock a Wallet Standard-compatible wallet, then reopen this panel.";
    container.append(empty);
    if (isMobileBrowser()) {
      const openPhantom = document.createElement("button");
      openPhantom.type = "button";
      openPhantom.className = "wallet-option";
      openPhantom.textContent = "OPEN BLOB IN PHANTOM";
      openPhantom.addEventListener("click", () => openInPhantomMobileBrowser(window.location));
      container.append(openPhantom);
    }
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
  container.append(wallet, copy, form);
  renderReferralProgram(container);
  container.append(signOut);
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
    await refreshReferralExperience();
    renderProfileTrigger();
    renderProfileDialog(referralNotice ?? "Wallet verified. Your BLOB profile is ready.");
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
    renderProfileDialog(freeGameController
      ? "Display name saved. Rejoin once to apply the server-signed name across the arena, ranking, and chat."
      : "Display name saved. It will be used when you join an arena.", Boolean(freeGameController));
  } catch (error) {
    renderProfileDialog(describeProfileError(error));
  }
}

async function rejoinFreeArenaForProfile(): Promise<void> {
  if (!freeGameController) {
    return;
  }
  closeProfileDialog();
  await leaveFreeArena();
  await openFreeArena();
}

async function logoutProfile(button: HTMLButtonElement): Promise<void> {
  if (!platformApi) {
    return;
  }
  button.disabled = true;
  try {
    await platformApi.logout();
    profile = null;
    referralDashboard = undefined;
    referralNotice = undefined;
    setProfileGameName(undefined);
    renderProfileTrigger();
    renderProfileDialog("You are signed out of BLOB. Your wallet itself remains connected in its extension.");
  } catch (error) {
    renderProfileDialog(describeProfileError(error));
  }
}

function captureReferralCandidateFromLocation(): void {
  const url = new URL(window.location.href);
  const rawCode = url.searchParams.get("ref");
  if (!rawCode) {
    return;
  }
  const code = rawCode.trim().toUpperCase();
  if (/^[A-Z0-9_-]{1,32}$/.test(code)) {
    window.sessionStorage.setItem(REFERRAL_CANDIDATE_STORAGE_KEY, code);
  }
  url.searchParams.delete("ref");
  window.history.replaceState(window.history.state, "", url);
}

async function refreshReferralExperience(): Promise<void> {
  if (!platformApi || !profile) {
    referralDashboard = undefined;
    return;
  }
  const candidate = window.sessionStorage.getItem(REFERRAL_CANDIDATE_STORAGE_KEY);
  if (candidate) {
    try {
      const outcome = await platformApi.captureReferralAttribution(candidate);
      window.sessionStorage.removeItem(REFERRAL_CANDIDATE_STORAGE_KEY);
      referralNotice = outcome === "CAPTURED"
        ? "Referral saved. Points unlock only after an eligible server-confirmed Free Mode round."
        : "Your referral is already linked and cannot be changed.";
    } catch (error) {
      if (error instanceof PlatformApiError && (error.code === "REFERRAL_CODE_INVALID" || error.code === "REFERRAL_SELF_NOT_ALLOWED" || error.code === "REFERRAL_ATTRIBUTION_WINDOW_CLOSED")) {
        window.sessionStorage.removeItem(REFERRAL_CANDIDATE_STORAGE_KEY);
        referralNotice = error.code === "REFERRAL_SELF_NOT_ALLOWED"
          ? "You cannot use your own referral link."
          : error.code === "REFERRAL_ATTRIBUTION_WINDOW_CLOSED"
            ? "Referral links can only be attached to a new BLOB profile."
            : "That referral link is not valid.";
      } else {
        console.warn("[BLOB] referral attribution could not be completed", error);
      }
    }
  }
  try {
    referralDashboard = await platformApi.getReferralDashboard();
  } catch (error) {
    console.warn("[BLOB] referral dashboard could not be loaded", error);
  }
}

function renderReferralProgram(container: HTMLElement): void {
  const card = document.createElement("section");
  card.className = "referral-card";
  const label = document.createElement("p");
  label.className = "token-label";
  label.textContent = "BLOB referral program";
  const copy = document.createElement("p");
  copy.className = "profile-copy";
  if (!referralDashboard) {
    copy.textContent = "Preparing your private referral link…";
    card.append(label, copy);
    container.append(card);
    return;
  }
  const dashboard = referralDashboard;
  const rules = dashboard.qualificationRules;
  copy.textContent = `Invite a new player. Their link must be attached within ${formatReferralWindow(rules.attributionWindowHours)} of creating a BLOB profile; points count after a server-confirmed Free Mode round with ${rules.minFoodCollected} food eaten and ${formatReferralDuration(rules.minSurvivalSeconds)} alive.`;
  const link = document.createElement("code");
  link.textContent = dashboard.inviteUrl;
  const stats = document.createElement("dl");
  stats.className = "referral-stats";
  const referralStats: ReadonlyArray<readonly [string, string]> = [
    ["BLOB Points", dashboard.totalPoints],
    ["Invited", String(dashboard.invitedCount)],
    ["Active", String(dashboard.qualifiedCount)],
  ];
  for (const [term, value] of referralStats) {
    const row = document.createElement("div");
    const title = document.createElement("dt");
    title.textContent = term;
    const detail = document.createElement("dd");
    detail.textContent = value;
    row.append(title, detail);
    stats.append(row);
  }
  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "referral-copy";
  copyButton.textContent = "Copy invite link";
  copyButton.addEventListener("click", () => void copyReferralLink(copyButton, dashboard.inviteUrl));
  const note = document.createElement("small");
  note.textContent = `One referral link per profile. Self-referrals, repeat claims, browser-only activity, and duplicate rewards are blocked; up to ${rules.maxQualificationsPerReferrerPerDay} qualified referrals per referrer count each UTC day. Points are not a token, cash balance, or promise of future value.`;
  card.append(label, copy, link, stats, copyButton, note);
  container.append(card);
}

function formatReferralDuration(seconds: number): string {
  if (seconds % 60 === 0) {
    return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
  }
  return `${seconds} seconds`;
}

function formatReferralWindow(hours: number): string {
  if (hours >= 24 && hours % 24 === 0) {
    const days = hours / 24;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  return `${hours} hours`;
}

async function copyReferralLink(button: HTMLButtonElement, inviteUrl: string | undefined): Promise<void> {
  if (!inviteUrl) {
    return;
  }
  const previous = button.textContent;
  try {
    await navigator.clipboard.writeText(inviteUrl);
    button.textContent = "Invite link copied";
  } catch {
    button.textContent = "Copy unavailable";
  }
  window.setTimeout(() => {
    button.textContent = previous;
  }, 2_000);
}

function describeProfileError(error: unknown): string {
  if (error instanceof PlatformApiError) {
    if (error.code === "PROFILE_RENAME_RATE_LIMITED") {
      return "Display names can be changed once every 24 hours.";
    }
    if (error.code === "PROFILE_NAME_UNAVAILABLE") {
      return "That display name is already in use. Please choose another.";
    }
    if (error.code === "DISPLAY_NAME_RESERVED") {
      return "That display name is reserved. Please choose another.";
    }
    if (error.code === "DISPLAY_NAME_INVALID") {
      return "Use 3–16 letters, numbers, spaces, underscores, or hyphens.";
    }
    if (error.code === "AUTH_REQUIRED") {
      return "Your BLOB sign-in session expired. Connect your wallet again.";
    }
    if (error.code === "ORIGIN_NOT_ALLOWED") {
      return "This deployment cannot reach the profile service yet.";
    }
    if (error.code === "PROFILE_NAME_CHANGE_REQUIRED") {
      return "Choose a compliant display name before entering the arena.";
    }
    if (error.code === "GAME_IDENTITY_UNAVAILABLE") {
      return "Profile names are temporarily unavailable. Please try again shortly.";
    }
    if (error.code === "REQUEST_INVALID") {
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
  setArenaModeTabs("free");
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
        <button class="share-result" id="share-round-result" type="button" hidden>Share result</button>
        <p class="next-round" id="next-round"></p>
      </section>
    </div>
    <section class="mobile-joystick-dock" id="mobile-joystick-dock" aria-label="Mobile movement control">
      <button class="game-joystick-hand" id="game-joystick-hand" type="button" aria-pressed="false">
        <span aria-hidden="true">⇄</span><span>MOVE JOYSTICK LEFT</span>
      </button>
      <div class="mobile-joystick" id="mobile-joystick" role="application" aria-label="Touch and drag to steer your BLOB">
        <span class="mobile-joystick-knob" id="mobile-joystick-knob" aria-hidden="true"></span>
      </div>
    </section>
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
  const shareRoundResult = requiredElement<HTMLButtonElement>("#share-round-result");
  const chatMessages = requiredElement<HTMLOListElement>("#arena-chat-messages");
  const chatStatus = requiredElement("#arena-chat-status");
  const chatForm = requiredElement<HTMLFormElement>("#arena-chat-form");
  const chatInput = requiredElement<HTMLInputElement>("#arena-chat-input");
  const joystickHandButton = requiredElement<HTMLButtonElement>("#game-joystick-hand");
  const joystickDock = requiredElement<HTMLElement>("#mobile-joystick-dock");
  const joystick = requiredElement<HTMLElement>("#mobile-joystick");
  const joystickKnob = requiredElement<HTMLElement>("#mobile-joystick-knob");
  let touchHand = getPreferredTouchHand();
  const externalJoystick = bindExternalTouchJoystick(joystick, joystickKnob, () => freeGameController);
  renderTouchHandButton(joystickHandButton, joystickDock, touchHand);
  joystickHandButton.addEventListener("click", () => {
    touchHand = touchHand === "right" ? "left" : "right";
    savePreferredTouchHand(touchHand);
    externalJoystick.reset();
    freeGameController?.setTouchHand(touchHand);
    renderTouchHandButton(joystickHandButton, joystickDock, touchHand);
  });
  const seenChatMessageIds = new Set<string>();
  shareRoundResult.addEventListener("click", () => void shareRoundResultText(shareRoundResult));
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
    // A session restore can finish after the landing page renders. Resolve it
    // immediately before the authoritative room join so chat and arena names
    // always use the same server-signed profile identity.
    const profileForArena = await resolveProfileForArena();
    freeGameController = await startFreeGame({
      canvasHost: requiredElement("#game-canvas"),
      initialTouchHand: touchHand,
      onConnectionStatus(message) {
        connection.textContent = message;
        chatStatus.textContent = message.startsWith("Connected") ? "Connected to this arena." : "Chat connects with the arena.";
      },
      getProfileTicket: profileForArena && platformApi
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
        renderRoundResults(results, podium, personalResult, shareRoundResult, nextRound, state.result, state.localPlayer?.id, state.phase);
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

async function resolveProfileForArena(): Promise<BlobProfile | null> {
  if (!platformApi) {
    return null;
  }
  try {
    profile = await platformApi.getCurrentProfile();
    setProfileGameName(profile?.displayName);
    renderProfileTrigger();
  } catch (error) {
    console.warn("[BLOB] profile identity could not be refreshed before arena join", error);
  }
  return profile;
}

const TOUCH_HAND_STORAGE_KEY = "blob:touch-joystick-hand";

function getPreferredTouchHand(): TouchJoystickHand {
  try {
    return window.localStorage.getItem(TOUCH_HAND_STORAGE_KEY) === "left" ? "left" : "right";
  } catch {
    return "right";
  }
}

function savePreferredTouchHand(hand: TouchJoystickHand): void {
  try {
    window.localStorage.setItem(TOUCH_HAND_STORAGE_KEY, hand);
  } catch {
    // A blocked browser storage API must not prevent touch controls from working.
  }
}

function renderTouchHandButton(button: HTMLButtonElement, dock: HTMLElement, hand: TouchJoystickHand): void {
  const movesToLeft = hand === "right";
  button.setAttribute("aria-pressed", String(!movesToLeft));
  button.setAttribute("aria-label", movesToLeft ? "Move joystick to the left hand" : "Move joystick to the right hand");
  button.lastElementChild!.textContent = movesToLeft ? "MOVE JOYSTICK LEFT" : "MOVE JOYSTICK RIGHT";
  dock.classList.toggle("is-left-hand", hand === "left");
}

function bindExternalTouchJoystick(
  control: HTMLElement,
  knob: HTMLElement,
  getController: () => typeof freeGameController,
): { reset(): void } {
  let pointerId: number | undefined;

  const reset = (): void => {
    pointerId = undefined;
    knob.style.transform = "translate(0, 0)";
    getController()?.clearTouchIntent();
  };

  const update = (event: PointerEvent): void => {
    const rectangle = control.getBoundingClientRect();
    const originX = rectangle.left + rectangle.width / 2;
    const originY = rectangle.top + rectangle.height / 2;
    const rawX = event.clientX - originX;
    const rawY = event.clientY - originY;
    const distance = Math.hypot(rawX, rawY);
    const maximum = Math.max(1, Math.min(rectangle.width, rectangle.height) * 0.33);
    const scale = distance > maximum ? maximum / distance : 1;
    knob.style.transform = "translate(" + Math.round(rawX * scale) + "px, " + Math.round(rawY * scale) + "px)";
    getController()?.setTouchIntent(distance > 4 ? { x: rawX / distance, y: rawY / distance } : { x: 0, y: 0 });
  };

  control.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" || pointerId !== undefined) {
      return;
    }
    pointerId = event.pointerId;
    control.setPointerCapture(event.pointerId);
    update(event);
    event.preventDefault();
  });
  control.addEventListener("pointermove", (event) => {
    if (event.pointerId === pointerId) {
      update(event);
      event.preventDefault();
    }
  });
  control.addEventListener("pointerup", (event) => {
    if (event.pointerId === pointerId) {
      reset();
    }
  });
  control.addEventListener("pointercancel", (event) => {
    if (event.pointerId === pointerId) {
      reset();
    }
  });
  control.addEventListener("lostpointercapture", () => reset());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      reset();
    }
  });
  return { reset };
}

async function leaveFreeArena(): Promise<void> {
  const controller = freeGameController;
  freeGameController = undefined;
  await controller?.leave();
  openingFreeArena = false;
  renderFreeArenaLanding();
  setPlayButtonsDisabled(false);
}

function renderLeaderboard(container: HTMLElement, players: Array<{ playerId: string; name: string; isBot: boolean; mass: number; kills: number; rank: number }>, localPlayerId: string | undefined): void {
  container.replaceChildren();
  for (const player of players) {
    const item = document.createElement("li");
    item.classList.toggle("is-local-player", player.playerId === localPlayerId);
    const name = document.createElement("span");
    name.textContent = player.rank + ". " + (player.playerId === localPlayerId
      ? "YOU · " + player.name
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

function renderArenaChatMessage(container: HTMLOListElement, message: { name: string; text: string; sentAt: number }): void {
  const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 36;
  const item = document.createElement("li");
  const name = document.createElement("strong");
  name.textContent = message.name;
  const text = document.createElement("span");
  text.textContent = message.text;
  const time = document.createElement("time");
  time.dateTime = new Date(message.sentAt).toISOString();
  time.textContent = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(message.sentAt);
  item.append(name, text, time);
  container.append(item);
  while (container.childElementCount > 80) {
    container.firstElementChild?.remove();
  }
  if (wasAtBottom) {
    container.scrollTop = container.scrollHeight;
  }
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
  shareButton: HTMLButtonElement,
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
  shareButton.hidden = true;
  shareButton.removeAttribute("data-share-text");
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
      ? "YOU · " + entry.name
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
  if (mine) {
    shareButton.hidden = false;
    shareButton.textContent = "Share result";
    shareButton.dataset.shareText = "I finished #" + mine.rank + " in the BLOB Free Mode arena — "
      + Math.floor(mine.finalMass) + " mass, " + mine.foodCollected + " food, " + mine.eliminations + " elims.\n\nEAT. GROW. SURVIVE.\nhttps://blob.lat";
  }
  nextRound.textContent = phase === "RESULTS" ? "NEXT MATCHMAKING STARTS SOON" : "LOCKING FINAL RESULT…";
}

async function shareRoundResultText(button: HTMLButtonElement): Promise<void> {
  const text = button.dataset.shareText;
  if (!text) {
    return;
  }
  const originalLabel = button.textContent;
  try {
    if (navigator.share) {
      await navigator.share({ title: "BLOB Free Mode result", text });
      button.textContent = "Shared";
    } else {
      await navigator.clipboard.writeText(text);
      button.textContent = "Copied";
    }
  } catch {
    button.textContent = "Share unavailable";
  }
  window.setTimeout(() => {
    button.textContent = originalLabel;
  }, 2_000);
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
