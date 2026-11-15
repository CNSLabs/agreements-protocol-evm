// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

contract MockERC8004IdentityRegistry {
    mapping(uint256 => address) private _owners;
    mapping(uint256 => address) private _approved;
    mapping(address => mapping(address => bool)) private _operators;
    mapping(uint256 => address) private _wallets;
    bool public failReads;

    function setAgent(uint256 agentId, address owner, address wallet) external {
        _owners[agentId] = owner;
        _wallets[agentId] = wallet;
    }

    function setApproved(uint256 agentId, address approved) external {
        _approved[agentId] = approved;
    }

    function setApprovalForAll(address owner, address operator, bool approved) external {
        _operators[owner][operator] = approved;
    }

    function setAgentWallet(uint256 agentId, address wallet) external {
        _wallets[agentId] = wallet;
    }

    function setFailReads(bool fail) external {
        failReads = fail;
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        require(!failReads, "identity read failed");
        address owner = _owners[agentId];
        require(owner != address(0), "unknown agent");
        return owner;
    }

    function getApproved(uint256 agentId) external view returns (address) {
        require(!failReads, "identity read failed");
        require(_owners[agentId] != address(0), "unknown agent");
        return _approved[agentId];
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        require(!failReads, "identity read failed");
        return _operators[owner][operator];
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        require(!failReads, "identity read failed");
        return _wallets[agentId];
    }
}

contract MockERC8004ReputationRegistry {
    address private _identityRegistry;
    uint64 private _count;
    int128 private _summaryValue;
    uint8 private _summaryValueDecimals;
    bytes32 private _expectedClientsHash;
    bytes32 private _expectedTag1Hash;
    bytes32 private _expectedTag2Hash;
    uint256 private _expectedAgentId;
    bool private _enforceExpectedQuery;
    bool public failReads;

    constructor(address identityRegistry_) {
        _identityRegistry = identityRegistry_;
    }

    function setIdentityRegistry(address identityRegistry_) external {
        _identityRegistry = identityRegistry_;
    }

    function setSummary(uint64 count, int128 summaryValue, uint8 summaryValueDecimals) external {
        _count = count;
        _summaryValue = summaryValue;
        _summaryValueDecimals = summaryValueDecimals;
    }

    function setExpectedQuery(
        uint256 agentId,
        address[] calldata clients,
        string calldata tag1,
        string calldata tag2
    ) external {
        _expectedAgentId = agentId;
        _expectedClientsHash = keccak256(abi.encode(clients));
        _expectedTag1Hash = keccak256(bytes(tag1));
        _expectedTag2Hash = keccak256(bytes(tag2));
        _enforceExpectedQuery = true;
    }

    function setFailReads(bool fail) external {
        failReads = fail;
    }

    function getIdentityRegistry() external view returns (address) {
        require(!failReads, "reputation read failed");
        return _identityRegistry;
    }

    function getSummary(
        uint256 agentId,
        address[] calldata clients,
        string calldata tag1,
        string calldata tag2
    ) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals) {
        require(!failReads, "reputation read failed");
        if (_enforceExpectedQuery) {
            require(agentId == _expectedAgentId, "wrong agent");
            require(keccak256(abi.encode(clients)) == _expectedClientsHash, "wrong clients");
            require(keccak256(bytes(tag1)) == _expectedTag1Hash, "wrong tag1");
            require(keccak256(bytes(tag2)) == _expectedTag2Hash, "wrong tag2");
        }
        return (_count, _summaryValue, _summaryValueDecimals);
    }
}

contract MockERC8004ValidationRegistry {
    address private _identityRegistry;
    uint64 private _count;
    uint8 private _average;
    bytes32 private _expectedValidatorsHash;
    bytes32 private _expectedTagHash;
    uint256 private _expectedAgentId;
    bool private _enforceExpectedQuery;
    bool public failReads;

    constructor(address identityRegistry_) {
        _identityRegistry = identityRegistry_;
    }

    function setIdentityRegistry(address identityRegistry_) external {
        _identityRegistry = identityRegistry_;
    }

    function setSummary(uint64 count, uint8 average) external {
        _count = count;
        _average = average;
    }

    function setExpectedQuery(
        uint256 agentId,
        address[] calldata validators,
        string calldata tag
    ) external {
        _expectedAgentId = agentId;
        _expectedValidatorsHash = keccak256(abi.encode(validators));
        _expectedTagHash = keccak256(bytes(tag));
        _enforceExpectedQuery = true;
    }

    function setFailReads(bool fail) external {
        failReads = fail;
    }

    function getIdentityRegistry() external view returns (address) {
        require(!failReads, "validation read failed");
        return _identityRegistry;
    }

    function getSummary(
        uint256 agentId,
        address[] calldata validators,
        string calldata tag
    ) external view returns (uint64 count, uint8 avgResponse) {
        require(!failReads, "validation read failed");
        if (_enforceExpectedQuery) {
            require(agentId == _expectedAgentId, "wrong agent");
            require(keccak256(abi.encode(validators)) == _expectedValidatorsHash, "wrong validators");
            require(keccak256(bytes(tag)) == _expectedTagHash, "wrong tag");
        }
        return (_count, _average);
    }
}
