import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount, WalletWithFeatures } from "@wallet-standard/base";
import { StandardConnect, type StandardConnectFeature } from "@wallet-standard/features";
import { SolanaSignMessage, type SolanaSignMessageFeature } from "@solana/wallet-standard-features";
import type { BlobProfile, PlatformApi } from "./platformApi.js";

type SignInWallet = WalletWithFeatures<StandardConnectFeature & SolanaSignMessageFeature>;

interface WalletEntry {
  id: string;
  name: string;
  icon: string;
}

interface WalletStandardEntry extends WalletEntry {
  kind: "wallet-standard";
  wallet: SignInWallet;
}

interface PhantomInjectedEntry extends WalletEntry {
  kind: "phantom-injected";
  wallet: PhantomSolanaProvider;
}

export type AvailableWallet = WalletStandardEntry | PhantomInjectedEntry;

export class WalletConnectionError extends Error {}

export function getAvailableSolanaWallets(): AvailableWallet[] {
  const standardWallets: AvailableWallet[] = getWallets().get()
    .filter(isSignInWallet)
    .filter((wallet) => wallet.chains.some((chain) => String(chain).startsWith("solana:")))
    .map((wallet) => ({ id: wallet.name, name: wallet.name, icon: wallet.icon, kind: "wallet-standard" as const, wallet }));
  const phantom = getInjectedPhantom();
  // Phantom normally registers through Wallet Standard. The direct provider is
  // retained only for Phantom's in-app browser and older injection paths.
  if (phantom && !standardWallets.some((wallet) => wallet.name.toLowerCase().includes("phantom"))) {
    standardWallets.push({
      id: "phantom-injected",
      name: "Phantom",
      icon: PHANTOM_ICON,
      kind: "phantom-injected",
      wallet: phantom
    });
  }
  return standardWallets;
}

export function watchAvailableSolanaWallets(listener: (wallets: AvailableWallet[]) => void): () => void {
  const wallets = getWallets();
  const notify = () => listener(getAvailableSolanaWallets());
  notify();
  const unsubscribeRegister = wallets.on("register", notify);
  const unsubscribeUnregister = wallets.on("unregister", notify);
  return () => {
    unsubscribeRegister();
    unsubscribeUnregister();
  };
}

export async function connectWalletAndCreateProfile(api: PlatformApi, wallet: AvailableWallet): Promise<BlobProfile> {
  if (wallet.kind === "phantom-injected") {
    return connectInjectedPhantom(api, wallet.wallet);
  }
  let accounts: readonly WalletAccount[];
  try {
    accounts = (await wallet.wallet.features[StandardConnect].connect()).accounts;
  } catch {
    throw new WalletConnectionError("Wallet connection was cancelled or declined.");
  }
  const account = accounts.find((candidate) => candidate.chains.some((chain) => String(chain).startsWith("solana:")));
  if (!account) {
    throw new WalletConnectionError("This wallet did not provide a Solana account.");
  }

  const challenge = await api.createWalletChallenge(account.address);
  let signed;
  try {
    [signed] = await wallet.wallet.features[SolanaSignMessage].signMessage({
      account,
      message: new TextEncoder().encode(challenge.message)
    });
  } catch {
    throw new WalletConnectionError("The BLOB sign-in message was not signed.");
  }
  if (!signed || !sameBytes(signed.signedMessage, new TextEncoder().encode(challenge.message))) {
    throw new WalletConnectionError("The wallet returned an unexpected sign-in message.");
  }
  const verified = await api.verifyWalletSignature({
    challengeId: challenge.challengeId,
    walletAddress: account.address,
    signatureBase64: toBase64(signed.signature)
  });
  return verified.user;
}

/** Opens this exact HTTPS page in Phantom's in-app browser. Phantom documents
 * this browse deeplink for mobile pages before a provider connection exists. */
export function openInPhantomMobileBrowser(location: Location): void {
  const pageUrl = location.href;
  const ref = location.origin;
  location.assign("https://phantom.app/ul/browse/" + encodeURIComponent(pageUrl) + "?ref=" + encodeURIComponent(ref));
}

export function isMobileBrowser(userAgent = navigator.userAgent): boolean {
  return /Android|iPhone|iPad|iPod/i.test(userAgent);
}

async function connectInjectedPhantom(api: PlatformApi, provider: PhantomSolanaProvider): Promise<BlobProfile> {
  let address: string;
  try {
    const connected = await provider.connect();
    address = toWalletAddress(connected.publicKey ?? provider.publicKey);
  } catch {
    throw new WalletConnectionError("Wallet connection was cancelled or declined.");
  }
  if (!address) {
    throw new WalletConnectionError("Phantom did not provide a Solana account.");
  }
  const challenge = await api.createWalletChallenge(address);
  const message = new TextEncoder().encode(challenge.message);
  let signature: Uint8Array;
  try {
    const signed = await provider.signMessage(message, "utf8");
    signature = signed.signature;
  } catch {
    throw new WalletConnectionError("The BLOB sign-in message was not signed.");
  }
  if (!(signature instanceof Uint8Array) || signature.length !== 64) {
    throw new WalletConnectionError("The wallet returned an invalid sign-in signature.");
  }
  const verified = await api.verifyWalletSignature({
    challengeId: challenge.challengeId,
    walletAddress: address,
    signatureBase64: toBase64(signature)
  });
  return verified.user;
}

function isSignInWallet(wallet: Wallet): wallet is SignInWallet {
  return StandardConnect in wallet.features && SolanaSignMessage in wallet.features;
}

interface PhantomSolanaProvider {
  isPhantom?: boolean;
  publicKey?: { toBase58?: () => string; toString?: () => string } | string;
  connect(): Promise<{ publicKey?: { toBase58?: () => string; toString?: () => string } | string }>;
  signMessage(message: Uint8Array, display?: "utf8" | "hex"): Promise<{ signature: Uint8Array }>;
}

function getInjectedPhantom(): PhantomSolanaProvider | undefined {
  const browserWindow = window as Window & {
    phantom?: { solana?: PhantomSolanaProvider };
    solana?: PhantomSolanaProvider;
  };
  const provider = browserWindow.phantom?.solana ?? browserWindow.solana;
  return provider?.isPhantom === true
    && typeof provider.connect === "function"
    && typeof provider.signMessage === "function"
    ? provider
    : undefined;
}

function toWalletAddress(value: PhantomSolanaProvider["publicKey"]): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value.toBase58 === "function") {
    return value.toBase58();
  }
  return value?.toString?.() ?? "";
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return window.btoa(binary);
}

const PHANTOM_ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%238d6cff'/%3E%3Cpath fill='white' d='M9 20c1.4-4.6 4.2-6.9 8.4-6.9 2.6 0 4.6.9 5.7 2.6-1.6-1-3.1-1.4-4.4-1.4-3.8 0-5.8 2.2-6 6.5H9Z'/%3E%3C/svg%3E";
