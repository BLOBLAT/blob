export interface BlobProfile {
  id: string;
  displayName: string;
  walletAddress: string;
  renamedAt: string | null;
}

interface ChallengeResponse {
  challengeId: string;
  message: string;
  expiresAt: string;
}

export interface GameIdentityTicket {
  ticket: string;
  expiresAt: string;
}

export class PlatformApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export class PlatformApiUnavailableError extends Error {
  constructor() {
    super("The profile service is not configured for this deployment.");
  }
}

export class PlatformApi {
  constructor(readonly baseUrl: string) {}

  async createWalletChallenge(walletAddress: string): Promise<ChallengeResponse> {
    return this.request<ChallengeResponse>("/v1/auth/challenge", {
      method: "POST",
      body: { walletAddress }
    });
  }

  async verifyWalletSignature(input: {
    challengeId: string;
    walletAddress: string;
    signatureBase64: string;
  }): Promise<{ user: BlobProfile; expiresAt: string }> {
    return this.request("/v1/auth/verify", { method: "POST", body: input });
  }

  async getCurrentProfile(): Promise<BlobProfile | null> {
    try {
      const response = await this.request<{ user: BlobProfile }>("/v1/me", { method: "GET" });
      return response.user;
    } catch (error) {
      if (error instanceof PlatformApiError && error.status === 401) {
        return null;
      }
      throw error;
    }
  }

  async renameProfile(displayName: string): Promise<BlobProfile> {
    const response = await this.request<{ user: BlobProfile }>("/v1/me/profile", {
      method: "PATCH",
      body: { displayName }
    });
    return response.user;
  }

  async getGameIdentityTicket(): Promise<GameIdentityTicket> {
    return this.request<GameIdentityTicket>("/v1/me/game-ticket", { method: "GET" });
  }

  async logout(): Promise<void> {
    await this.request<void>("/v1/auth/logout", { method: "POST" });
  }

  private async request<T>(path: string, input: { method: "GET" | "PATCH" | "POST"; body?: unknown }): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method: input.method,
      credentials: "include",
      headers: input.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: input.body === undefined ? undefined : JSON.stringify(input.body)
    });
    if (response.status === 204) {
      return undefined as T;
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const details = payload as { error?: unknown; message?: unknown } | null;
      throw new PlatformApiError(
        typeof details?.error === "string" ? details.error : "PLATFORM_API_ERROR",
        typeof details?.message === "string" ? details.message : "The profile service could not complete the request.",
        response.status
      );
    }
    return payload as T;
  }
}

export function resolvePlatformApi(): PlatformApi | undefined {
  const configured = import.meta.env.VITE_PLATFORM_API_URL?.trim();
  if (configured) {
    return new PlatformApi(normalizePlatformApiUrl(configured));
  }
  if (import.meta.env.DEV) {
    return new PlatformApi("http://127.0.0.1:3000");
  }
  return undefined;
}

function normalizePlatformApiUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PlatformApiUnavailableError();
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new PlatformApiUnavailableError();
  }
  if (import.meta.env.PROD && parsed.protocol !== "https:") {
    throw new PlatformApiUnavailableError();
  }
  return parsed.origin;
}
