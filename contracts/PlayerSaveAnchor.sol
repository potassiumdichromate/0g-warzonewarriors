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
 * Access control:
 *   - Only the player's own wallet OR the trusted backend operator may anchor.
 *   - The backend address is set immutably at deploy time (no admin key to rotate it).
 *   - A player can always anchor their own save directly — the backend is not required.
 *
 * No upgradeable proxy. Immutable on deployment.
 */
contract PlayerSaveAnchor {

    // Trusted backend operator — set once at deploy, never changeable.
    address public immutable backendOperator;

    struct SaveRecord {
        string  rootHash;    // 0G Storage content address (Merkle root)
        uint64  saveIndex;   // monotonically increasing — rollback detection
        uint64  timestamp;   // block.timestamp at anchor time
        bool    exists;      // true once the first save has been anchored
    }

    // wallet address → latest anchored save
    mapping(address => SaveRecord) private _saves;

    event SaveAnchored(
        address indexed wallet,
        string  rootHash,
        uint64  saveIndex,
        uint64  timestamp
    );

    constructor(address _backendOperator) {
        require(_backendOperator != address(0), "PlayerSaveAnchor: zero backend address");
        backendOperator = _backendOperator;
    }

    /**
     * @notice Anchor a player save rootHash on 0G chain.
     * @param wallet     The player's wallet address.
     * @param rootHash   Content address returned by 0G Storage upload.
     * @param saveIndex  Monotonically increasing save counter (anti-rollback).
     *
     * Only the player themselves or the trusted backend may call this.
     * This closes the griefing vector where any address could overwrite a player's record.
     */
    function anchorSave(
        address wallet,
        string calldata rootHash,
        uint64 saveIndex
    ) external {
        require(
            msg.sender == wallet || msg.sender == backendOperator,
            "PlayerSaveAnchor: caller is not the player or backend"
        );
        require(bytes(rootHash).length > 0, "PlayerSaveAnchor: empty rootHash");

        SaveRecord storage current = _saves[wallet];

        // Anti-rollback: once a save exists, new index must be strictly greater.
        // The `exists` flag removes the saveIndex == 0 bypass bug — a second
        // save with index 0 is now correctly rejected after the first anchor.
        require(
            !current.exists || saveIndex > current.saveIndex,
            "PlayerSaveAnchor: rollback rejected"
        );

        current.rootHash  = rootHash;
        current.saveIndex = saveIndex;
        current.timestamp = uint64(block.timestamp);
        current.exists    = true;

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

    /**
     * @notice Check whether a wallet has ever anchored a save.
     */
    function hasSave(address wallet) external view returns (bool) {
        return _saves[wallet].exists;
    }
}
