// SHARD donation wallets — THE single place to swap the placeholder
// addresses below for the real ones. Each entry drives one tab in the
// /donate crypto terminal: tab label, network warning pill, and the
// string that is both rendered and encoded into the QR code.
//
// ⚠️ Replace the X-filled placeholders before going live. A wrong
// network label loses donations — double-check each address.
export type WalletId = "usdt" | "ltc" | "btc" | "trx";

export interface DonationWallet {
  id: WalletId;
  /** Segmented tab label. */
  tab: string;
  /** Prominent network pill — sending on the wrong chain loses funds. */
  network: string;
  /** Wallet address (also the QR payload). */
  address: string;
}

export const DONATE_WALLETS: DonationWallet[] = [
  {
    id: "usdt",
    tab: "USDT (TRC-20)",
    network: "Network: TRON (TRC-20)",
    address: "TWUThH9MsFXAVGNi1o42FQY3ZGqW6Xp4XP",
  },
  {
    id: "ltc",
    tab: "Litecoin (LTC)",
    network: "Network: Litecoin Native",
    address: "ltc1qtq27p9sdy4axqttvm25dwf43sz8xxfx0pt5zke",
  },
  {
    id: "btc",
    tab: "Bitcoin (BTC)",
    network: "Network: Bitcoin Mainnet",
    address: "13W5Jehifupij3oJy2KP86JY6kiCRbwNne",
  },
  {
    id: "trx",
    tab: "TRON (TRX)",
    network: "Network: TRON (TRC-20)",
    address: "TWUThH9MsFXAVGNi1o42FQY3ZGqW6Xp4XP",
  },
];

/** Canonical repository URL used by donate & landing links. */
export const GITHUB_URL = "https://github.com/ShardChat/ShardChat";
