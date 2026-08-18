import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount, WalletWithFeatures } from "@wallet-standard/base";
import { StandardConnect, type StandardConnectFeature } from "@wallet-standard/features";
import { SolanaSignMessage, type SolanaSignMessageFeature } from "@solana/wallet-standard-features";
import type { BlobProfile, PlatformApi } from "./platformApi.js";

type SignInWallet = WalletWithFeatures<StandardConnectFeature & SolanaSignMessageFeature>;

export interface AvailableWallet {
  id: string;
  name: string;
  icon: string;
  wallet: SignInWallet;
}

export class WalletConnectionError extends Error {}

export function getAvailableSolanaWallets(): AvailableWallet[] {
  return getWallets().get()
    .filter(isSignInWallet)
    .filter((wallet) => wallet.chains.some((chain) => String(chain).startsWith("solana:")))
    .map((wallet) => ({ id: wallet.name, name: wallet.name, icon: wallet.icon, wallet }));
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

function isSignInWallet(wallet: Wallet): wallet is SignInWallet {
  return StandardConnect in wallet.features && SolanaSignMessage in wallet.features;
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
