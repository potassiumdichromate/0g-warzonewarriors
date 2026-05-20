// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * PlayerSaveAnchor — anchors 0G Storage root hashes on-chain for WarzoneWarrior.
 *
 * Deploy via: npm run deploy:anchor
 * Chain: 0G EVM (chainId 16661)
 */
contract PlayerSaveAnchor {
    address public immutable backendOperator;

    struct SaveRecord {
        string rootHash;
        uint64 saveIndex;
        uint256 timestamp;
        bool exists;
    }

    mapping(address => SaveRecord) private _saves;

    event SaveAnchored(
        address indexed wallet,
        string rootHash,
        uint64 saveIndex,
        uint256 timestamp
    );

    constructor(address _backendOperator) {
        require(_backendOperator != address(0), "Invalid operator address");
        backendOperator = _backendOperator;
    }

    function anchorSave(
        address wallet,
        string calldata rootHash,
        uint64 saveIndex
    ) external {
        require(
            msg.sender == wallet || msg.sender == backendOperator,
            "Not authorized: must be wallet owner or backendOperator"
        );

        SaveRecord storage current = _saves[wallet];

        require(
            !current.exists || saveIndex > current.saveIndex,
            "Anti-rollback: saveIndex must be strictly greater than current"
        );

        _saves[wallet] = SaveRecord({
            rootHash:  rootHash,
            saveIndex: saveIndex,
            timestamp: block.timestamp,
            exists:    true
        });

        emit SaveAnchored(wallet, rootHash, saveIndex, block.timestamp);
    }

    function getLatestSave(address wallet)
        external
        view
        returns (
            string memory rootHash,
            uint64 saveIndex,
            uint256 timestamp,
            bool exists
        )
    {
        SaveRecord storage r = _saves[wallet];
        return (r.rootHash, r.saveIndex, r.timestamp, r.exists);
    }

    function hasSave(address wallet) external view returns (bool) {
        return _saves[wallet].exists;
    }
}
