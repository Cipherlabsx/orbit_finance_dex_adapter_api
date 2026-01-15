export type StreamflowVaultRow = {
  id: number;
  token_mint: string;
  scan_address: string;
  stake_program: string;
  decimals: number;
  enabled: boolean;
};

export type StakeRow = {
  owner: string;
  staked_raw: string;
};