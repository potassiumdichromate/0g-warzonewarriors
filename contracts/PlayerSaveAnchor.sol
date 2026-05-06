// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title  PlayerSaveAnchor
 * @notice Deployed on 0G EVM chain (chainId 16600, https://evmrpc.0g.ai).
 *
 * Every Warzone Warriors player save is stored as a binary file on 0G Storage.
 * This contract anchors the content-addressed rootHash on-chain, creating an
 * immutable, publicly verifiable proof that:
 *   "wallet <addr> committed save file <rootHash> at index <saveIndex>"
 *
 * Verification flow for anyone (player, auditor, 0G, VC):
 *   1. Call getLatestSave(wallet) → get rootHash
 *   2. Fetch file from 0G Storage using rootHash → get binary save data
 *   3. Merkle proof verified by 0G SDK on download — tamper-proof
 *
 * Permissionless: anyone can call anchorSave (backend, player, third party).
 * No admin key. No upgradeable proxy. Immutable on deployment.
 */
contract PlayerSaveAnchor {

    struct SaveRecord {
        string  rootHash;    // 0G Storage content address (Merkle root)
        uint64  saveIndex;   // monotonically increasing — rollback detection
        uint64  timestamp;   // block.timestamp at anchor time
    }

    // wallet address → latest anchored save
    mapping(address => SaveRecord) private _saves;

    event SaveAnchored(
        address indexed wallet,
        string  rootHash,
        uint64  saveIndex,
        uint64  timestamp
    );

    /**
     * @notice Anchor a player save rootHash on 0G chain.
     * @param wallet     The player's wallet address.
     * @param rootHash   Content address returned by 0G Storage upload.
     * @param saveIndex  Monotonically increasing save counter (anti-rollback).
     */
    function anchorSave(
        address wallet,
        string calldata rootHash,
        uint64 saveIndex
    ) external {
        SaveRecord storage current = _saves[wallet];

        // Enforce anti-rollback: new index must be strictly greater.
        // Exception: first ever save (saveIndex == 0 and no existing record).
        require(
            current.saveIndex == 0 || saveIndex > current.saveIndex,
            "PlayerSaveAnchor: rollback rejected"
        );
        require(bytes(rootHash).length > 0, "PlayerSaveAnchor: empty rootHash");

        current.rootHash  = rootHash;
        current.saveIndex = saveIndex;
        current.timestamp = uint64(block.timestamp);

        emit SaveAnchored(wallet, rootHash, saveIndex, uint64(block.timestamp));
    }

    /**
     * @notice Read the latest anchored save for a wallet.
     * @return rootHash   The 0G Storage content address.
     * @return saveIndex  The save counter at time of anchoring.
     * @return timestamp  Block timestamp when this was anchored.
     */
    function getLatestSave(address wallet)
        external
        view
        returns (string memory rootHash, uint64 saveIndex, uint64 timestamp)
    {
        SaveRecord storage r = _saves[wallet];
        return (r.rootHash, r.saveIndex, r.timestamp);
    }
}
