import "./styles.css";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("BLOB app root was not found.");
}

app.innerHTML = `
  <main>
    <nav class="site-nav" aria-label="Primary navigation">
      <a class="wordmark" href="#top" aria-label="BLOB home">BLOB<span>.</span></a>
      <div class="nav-links">
        <a href="#about">About</a>
        <a href="#future">Future</a>
        <a href="https://github.com/BLOBLAT/blob" target="_blank" rel="noreferrer">GitHub</a>
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
          <small>Connect to a live local arena. No bots. No fake stats.</small>
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

    <footer>
      <p>© ${new Date().getFullYear()} BLOB</p>
      <div>
        <a href="https://github.com/BLOBLAT/blob" target="_blank" rel="noreferrer">GitHub</a>
        <span>Community channels soon</span>
      </div>
    </footer>
  </main>
`;

let freeGameController: { leave(): Promise<void> } | undefined;

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-play-free]")) {
  button.addEventListener("click", () => void openFreeArena(button));
}

async function openFreeArena(button: HTMLButtonElement): Promise<void> {
  if (freeGameController) {
    return;
  }
  const arenaShell = document.querySelector<HTMLElement>("#arena-shell");
  if (!arenaShell) {
    throw new Error("BLOB arena container was not found.");
  }

  button.disabled = true;
  arenaShell.classList.add("is-playing");
  arenaShell.innerHTML = `
    <div class="game-canvas" id="game-canvas" aria-label="Live BLOB arena"></div>
    <aside class="game-panel" aria-label="Match information">
      <div class="game-panel-heading">
        <p class="eyebrow">Free Mode</p>
        <button class="leave-game" type="button" id="leave-game">Leave</button>
      </div>
      <p class="game-status" id="game-status">Preparing connection…</p>
      <p class="game-timer" id="game-timer"></p>
      <h3>LIVE RANKING</h3>
      <ol class="live-leaderboard" id="live-leaderboard"></ol>
    </aside>
  `;

  const status = requiredElement("#game-status");
  const timer = requiredElement("#game-timer");
  const leaderboard = requiredElement("#live-leaderboard");
  requiredElement<HTMLButtonElement>("#leave-game").addEventListener("click", () => void leaveFreeArena());

  try {
    const { startFreeGame } = await import("./game/playFree.js");
    freeGameController = await startFreeGame({
      canvasHost: requiredElement("#game-canvas"),
      onConnectionStatus(message) {
        status.textContent = message;
      },
      onUiState(state) {
        status.textContent = phaseLabel(state.phase);
        timer.textContent = state.remainingMs > 0 ? `${Math.ceil(state.remainingMs / 1_000)}s` : "";
        renderLeaderboard(leaderboard, state.players);
      }
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown connection error";
    status.textContent = `Could not join the real game server: ${detail}`;
    timer.textContent = "Start the local game server, then refresh and retry.";
    button.disabled = false;
  }
}

async function leaveFreeArena(): Promise<void> {
  await freeGameController?.leave();
  window.location.reload();
}

function renderLeaderboard(container: HTMLElement, players: Array<{ name: string; mass: number; kills: number; rank: number; alive: boolean }>): void {
  container.replaceChildren();
  for (const player of players) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = `${player.rank}. ${player.name}${player.alive ? "" : " (respawning)"}`;
    const score = document.createElement("strong");
    score.textContent = `${Math.floor(player.mass)} mass · ${player.kills} K`;
    item.append(name, score);
    container.append(item);
  }
}

function phaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    LOBBY: "Lobby — waiting for countdown",
    COUNTDOWN: "Countdown — get ready",
    PLAYING: "Live — movement is server-authoritative",
    RESULTS: "Match complete — restarting soon"
  };
  return labels[phase] ?? "Synchronizing arena state";
}

function requiredElement<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required BLOB UI element: ${selector}`);
  }
  return element;
}
