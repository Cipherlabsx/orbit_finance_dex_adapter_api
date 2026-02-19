/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/cipher_nft_staking.json`.
 */
export type CipherNftStaking = {
  "address": "7dMir6E96FwiYQQ9mdsL6AKUmgzzrERwqj7mkhthxQgV",
  "metadata": {
    "name": "cipherNftStaking",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Secure NFT staking program for Cipher/Orbit Finance ecosystem"
  },
  "docs": [
    "# Cipher NFT Staking Program",
    "",
    "Secure NFT staking program for the Cipher/Orbit Finance ecosystem.",
    "",
    "## Features",
    "- NFT escrow via PDA (cannot be moved during lock)",
    "- Configurable lock periods per collection",
    "- Binary lock/unlock system (no complex multipliers)",
    "- Emergency pause functionality",
    "- No admin backdoors (authority cannot steal NFTs)",
    "- Full event emission for off-chain indexing",
    "",
    "## Integration with Orbit Finance DLMM",
    "",
    "This program tracks NFT staking positions which Orbit Finance DLMM",
    "uses to determine fee claim eligibility:",
    "",
    "1. User stakes NFT here -> NFT locked in escrow",
    "2. User trades on Orbit Finance DLMM pools -> earns trading fees",
    "3. Orbit Finance DLMM reads stake_account: is_active && !is_unlocked()",
    "4. If true -> user is eligible to claim fees",
    "",
    "## Security Model",
    "",
    "- **NFTs locked in escrow PDA** - physically cannot move until unlock_at",
    "- **No admin withdrawal** - authority cannot access user NFTs",
    "- **Checked math everywhere** - prevents overflows",
    "- **Collection whitelist** - only approved collections stakeable",
    "- **Metadata verification** - validates NFT authenticity",
    "",
    "## Program Flow",
    "",
    "```text",
    "1. Admin: initialize_config()",
    "2. Admin: add_collection() for each allowed NFT collection",
    "3. User:  stake_nft() -> NFT locked, stake_account created",
    "4. User:  [waits for lock period]",
    "5. User:  unstake_nft() -> NFT returned, stake_account closed",
    "```"
  ],
  "instructions": [
    {
      "name": "addCollection",
      "docs": [
        "Add or update a collection's staking configuration",
        "",
        "# Arguments",
        "* `collection` - The NFT collection mint address",
        "* `min_lock_duration` - Minimum lock time in seconds",
        "* `max_lock_duration` - Maximum lock time in seconds",
        "* `enabled` - Whether staking is enabled for this collection",
        "",
        "# Security",
        "Only authority can call this"
      ],
      "discriminator": [
        79,
        172,
        225,
        142,
        219,
        192,
        171,
        80
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "The config authority"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "docs": [
            "The global config"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "collectionConfig",
          "docs": [
            "The collection config PDA"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  108,
                  108,
                  101,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "arg",
                "path": "collection"
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
          "name": "collection",
          "type": "pubkey"
        },
        {
          "name": "minLockDuration",
          "type": "i64"
        },
        {
          "name": "maxLockDuration",
          "type": "i64"
        },
        {
          "name": "enabled",
          "type": "bool"
        }
      ]
    },
    {
      "name": "initializeConfig",
      "docs": [
        "Initialize the global config (call once)",
        "",
        "# Arguments",
        "* `protocol_fee_bps` - Optional fee in basis points (max 1000 = 10%)"
      ],
      "discriminator": [
        208,
        127,
        21,
        1,
        194,
        190,
        196,
        70
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "The authority that will control the config"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "docs": [
            "The global config PDA"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
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
          "name": "protocolFeeBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "stakeNft",
      "docs": [
        "Stake an NFT",
        "",
        "# Arguments",
        "* `lock_duration` - How long to lock in seconds",
        "* `associated_pool` - Optional Orbit Finance DLMM pool address for targeted benefits",
        "",
        "# Security",
        "- Verifies NFT ownership",
        "- Validates collection is whitelisted",
        "- Validates lock duration within bounds",
        "- Freezes NFT (user cannot transfer it)"
      ],
      "discriminator": [
        38,
        27,
        66,
        46,
        69,
        65,
        151,
        219
      ],
      "accounts": [
        {
          "name": "owner",
          "docs": [
            "The NFT owner who is staking"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "asset",
          "docs": [
            "The Core Asset account (the NFT itself)"
          ],
          "writable": true
        },
        {
          "name": "collection",
          "docs": [
            "The collection that this asset belongs to"
          ],
          "writable": true
        },
        {
          "name": "stakeAccount",
          "docs": [
            "The stake account PDA (stores stake info)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  107,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "asset"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "collectionConfig",
          "docs": [
            "The collection config (must be whitelisted)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  108,
                  108,
                  101,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "collection_config.collection",
                "account": "collectionConfig"
              }
            ]
          }
        },
        {
          "name": "config",
          "docs": [
            "Global config"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "freezeDelegate",
          "docs": [
            "Freeze delegate PDA - will be the freeze authority"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  114,
                  101,
                  101,
                  122,
                  101,
                  95,
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "mplCoreProgram",
          "docs": [
            "MPL Core program"
          ]
        },
        {
          "name": "logWrapper",
          "docs": [
            "SPL Noop program (log wrapper) - required by MPL Core"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "lockDuration",
          "type": "i64"
        },
        {
          "name": "associatedPool",
          "type": {
            "option": "pubkey"
          }
        }
      ]
    },
    {
      "name": "unstakeNft",
      "docs": [
        "Unstake an NFT after lock period expires",
        "",
        "# Security",
        "- Verifies lock period has passed",
        "- Verifies owner matches",
        "- Thaws NFT (removes freeze)",
        "- Closes stake account (rent refund)"
      ],
      "discriminator": [
        17,
        182,
        24,
        211,
        101,
        138,
        50,
        163
      ],
      "accounts": [
        {
          "name": "owner",
          "docs": [
            "The NFT owner who is unstaking"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "asset",
          "docs": [
            "The Core Asset account (the NFT itself)"
          ],
          "writable": true
        },
        {
          "name": "collection",
          "docs": [
            "The collection that this asset belongs to"
          ],
          "writable": true
        },
        {
          "name": "stakeAccount",
          "docs": [
            "The stake account"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  107,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "asset"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "collectionConfig",
          "docs": [
            "The collection config"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  108,
                  108,
                  101,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "stake_account.collection",
                "account": "stakeAccount"
              }
            ]
          }
        },
        {
          "name": "config",
          "docs": [
            "Global config"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "freezeDelegate",
          "docs": [
            "Freeze delegate PDA - current freeze authority"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  114,
                  101,
                  101,
                  122,
                  101,
                  95,
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "mplCoreProgram",
          "docs": [
            "MPL Core program"
          ]
        },
        {
          "name": "logWrapper",
          "docs": [
            "SPL Noop program (log wrapper) - required by MPL Core"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "updateConfig",
      "docs": [
        "Update global configuration",
        "",
        "# Arguments",
        "* `new_authority` - Transfer authority (optional)",
        "* `paused` - Pause/unpause staking (optional)",
        "* `protocol_fee_bps` - Update protocol fee (optional)",
        "",
        "# Security",
        "Only current authority can call this"
      ],
      "discriminator": [
        29,
        158,
        252,
        191,
        10,
        83,
        219,
        99
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "The config authority"
          ],
          "signer": true
        },
        {
          "name": "config",
          "docs": [
            "The global config"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "newAuthority",
          "type": {
            "option": "pubkey"
          }
        },
        {
          "name": "paused",
          "type": {
            "option": "bool"
          }
        },
        {
          "name": "protocolFeeBps",
          "type": {
            "option": "u16"
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "collectionConfig",
      "discriminator": [
        223,
        110,
        152,
        160,
        174,
        157,
        106,
        255
      ]
    },
    {
      "name": "globalConfig",
      "discriminator": [
        149,
        8,
        156,
        202,
        160,
        252,
        176,
        217
      ]
    },
    {
      "name": "stakeAccount",
      "discriminator": [
        80,
        158,
        67,
        124,
        50,
        189,
        192,
        255
      ]
    }
  ],
  "events": [
    {
      "name": "collectionWhitelisted",
      "discriminator": [
        4,
        226,
        106,
        185,
        158,
        33,
        19,
        211
      ]
    },
    {
      "name": "configUpdated",
      "discriminator": [
        40,
        241,
        230,
        122,
        11,
        19,
        198,
        194
      ]
    },
    {
      "name": "nftStaked",
      "discriminator": [
        150,
        229,
        155,
        99,
        88,
        181,
        254,
        61
      ]
    },
    {
      "name": "nftUnstaked",
      "discriminator": [
        253,
        242,
        47,
        131,
        231,
        214,
        72,
        117
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "collectionNotWhitelisted",
      "msg": "The NFT collection is not whitelisted for staking"
    },
    {
      "code": 6001,
      "name": "stillLocked",
      "msg": "The lock period has not expired yet"
    },
    {
      "code": 6002,
      "name": "invalidLockDuration",
      "msg": "Invalid lock duration - must be between min and max"
    },
    {
      "code": 6003,
      "name": "invalidNftOwner",
      "msg": "NFT is not owned by the signer"
    },
    {
      "code": 6004,
      "name": "invalidMetadata",
      "msg": "Invalid NFT metadata"
    },
    {
      "code": 6005,
      "name": "stakeAccountMismatch",
      "msg": "Stake account does not match NFT"
    },
    {
      "code": 6006,
      "name": "invalidAuthority",
      "msg": "Config authority mismatch"
    },
    {
      "code": 6007,
      "name": "collectionConfigNotFound",
      "msg": "Collection config not found"
    },
    {
      "code": 6008,
      "name": "arithmeticOverflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6009,
      "name": "invalidMultiplier",
      "msg": "Invalid reward multiplier"
    },
    {
      "code": 6010,
      "name": "stakeAlreadyExists",
      "msg": "Stake account already exists"
    },
    {
      "code": 6011,
      "name": "programPaused",
      "msg": "Program is paused"
    },
    {
      "code": 6012,
      "name": "invalidTokenAccount",
      "msg": "Invalid token account"
    },
    {
      "code": 6013,
      "name": "metadataVerificationFailed",
      "msg": "NFT metadata verification failed"
    },
    {
      "code": 6014,
      "name": "invalidNftType",
      "msg": "Invalid NFT type (must be 0=Traditional or 1=Compressed)"
    },
    {
      "code": 6015,
      "name": "invalidMerkleProof",
      "msg": "Invalid merkle proof - compressed NFT ownership verification failed"
    },
    {
      "code": 6016,
      "name": "compressedNftVerificationFailed",
      "msg": "Compressed NFT verification failed"
    },
    {
      "code": 6017,
      "name": "invalidDelegate",
      "msg": "Delegate authority mismatch or delegation failed"
    },
    {
      "code": 6018,
      "name": "invalidMerkleTree",
      "msg": "Merkle tree account is invalid or inaccessible"
    }
  ],
  "types": [
    {
      "name": "collectionConfig",
      "docs": [
        "Configuration for a specific NFT collection",
        "",
        "Each whitelisted collection has its own config that defines:",
        "- Allowed lock durations",
        "- Whether staking is enabled",
        "",
        "**Integration with Orbit Finance DLMM:** Orbit Finance DLMM checks if a user has an active",
        "stake by reading the StakeAccount. If staked -> eligible for fee claims."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "collection",
            "docs": [
              "The NFT collection's verified collection address"
            ],
            "type": "pubkey"
          },
          {
            "name": "enabled",
            "docs": [
              "Whether staking is enabled for this collection"
            ],
            "type": "bool"
          },
          {
            "name": "bump",
            "docs": [
              "Bump seed for PDA derivation"
            ],
            "type": "u8"
          },
          {
            "name": "minLockDuration",
            "docs": [
              "Minimum lock duration in seconds (e.g., 7 days = 604800)"
            ],
            "type": "i64"
          },
          {
            "name": "maxLockDuration",
            "docs": [
              "Maximum lock duration in seconds (e.g., 365 days = 31536000)"
            ],
            "type": "i64"
          },
          {
            "name": "reserved",
            "docs": [
              "Reserved space for alignment"
            ],
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "totalStaked",
            "docs": [
              "Total number of NFTs currently staked from this collection"
            ],
            "type": "u64"
          },
          {
            "name": "lifetimeStakes",
            "docs": [
              "Total all-time stakes from this collection"
            ],
            "type": "u64"
          },
          {
            "name": "padding",
            "docs": [
              "Reserved space for future fields"
            ],
            "type": {
              "array": [
                "u8",
                128
              ]
            }
          }
        ]
      }
    },
    {
      "name": "collectionWhitelisted",
      "docs": [
        "Emitted when a collection is whitelisted"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "collection",
            "docs": [
              "The collection mint address"
            ],
            "type": "pubkey"
          },
          {
            "name": "minLockDuration",
            "docs": [
              "Minimum lock duration in seconds"
            ],
            "type": "i64"
          },
          {
            "name": "maxLockDuration",
            "docs": [
              "Maximum lock duration in seconds"
            ],
            "type": "i64"
          },
          {
            "name": "enabled",
            "docs": [
              "Whether this collection is enabled"
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "configUpdated",
      "docs": [
        "Emitted when global config is updated"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "docs": [
              "The authority that made the update"
            ],
            "type": "pubkey"
          },
          {
            "name": "paused",
            "docs": [
              "Whether the program is paused"
            ],
            "type": "bool"
          },
          {
            "name": "updatedAt",
            "docs": [
              "Unix timestamp of update"
            ],
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "globalConfig",
      "docs": [
        "Global configuration for the NFT staking program",
        "",
        "This account stores program-wide settings and is controlled by the authority.",
        "Only one instance exists per program.",
        "",
        "**Security:** Authority set to Squads multisig."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "docs": [
              "The authority that can update config and manage collections",
              "Should be a multisig for security"
            ],
            "type": "pubkey"
          },
          {
            "name": "paused",
            "docs": [
              "Whether the program is paused (emergency stop)"
            ],
            "type": "bool"
          },
          {
            "name": "bump",
            "docs": [
              "Bump seed for PDA derivation"
            ],
            "type": "u8"
          },
          {
            "name": "reserved",
            "docs": [
              "Reserved for future upgrades (alignment padding)"
            ],
            "type": {
              "array": [
                "u8",
                6
              ]
            }
          },
          {
            "name": "totalStakes",
            "docs": [
              "Total number of active stakes across all collections"
            ],
            "type": "u64"
          },
          {
            "name": "collectionCount",
            "docs": [
              "Total number of whitelisted collections"
            ],
            "type": "u32"
          },
          {
            "name": "protocolFeeBps",
            "docs": [
              "Protocol fee in basis points (e.g., 100 = 1%)",
              "Applied to rewards (optional, can be 0)"
            ],
            "type": "u16"
          },
          {
            "name": "padding",
            "docs": [
              "Reserved space for future fields"
            ],
            "type": {
              "array": [
                "u8",
                128
              ]
            }
          }
        ]
      }
    },
    {
      "name": "nftStaked",
      "docs": [
        "Emitted when a new NFT is staked"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "staker",
            "docs": [
              "The public key of the staker"
            ],
            "type": "pubkey"
          },
          {
            "name": "nftMint",
            "docs": [
              "The mint address of the staked NFT"
            ],
            "type": "pubkey"
          },
          {
            "name": "collection",
            "docs": [
              "The collection this NFT belongs to"
            ],
            "type": "pubkey"
          },
          {
            "name": "stakedAt",
            "docs": [
              "Unix timestamp when the stake was created"
            ],
            "type": "i64"
          },
          {
            "name": "unlockAt",
            "docs": [
              "Unix timestamp when the NFT can be unstaked"
            ],
            "type": "i64"
          },
          {
            "name": "lockDuration",
            "docs": [
              "Lock duration in seconds"
            ],
            "type": "i64"
          },
          {
            "name": "stakeAccount",
            "docs": [
              "The PDA address of the stake account"
            ],
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "nftUnstaked",
      "docs": [
        "Emitted when an NFT is unstaked"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "staker",
            "docs": [
              "The public key of the staker"
            ],
            "type": "pubkey"
          },
          {
            "name": "nftMint",
            "docs": [
              "The mint address of the unstaked NFT"
            ],
            "type": "pubkey"
          },
          {
            "name": "unstakedAt",
            "docs": [
              "Unix timestamp when unstaked"
            ],
            "type": "i64"
          },
          {
            "name": "totalStakedDuration",
            "docs": [
              "Total time staked in seconds"
            ],
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "stakeAccount",
      "docs": [
        "Individual NFT stake account",
        "",
        "One account per staked NFT. Stores all information about the stake:",
        "- Ownership",
        "- Lock period",
        "- Lock status",
        "- Metadata reference",
        "",
        "**Security:**",
        "- NFT is held in escrow PDA (different from this account)",
        "- Cannot be moved until unlock_at timestamp passes",
        "- Owner verification required for all operations",
        "",
        "**Orbit Finance DLMM Integration:**",
        "Orbit Finance DLMM reads this account to check: is_active && !is_unlocked(now)",
        "If true -> user is eligible for fee claims"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "docs": [
              "The owner/staker of this NFT"
            ],
            "type": "pubkey"
          },
          {
            "name": "nftMint",
            "docs": [
              "The NFT mint address (used for PDA derivation)",
              "For compressed NFTs: stores the merkle tree address"
            ],
            "type": "pubkey"
          },
          {
            "name": "collection",
            "docs": [
              "The verified collection this NFT belongs to"
            ],
            "type": "pubkey"
          },
          {
            "name": "stakedAt",
            "docs": [
              "Unix timestamp when the stake was created"
            ],
            "type": "i64"
          },
          {
            "name": "unlockAt",
            "docs": [
              "Unix timestamp when the NFT can be unstaked"
            ],
            "type": "i64"
          },
          {
            "name": "lockDuration",
            "docs": [
              "Lock duration in seconds"
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "docs": [
              "Bump seed for this PDA"
            ],
            "type": "u8"
          },
          {
            "name": "isActive",
            "docs": [
              "Whether this stake is currently active"
            ],
            "type": "bool"
          },
          {
            "name": "reserved",
            "docs": [
              "Reserved for alignment"
            ],
            "type": {
              "array": [
                "u8",
                6
              ]
            }
          },
          {
            "name": "associatedPool",
            "docs": [
              "Optional: Associated pool address from Orbit Finance DLMM",
              "If set, this stake provides benefits for that specific pool"
            ],
            "type": "pubkey"
          },
          {
            "name": "nftType",
            "docs": [
              "NFT type: 0 = Traditional, 1 = Compressed"
            ],
            "type": "u8"
          },
          {
            "name": "leafIndex",
            "docs": [
              "For compressed NFTs: the leaf index in the merkle tree",
              "For traditional NFTs: unused (0)"
            ],
            "type": "u64"
          },
          {
            "name": "padding",
            "docs": [
              "Reserved space for future fields"
            ],
            "type": {
              "array": [
                "u8",
                135
              ]
            }
          }
        ]
      }
    }
  ]
};
