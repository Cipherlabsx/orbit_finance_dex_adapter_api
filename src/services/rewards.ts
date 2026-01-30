import { Connection, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { connection, PROGRAM_ID } from "../solana.js";
import type { OrbitFinance } from "../idl/orbit_finance.js";
import { ORBIT_IDL } from "../idl/coder.js";

const Q128 = 2n ** 128n;
const CIPHER_MINT = new PublicKey("Ciphern9cCXtms66s8Mm6wCFC27b2JProRQLYmiLMH3N");
const CIPHER_OWLS_COLLECTION = new PublicKey("3Yqemc88mnNhQvUEW4NJMU7R93ap6ZCwLX5HzqJWZMJH");
const REWARD_DECIMALS = 6;
const DAS_URL = process.env.SOLANA_RPC_URL?.trim() ?? "";

function readOnlyWallet(identity: PublicKey): Wallet {
  return {
    publicKey: identity,
    signTransaction: async () => {
      throw new Error("read-only wallet");
    },
    signAllTransactions: async () => {
      throw new Error("read-only wallet");
    },
  } as unknown as Wallet;
}

function getProgramReadOnly(conn: Connection, identity: PublicKey): Program<OrbitFinance> {
  const provider = new AnchorProvider(conn, readOnlyWallet(identity), {
    commitment: "confirmed",
  });
  return new Program<OrbitFinance>(ORBIT_IDL as any, provider);
}

function formatUnits(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const frac = amount % base;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}

async function getSplBalanceAtoms(owner: PublicKey, mint: PublicKey): Promise<bigint> {
  const resp = await connection.getParsedTokenAccountsByOwner(owner, { mint });

  let sum = 0n;
  for (const a of resp.value) {
    const amt = a.account.data.parsed?.info?.tokenAmount?.amount as string | undefined;
    if (amt) sum += BigInt(amt);
  }
  return sum;
}

export async function calculateHolderClaimable(
  userPublicKey: string
): Promise<{
  user: string;
  cipherBalance: string;
  claimableAtoms: string;
  claimableUi: string;
  currentIndex: string;
  lastClaimedIndex: string;
  needsInit: boolean;
  decimals: number;
}> {
  const userPk = new PublicKey(userPublicKey);
  const program = getProgramReadOnly(connection, userPk);

  const [globalPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("holder_global")],
    PROGRAM_ID
  );

  const [userPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("holder_user"), userPk.toBuffer()],
    PROGRAM_ID
  );

  const globalState: any = await program.account.holderGlobalState.fetch(globalPda);

  let userState: any;
  let needsInit = false;
  try {
    userState = await program.account.userHolderState.fetch(userPda);
  } catch {
    needsInit = true;
    userState = { lastClaimedIndexQ128: 0n };
  }

  const cipherBalance = await getSplBalanceAtoms(userPk, CIPHER_MINT);

  const currentIndex = BigInt(globalState.rewardIndexQ128.toString());
  const lastIndex = BigInt(userState.lastClaimedIndexQ128.toString());

  const delta = currentIndex > lastIndex ? currentIndex - lastIndex : 0n;
  const claimableAtoms = (delta * cipherBalance) / Q128;

  return {
    user: userPublicKey,
    cipherBalance: cipherBalance.toString(),
    claimableAtoms: claimableAtoms.toString(),
    claimableUi: formatUnits(claimableAtoms, REWARD_DECIMALS),
    currentIndex: currentIndex.toString(),
    lastClaimedIndex: lastIndex.toString(),
    needsInit,
    decimals: REWARD_DECIMALS,
  };
}

export enum NftRarity {
  Common = "Common",
  Uncommon = "Uncommon",
  Rare = "Rare",
}

function rarityWeight(r: NftRarity): number {
  switch (r) {
    case NftRarity.Common:
      return 25;
    case NftRarity.Uncommon:
      return 50;
    case NftRarity.Rare:
      return 100;
  }
}

function rarityFromName(name: string): NftRarity {
  const n = name.toLowerCase();
  if (n.includes("rare")) return NftRarity.Rare;
  if (n.includes("uncommon")) return NftRarity.Uncommon;
  return NftRarity.Common;
}

type DasGrouping = { group_key?: string; group_value?: string };

type DasAsset = {
  id?: string;
  content?: { metadata?: { name?: string } };
  grouping?: DasGrouping[];
};

type DasResponse = {
  result?: {
    items?: DasAsset[];
    total?: number;
    limit?: number;
    page?: number;
  };
  error?: any;
};

async function dasGetAssets(owner: string): Promise<DasAsset[]> {
  if (!DAS_URL) return [];

  const res = await fetch(DAS_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "orbit",
      method: "getAssetsByOwner",
      params: { ownerAddress: owner, page: 1, limit: 1000 },
    }),
  });

  if (!res.ok) {
    throw new Error(`DAS getAssetsByOwner failed: HTTP ${res.status}`);
  }

  const json = (await res.json()) as DasResponse;

  if ((json as any)?.error) {
    throw new Error(`DAS getAssetsByOwner error: ${JSON.stringify((json as any).error)}`);
  }

  const items = json?.result?.items;
  return Array.isArray(items) ? items : [];
}

function isInCollection(a: DasAsset, collection: PublicKey): boolean {
  return (
    a?.grouping?.some(
      (g) => g?.group_key === "collection" && g?.group_value === collection.toBase58()
    ) ?? false
  );
}

export async function calculateNftClaimable(
  userPublicKey: string
): Promise<{
  user: string;
  nfts: {
    mint: string;
    name: string;
    rarity: NftRarity;
    weight: number;
  }[];
  totalWeight: number;
  claimableAtoms: string;
  claimableUi: string;
  currentIndex: string;
  lastClaimedIndex: string;
  needsInit: boolean;
  decimals: number;
}> {
  const userPk = new PublicKey(userPublicKey);
  const program = getProgramReadOnly(connection, userPk);

  const [globalPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("nft_global")],
    PROGRAM_ID
  );

  const [userPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("nft_user"), userPk.toBuffer()],
    PROGRAM_ID
  );

  const globalState: any = await program.account.nftGlobalState.fetch(globalPda);

  let userState: any;
  let needsInit = false;
  try {
    userState = await program.account.userNftState.fetch(userPda);
  } catch {
    needsInit = true;
    userState = { lastClaimedIndexQ128: 0n };
  }

  const assets = await dasGetAssets(userPk.toBase58());
  const nfts = assets
    .filter((a) => isInCollection(a, CIPHER_OWLS_COLLECTION))
    .map((a) => {
      const name = (a?.content?.metadata?.name ?? "").trim();
      const rarity = rarityFromName(name);
      const mint = String(a?.id ?? "");
      return { mint, name, rarity, weight: rarityWeight(rarity) };
    })
    .filter((n) => n.mint && n.name);

  const totalWeight = nfts.reduce((s, n) => s + n.weight, 0);

  const currentIndex = BigInt(globalState.rewardIndexQ128.toString());
  const lastIndex = BigInt(userState.lastClaimedIndexQ128.toString());

  const delta = currentIndex > lastIndex ? currentIndex - lastIndex : 0n;
  const claimableAtoms = (delta * BigInt(totalWeight)) / Q128;

  return {
    user: userPublicKey,
    nfts,
    totalWeight,
    claimableAtoms: claimableAtoms.toString(),
    claimableUi: formatUnits(claimableAtoms, REWARD_DECIMALS),
    currentIndex: currentIndex.toString(),
    lastClaimedIndex: lastIndex.toString(),
    needsInit,
    decimals: REWARD_DECIMALS,
  };
}