/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/orbit_finance.json`.
 */
export type OrbitFinance = {
  "address": "Fn3fA3fjsmpULNL7E9U79jKTe1KHxPtQeWdURCbJXCnM",
  "metadata": {
    "name": "orbitFinance",
    "version": "0.1.0",
    "spec": "0.1.0"
  },
  "docs": [
    "Program entrypoint for OrbitFinance."
  ],
  "instructions": [
    {
      "name": "claimProtocolFees",
      "docs": [
        "Claims protocol fees from fee vaults."
      ],
      "discriminator": [
        34,
        142,
        219,
        112,
        109,
        54,
        133,
        23
      ],
      "accounts": [
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "feeWithdrawAuthority",
          "signer": true
        },
        {
          "name": "creatorFeeVault",
          "writable": true
        },
        {
          "name": "creatorDestination",
          "docs": [
            "Where creator fees are finally sent (pool creator, DAO treasury, etc.)"
          ],
          "writable": true
        },
        {
          "name": "holdersFeeVault",
          "writable": true
        },
        {
          "name": "holdersDestination",
          "docs": [
            "Aggregator / distributor for token holders rewards"
          ],
          "writable": true
        },
        {
          "name": "nftFeeVault",
          "writable": true
        },
        {
          "name": "nftDestination",
          "docs": [
            "Aggregator / distributor for NFT holders rewards"
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "takeCreator",
          "type": "u64"
        },
        {
          "name": "takeHolders",
          "type": "u64"
        },
        {
          "name": "takeNft",
          "type": "u64"
        }
      ]
    },
    {
      "name": "closePool",
      "docs": [
        "Closes pool (admin only)."
      ],
      "discriminator": [
        140,
        189,
        209,
        23,
        239,
        62,
        239,
        11
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "pool",
          "docs": [
            "Pool PDA (seeded from instruction args)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "arg",
                "path": "baseMint"
              },
              {
                "kind": "arg",
                "path": "quoteMint"
              }
            ]
          }
        },
        {
          "name": "registry",
          "docs": [
            "Registry PDA (close too so you can re-init same pair)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              },
              {
                "kind": "arg",
                "path": "baseMint"
              },
              {
                "kind": "arg",
                "path": "quoteMint"
              }
            ]
          }
        },
        {
          "name": "baseVault",
          "writable": true
        },
        {
          "name": "quoteVault",
          "writable": true
        },
        {
          "name": "creatorFeeVault",
          "writable": true
        },
        {
          "name": "holdersFeeVault",
          "writable": true
        },
        {
          "name": "nftFeeVault",
          "writable": true
        },
        {
          "name": "adminBaseAta",
          "writable": true
        },
        {
          "name": "adminQuoteAta",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "baseMint",
          "type": "pubkey"
        },
        {
          "name": "quoteMint",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "createLiquidityBin",
      "docs": [
        "Creates a new liquidity bin."
      ],
      "discriminator": [
        143,
        97,
        237,
        207,
        213,
        220,
        250,
        67
      ],
      "accounts": [
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "liquidityBin",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  105,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              },
              {
                "kind": "arg",
                "path": "binIndex"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "binIndex",
          "type": "u64"
        },
        {
          "name": "lowerBoundQ6464",
          "type": "u128"
        },
        {
          "name": "upperBoundQ6464",
          "type": "u128"
        },
        {
          "name": "liquidity",
          "type": "u128"
        }
      ]
    },
    {
      "name": "depositIntoBins",
      "docs": [
        "Deposits liquidity into specific bins; mints LP shares to the depositor."
      ],
      "discriminator": [
        54,
        211,
        101,
        119,
        71,
        98,
        126,
        228
      ],
      "accounts": [
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "depositor",
          "docs": [
            "Depositor & LP receiver"
          ],
          "signer": true
        },
        {
          "name": "depositorBase",
          "writable": true
        },
        {
          "name": "depositorQuote",
          "writable": true
        },
        {
          "name": "baseVault",
          "writable": true
        },
        {
          "name": "quoteVault",
          "writable": true
        },
        {
          "name": "lpMint",
          "writable": true
        },
        {
          "name": "depositorLp",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "entries",
          "type": {
            "vec": {
              "defined": {
                "name": "binDeposit"
              }
            }
          }
        },
        {
          "name": "minSharesOut",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initPool",
      "docs": [
        "Initializes a new liquidity pool (state + lp_mint + registry)."
      ],
      "discriminator": [
        116,
        233,
        199,
        204,
        115,
        159,
        171,
        36
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "Pays for initialization; becomes pool admin (can be rotated later)."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "creator"
        },
        {
          "name": "baseMintAccount"
        },
        {
          "name": "quoteMintAccount"
        },
        {
          "name": "pool",
          "docs": [
            "Pool state account (PDA) - zero_copy for stack efficiency."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "arg",
                "path": "baseMint"
              },
              {
                "kind": "arg",
                "path": "quoteMint"
              }
            ]
          }
        },
        {
          "name": "lpMint",
          "writable": true,
          "signer": true
        },
        {
          "name": "registry",
          "docs": [
            "Pair registry PDA to prevent duplicate pools."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121
                ]
              },
              {
                "kind": "arg",
                "path": "baseMint"
              },
              {
                "kind": "arg",
                "path": "quoteMint"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "baseMint",
          "type": "pubkey"
        },
        {
          "name": "quoteMint",
          "type": "pubkey"
        },
        {
          "name": "binStepBps",
          "type": "u16"
        },
        {
          "name": "initialPriceQ6464",
          "type": "u128"
        },
        {
          "name": "feeConfig",
          "type": {
            "defined": {
              "name": "feeConfig"
            }
          }
        }
      ]
    },
    {
      "name": "initPoolVaults",
      "docs": [
        "Initializes the pool’s vault token accounts and writes them into Pool."
      ],
      "discriminator": [
        209,
        118,
        61,
        154,
        158,
        189,
        162,
        244
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "Payer for account creations"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "pool",
          "docs": [
            "Pool PDA (already initialized by `init_pool`)"
          ],
          "writable": true
        },
        {
          "name": "baseMintAccount",
          "docs": [
            "Mint accounts (Anchor will deserialize + owner-check)"
          ]
        },
        {
          "name": "quoteMintAccount"
        },
        {
          "name": "baseVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              },
              {
                "kind": "const",
                "value": [
                  98,
                  97,
                  115,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "quoteVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              },
              {
                "kind": "const",
                "value": [
                  113,
                  117,
                  111,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "creatorFeeVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              },
              {
                "kind": "const",
                "value": [
                  99,
                  114,
                  101,
                  97,
                  116,
                  111,
                  114,
                  95,
                  102,
                  101,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "holdersFeeVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              },
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  101,
                  114,
                  115,
                  95,
                  102,
                  101,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "nftFeeVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              },
              {
                "kind": "const",
                "value": [
                  110,
                  102,
                  116,
                  95,
                  102,
                  101,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "lockLiquidity",
      "docs": [
        "Locks liquidity metadata."
      ],
      "discriminator": [
        179,
        201,
        236,
        158,
        212,
        98,
        70,
        182
      ],
      "accounts": [
        {
          "name": "pool",
          "docs": [
            "Pool state (PDA) - validated in function body"
          ],
          "writable": true
        },
        {
          "name": "liquidityLock",
          "docs": [
            "Per-user lock record (PDA) - manually initialized"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  111,
                  99,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "user"
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "user",
          "docs": [
            "User who owns the lock record"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "userLp",
          "docs": [
            "User LP account to validate they have enough tokens and transfer from"
          ],
          "writable": true
        },
        {
          "name": "lpMint"
        },
        {
          "name": "escrowLp",
          "docs": [
            "Escrow account owned by pool PDA to hold locked LP tokens"
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "lockDuration",
          "type": "i64"
        }
      ]
    },
    {
      "name": "setPause",
      "docs": [
        "Pauses or unpauses the pool."
      ],
      "discriminator": [
        63,
        32,
        154,
        2,
        56,
        103,
        79,
        45
      ],
      "accounts": [
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "admin",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "pause",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setPauseBits",
      "docs": [
        "Sets pause bits for the pool (pause_guardian only)."
      ],
      "discriminator": [
        122,
        45,
        85,
        156,
        176,
        64,
        45,
        83
      ],
      "accounts": [
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "pauseGuardian",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "newBits",
          "type": "u8"
        }
      ]
    },
    {
      "name": "swap",
      "docs": [
        "Executes a swap against the pool.",
        "matching the internal signature and avoiding the `'1` vs `'2` lifetime clash."
      ],
      "discriminator": [
        248,
        198,
        158,
        145,
        225,
        117,
        135,
        200
      ],
      "accounts": [
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "user",
          "signer": true
        },
        {
          "name": "userSource",
          "writable": true
        },
        {
          "name": "userDestination",
          "writable": true
        },
        {
          "name": "baseVault",
          "writable": true
        },
        {
          "name": "quoteVault",
          "writable": true
        },
        {
          "name": "creatorFeeVault",
          "writable": true
        },
        {
          "name": "holdersFeeVault",
          "writable": true
        },
        {
          "name": "nftFeeVault",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amountIn",
          "type": "u64"
        },
        {
          "name": "minAmountOut",
          "type": "u64"
        },
        {
          "name": "route",
          "type": {
            "defined": {
              "name": "swapRoute"
            }
          }
        }
      ]
    },
    {
      "name": "updateAdmin",
      "docs": [
        "Updates the pool admin (admin only)."
      ],
      "discriminator": [
        161,
        176,
        40,
        213,
        60,
        184,
        179,
        228
      ],
      "accounts": [
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "admin",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "newAdmin",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "updateAuthorities",
      "docs": [
        "Updates pool authorities (admin only)."
      ],
      "discriminator": [
        175,
        228,
        137,
        18,
        175,
        70,
        220,
        165
      ],
      "accounts": [
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "admin",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "configAuthority",
          "type": "pubkey"
        },
        {
          "name": "pauseGuardian",
          "type": "pubkey"
        },
        {
          "name": "feeWithdrawAuthority",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "updateFeeConfig",
      "docs": [
        "Updates the pool fee configuration."
      ],
      "discriminator": [
        104,
        184,
        103,
        242,
        88,
        151,
        107,
        20
      ],
      "accounts": [
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "admin",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "newFeeConfig",
          "type": {
            "defined": {
              "name": "feeConfig"
            }
          }
        }
      ]
    },
    {
      "name": "withdrawLiquidity",
      "docs": [
        "Admin-only withdrawal"
      ],
      "discriminator": [
        149,
        158,
        33,
        185,
        47,
        243,
        253,
        31
      ],
      "accounts": [
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "admin",
          "signer": true
        },
        {
          "name": "baseVault",
          "writable": true
        },
        {
          "name": "quoteVault",
          "writable": true
        },
        {
          "name": "lpMint",
          "writable": true
        },
        {
          "name": "adminLp",
          "writable": true
        },
        {
          "name": "adminBase",
          "writable": true
        },
        {
          "name": "adminQuote",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "sharesToBurn",
          "type": "u64"
        }
      ]
    },
    {
      "name": "withdrawUser",
      "docs": [
        "User withdrawal: burns LP shares and returns pro-rata assets."
      ],
      "discriminator": [
        86,
        169,
        152,
        107,
        33,
        180,
        134,
        115
      ],
      "accounts": [
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "userLp",
          "writable": true
        },
        {
          "name": "liquidityLock",
          "docs": [
            "If account doesn't exist, user has no active locks",
            "We use UncheckedAccount and validate manually to handle cases where account doesn't exist"
          ]
        },
        {
          "name": "lpMint",
          "writable": true
        },
        {
          "name": "baseVault",
          "writable": true
        },
        {
          "name": "quoteVault",
          "writable": true
        },
        {
          "name": "userBase",
          "writable": true
        },
        {
          "name": "userQuote",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "sharesToBurn",
          "type": "u64"
        },
        {
          "name": "minBaseOut",
          "type": "u64"
        },
        {
          "name": "minQuoteOut",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "liquidityBin",
      "discriminator": [
        4,
        80,
        150,
        39,
        152,
        88,
        42,
        158
      ]
    },
    {
      "name": "pairRegistry",
      "discriminator": [
        180,
        142,
        99,
        6,
        243,
        194,
        134,
        152
      ]
    },
    {
      "name": "pool",
      "discriminator": [
        241,
        154,
        109,
        4,
        17,
        177,
        109,
        188
      ]
    }
  ],
  "events": [
    {
      "name": "adminUpdated",
      "discriminator": [
        69,
        82,
        49,
        171,
        43,
        3,
        80,
        161
      ]
    },
    {
      "name": "authoritiesUpdated",
      "discriminator": [
        67,
        41,
        36,
        180,
        223,
        84,
        221,
        76
      ]
    },
    {
      "name": "binLiquidityUpdated",
      "discriminator": [
        75,
        48,
        154,
        36,
        109,
        209,
        141,
        126
      ]
    },
    {
      "name": "feeConfigUpdated",
      "discriminator": [
        45,
        50,
        42,
        173,
        193,
        67,
        52,
        244
      ]
    },
    {
      "name": "feesDistributed",
      "discriminator": [
        209,
        24,
        174,
        200,
        236,
        90,
        154,
        55
      ]
    },
    {
      "name": "liquidityBinCreated",
      "discriminator": [
        193,
        62,
        251,
        203,
        209,
        242,
        92,
        48
      ]
    },
    {
      "name": "liquidityDeposited",
      "discriminator": [
        218,
        155,
        74,
        193,
        59,
        66,
        94,
        122
      ]
    },
    {
      "name": "liquidityLocked",
      "discriminator": [
        150,
        201,
        204,
        183,
        217,
        13,
        119,
        185
      ]
    },
    {
      "name": "liquidityWithdrawnAdmin",
      "discriminator": [
        236,
        107,
        253,
        125,
        227,
        157,
        155,
        123
      ]
    },
    {
      "name": "liquidityWithdrawnUser",
      "discriminator": [
        142,
        245,
        211,
        16,
        66,
        171,
        36,
        40
      ]
    },
    {
      "name": "pairRegistered",
      "discriminator": [
        125,
        143,
        112,
        66,
        5,
        53,
        110,
        4
      ]
    },
    {
      "name": "pauseUpdated",
      "discriminator": [
        203,
        203,
        33,
        225,
        130,
        103,
        90,
        105
      ]
    },
    {
      "name": "poolInitialized",
      "discriminator": [
        100,
        118,
        173,
        87,
        12,
        198,
        254,
        229
      ]
    },
    {
      "name": "swapExecuted",
      "discriminator": [
        150,
        166,
        26,
        225,
        28,
        89,
        38,
        79
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "invalidLiquidity",
      "msg": "The provided liquidity value is invalid."
    },
    {
      "code": 6001,
      "name": "calculationError",
      "msg": "Calculation error occurred during arithmetic operations."
    },
    {
      "code": 6002,
      "name": "invalidInput",
      "msg": "The provided input data is invalid."
    },
    {
      "code": 6003,
      "name": "internalInconsistency",
      "msg": "Operation aborted due to an internal inconsistency."
    },
    {
      "code": 6004,
      "name": "unknownError",
      "msg": "An unknown error has occurred."
    },
    {
      "code": 6005,
      "name": "slippageExceeded",
      "msg": "The swap operation did not meet the minimum output requirements due to slippage protection."
    },
    {
      "code": 6006,
      "name": "insufficientLiquidity",
      "msg": "The pool does not have sufficient liquidity to perform this operation."
    },
    {
      "code": 6007,
      "name": "unauthorizedOperation",
      "msg": "Unauthorized operation attempted."
    },
    {
      "code": 6008,
      "name": "invalidAuthority",
      "msg": "Invalid or missing protocol authority for this operation."
    },
    {
      "code": 6009,
      "name": "invalidAccountState",
      "msg": "The account state is invalid."
    },
    {
      "code": 6010,
      "name": "mintMismatch",
      "msg": "Token account mint does not match expected mint for this pool."
    },
    {
      "code": 6011,
      "name": "ownerMismatch",
      "msg": "Token account owner does not match expected authority."
    },
    {
      "code": 6012,
      "name": "tokenTransferFailed",
      "msg": "Token transfer failed to execute correctly."
    },
    {
      "code": 6013,
      "name": "poolPaused",
      "msg": "Pool is currently paused."
    },
    {
      "code": 6014,
      "name": "operationDisabled",
      "msg": "The requested operation is currently disabled."
    },
    {
      "code": 6015,
      "name": "migrationFailed",
      "msg": "Migration failed for this pool account."
    },
    {
      "code": 6016,
      "name": "versionMismatch",
      "msg": "On-chain version mismatch detected."
    },
    {
      "code": 6017,
      "name": "poolAlreadyExists",
      "msg": "Pool already exists for this token pair and configuration."
    },
    {
      "code": 6018,
      "name": "poolNotFound",
      "msg": "Pool not found for the requested token pair and configuration."
    },
    {
      "code": 6019,
      "name": "pairOrderingViolation",
      "msg": "Invalid pair ordering; token pair must be canonicalized."
    },
    {
      "code": 6020,
      "name": "registryViolation",
      "msg": "Pair registry constraint violated."
    },
    {
      "code": 6021,
      "name": "binAlreadyExists",
      "msg": "Liquidity bin already exists for this index."
    },
    {
      "code": 6022,
      "name": "binNotFound",
      "msg": "Liquidity bin not found for the requested index."
    },
    {
      "code": 6023,
      "name": "invalidBinBounds",
      "msg": "Invalid liquidity bin bounds."
    },
    {
      "code": 6024,
      "name": "lpTokenMismatch",
      "msg": "LP token mint or account does not match this pool."
    },
    {
      "code": 6025,
      "name": "notEnoughShares",
      "msg": "Not enough LP shares to complete this operation."
    },
    {
      "code": 6026,
      "name": "lpVaultMismatch",
      "msg": "LP vault or escrow does not match expected authority."
    },
    {
      "code": 6027,
      "name": "reentrancyDetected",
      "msg": "Reentrancy detected: operation aborted for security reasons."
    },
    {
      "code": 6028,
      "name": "priceOutOfRange",
      "msg": "Initial deposit price deviates from target"
    },
    {
      "code": 6029,
      "name": "poolNotEmpty",
      "msg": "Pool reserves must be empty on bootstrap"
    },
    {
      "code": 6030,
      "name": "invalidVaultOwner",
      "msg": "Vault is not owned by the SPL Token program"
    },
    {
      "code": 6031,
      "name": "invalidVaultAuthority",
      "msg": "Vault has an unexpected authority"
    },
    {
      "code": 6032,
      "name": "invalidVaultMint",
      "msg": "Vault has an unexpected mint"
    },
    {
      "code": 6033,
      "name": "invalidVaultData",
      "msg": "Account data is too short to be a valid SPL Token account"
    },
    {
      "code": 6034,
      "name": "activeLock",
      "msg": "Liquidity is currently locked and cannot be withdrawn until the lock period expires."
    },
    {
      "code": 6035,
      "name": "insufficientLp",
      "msg": "Insufficient LP tokens for this operation."
    },
    {
      "code": 6036,
      "name": "vaultsAlreadyInitialized",
      "msg": "Pool vaults already initialized."
    }
  ],
  "types": [
    {
      "name": "adminUpdated",
      "docs": [
        "Emitted when the admin rotates to a new key."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "oldAdmin",
            "type": "pubkey"
          },
          {
            "name": "newAdmin",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "authoritiesUpdated",
      "docs": [
        "Emitted when auxiliary authorities are updated."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "configAuthority",
            "type": "pubkey"
          },
          {
            "name": "pauseGuardian",
            "type": "pubkey"
          },
          {
            "name": "feeWithdrawAuthority",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "binDeposit",
      "docs": [
        "Per-bin deposit instruction argument"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "binIndex",
            "type": "u64"
          },
          {
            "name": "baseIn",
            "type": "u64"
          },
          {
            "name": "quoteIn",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "binLiquidityUpdated",
      "docs": [
        "Emitted whenever a bin’s reserves change (e.g., deposit or swap traversal)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "binIndex",
            "type": "i64"
          },
          {
            "name": "deltaBase",
            "docs": [
              "Change in base/quote reserve (unsigned magnitudes)."
            ],
            "type": "u128"
          },
          {
            "name": "deltaQuote",
            "type": "u128"
          },
          {
            "name": "reserveBase",
            "docs": [
              "Resulting reserves after the change."
            ],
            "type": "u128"
          },
          {
            "name": "reserveQuote",
            "type": "u128"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "feeConfig",
      "docs": [
        "Fee distribution configuration for the pool."
      ],
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "baseFeeBps",
            "type": "u16"
          },
          {
            "name": "creatorCutBps",
            "type": "u16"
          },
          {
            "name": "splitHoldersMicrobps",
            "type": "u32"
          },
          {
            "name": "splitNftMicrobps",
            "type": "u32"
          },
          {
            "name": "splitCreatorExtraMicrobps",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "feeConfigUpdated",
      "docs": [
        "Emitted whenever the fee configuration is changed."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "baseFeeBps",
            "type": "u16"
          },
          {
            "name": "creatorCutBps",
            "type": "u16"
          },
          {
            "name": "splitHoldersMicrobps",
            "type": "u32"
          },
          {
            "name": "splitNftMicrobps",
            "type": "u32"
          },
          {
            "name": "splitCreatorExtraMicrobps",
            "type": "u32"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "feesDistributed",
      "docs": [
        "Emitted when fees are split to fee vaults during swap."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "totalFee",
            "type": "u64"
          },
          {
            "name": "creatorFee",
            "type": "u64"
          },
          {
            "name": "holdersFee",
            "type": "u64"
          },
          {
            "name": "nftFee",
            "type": "u64"
          },
          {
            "name": "creatorExtraFee",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "liquidityBin",
      "docs": [
        "Discrete liquidity bin (price bucket)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "docs": [
              "Owning pool."
            ],
            "type": "pubkey"
          },
          {
            "name": "binIndex",
            "docs": [
              "Bin index (PDA uses u64 LE for seeds). Math uses signed i32."
            ],
            "type": "u64"
          },
          {
            "name": "lowerBoundQ6464",
            "docs": [
              "Optional bounds for analytics / sanity (Q64.64)."
            ],
            "type": "u128"
          },
          {
            "name": "upperBoundQ6464",
            "type": "u128"
          },
          {
            "name": "liquidity",
            "docs": [
              "Optional notion of \"liquidity units\" (for analytics)."
            ],
            "type": "u128"
          },
          {
            "name": "reserveBase",
            "docs": [
              "Actual reserves at this bin's fixed price."
            ],
            "type": "u128"
          },
          {
            "name": "reserveQuote",
            "type": "u128"
          },
          {
            "name": "feeGrowthBaseQ128",
            "docs": [
              "Cumulative fee growth (per 1 unit of base/quote) in Q128 domain."
            ],
            "type": "u128"
          },
          {
            "name": "feeGrowthQuoteQ128",
            "type": "u128"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump."
            ],
            "type": "u8"
          },
          {
            "name": "reserved",
            "docs": [
              "Padding / future use."
            ],
            "type": {
              "array": [
                "u8",
                7
              ]
            }
          }
        ]
      }
    },
    {
      "name": "liquidityBinCreated",
      "docs": [
        "Emitted when a new liquidity bin is created."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "binIndex",
            "type": "u64"
          },
          {
            "name": "lowerBoundQ6464",
            "type": "u128"
          },
          {
            "name": "upperBoundQ6464",
            "type": "u128"
          },
          {
            "name": "initialLiquidity",
            "docs": [
              "Initial bin liquidity recorded at creation."
            ],
            "type": "u128"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "liquidityDeposited",
      "docs": [
        "Emitted when a user deposits liquidity and receives LP shares."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "baseAmount",
            "type": "u64"
          },
          {
            "name": "quoteAmount",
            "type": "u64"
          },
          {
            "name": "sharesMinted",
            "docs": [
              "LP shares minted to the user (LP mint decimals, typically 9)."
            ],
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "liquidityLocked",
      "docs": [
        "Emitted when a user locks liquidity (book-entry in current code)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "lockEnd",
            "type": "i64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "liquidityWithdrawnAdmin",
      "docs": [
        "Emitted when an admin performs a legacy/admin-only withdrawal."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "baseAmountOut",
            "type": "u64"
          },
          {
            "name": "quoteAmountOut",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "liquidityWithdrawnUser",
      "docs": [
        "Emitted when a user withdraws by burning LP shares."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "sharesBurned",
            "type": "u64"
          },
          {
            "name": "baseAmountOut",
            "type": "u64"
          },
          {
            "name": "quoteAmountOut",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "pairRegistered",
      "docs": [
        "Emitted if you keep a separate register_pair instruction (factory/registry path)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "baseMint",
            "type": "pubkey"
          },
          {
            "name": "quoteMint",
            "type": "pubkey"
          },
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "binStepBps",
            "type": "u16"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "pairRegistry",
      "docs": [
        "Pair registry to prevent duplicate pools beyond canonical ordering.",
        "PDA seeds: [b\"registry\", base_mint, quote_mint] (where base_mint < quote_mint)"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "baseMint",
            "docs": [
              "Canonical pair (base < quote)"
            ],
            "type": "pubkey"
          },
          {
            "name": "quoteMint",
            "type": "pubkey"
          },
          {
            "name": "pool",
            "docs": [
              "Pool address created for this pair."
            ],
            "type": "pubkey"
          },
          {
            "name": "binStepBps",
            "docs": [
              "Bin step used by this pool (bps)."
            ],
            "type": "u16"
          },
          {
            "name": "createdAt",
            "docs": [
              "Creation timestamp."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "docs": [
              "Bump seed."
            ],
            "type": "u8"
          },
          {
            "name": "reserved",
            "docs": [
              "Reserved for future config (e.g., flags)."
            ],
            "type": {
              "array": [
                "u8",
                13
              ]
            }
          }
        ]
      }
    },
    {
      "name": "pauseUpdated",
      "docs": [
        "Emitted when pause bitmask changes."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "paused",
            "docs": [
              "Bitmask of paused features (see state/flags.rs):",
              "PAUSE_SWAP | PAUSE_DEPOSIT | PAUSE_WITHDRAW"
            ],
            "type": "u8"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "pool",
      "docs": [
        "Main pool account holding configuration, authorities, price cache and vaults.",
        "Fields are ordered to minimize padding for zero-copy compatibility.",
        "Using unsafe Pod/Zeroable impl because #[repr(C)] may add minimal padding",
        "between fields of different alignments, but all fields are Pod-compatible."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "configAuthority",
            "type": "pubkey"
          },
          {
            "name": "pauseGuardian",
            "type": "pubkey"
          },
          {
            "name": "feeWithdrawAuthority",
            "type": "pubkey"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "baseMint",
            "type": "pubkey"
          },
          {
            "name": "quoteMint",
            "type": "pubkey"
          },
          {
            "name": "baseVault",
            "type": "pubkey"
          },
          {
            "name": "quoteVault",
            "type": "pubkey"
          },
          {
            "name": "creatorFeeVault",
            "type": "pubkey"
          },
          {
            "name": "holdersFeeVault",
            "type": "pubkey"
          },
          {
            "name": "nftFeeVault",
            "type": "pubkey"
          },
          {
            "name": "lpMint",
            "type": "pubkey"
          },
          {
            "name": "priceQ6464",
            "type": "u128"
          },
          {
            "name": "totalShares",
            "type": "u128"
          },
          {
            "name": "totalHolderUnits",
            "type": "u128"
          },
          {
            "name": "totalNftUnits",
            "type": "u128"
          },
          {
            "name": "rewardIndexes",
            "type": {
              "defined": {
                "name": "rewardIndexes"
              }
            }
          },
          {
            "name": "lastUpdated",
            "type": "i64"
          },
          {
            "name": "initialBinId",
            "type": "i32"
          },
          {
            "name": "activeBin",
            "type": "i32"
          },
          {
            "name": "splitHoldersMicrobps",
            "type": "u32"
          },
          {
            "name": "splitNftMicrobps",
            "type": "u32"
          },
          {
            "name": "splitCreatorExtraMicrobps",
            "type": "u32"
          },
          {
            "name": "binStepBps",
            "type": "u16"
          },
          {
            "name": "baseFeeBps",
            "type": "u16"
          },
          {
            "name": "creatorCutBps",
            "type": "u16"
          },
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "pauseBits",
            "type": "u8"
          },
          {
            "name": "pad",
            "type": {
              "array": [
                "u8",
                27
              ]
            }
          }
        ]
      }
    },
    {
      "name": "poolInitialized",
      "docs": [
        "Emitted once when a pool is initialized."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "baseMint",
            "type": "pubkey"
          },
          {
            "name": "quoteMint",
            "type": "pubkey"
          },
          {
            "name": "binStepBps",
            "type": "u16"
          },
          {
            "name": "initialPriceQ6464",
            "type": "u128"
          },
          {
            "name": "baseFeeBps",
            "type": "u16"
          },
          {
            "name": "creatorCutBps",
            "type": "u16"
          },
          {
            "name": "splitHoldersMicrobps",
            "type": "u32"
          },
          {
            "name": "splitNftMicrobps",
            "type": "u32"
          },
          {
            "name": "splitCreatorExtraMicrobps",
            "type": "u32"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "rewardIndexes",
      "docs": [
        "Tracks accumulated reward indexes for holders and NFT stakers."
      ],
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "holdersQ128",
            "type": "u128"
          },
          {
            "name": "nftQ128",
            "type": "u128"
          }
        ]
      }
    },
    {
      "name": "swapExecuted",
      "docs": [
        "Emitted on each swap execution."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pool",
            "type": "pubkey"
          },
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "inMint",
            "type": "pubkey"
          },
          {
            "name": "outMint",
            "type": "pubkey"
          },
          {
            "name": "amountIn",
            "type": "u64"
          },
          {
            "name": "amountOut",
            "type": "u64"
          },
          {
            "name": "totalFee",
            "docs": [
              "Total fee charged (token domain depends on direction; commonly quote)."
            ],
            "type": "u64"
          },
          {
            "name": "priceAfterQ6464",
            "docs": [
              "Post-swap price marker in Q64.64."
            ],
            "type": "u128"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "swapRoute",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "binIndices",
            "type": {
              "vec": "i32"
            }
          }
        ]
      }
    }
  ]
};
