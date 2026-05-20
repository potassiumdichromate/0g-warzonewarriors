const { ethers } = require("ethers");
require("dotenv").config();

const CONTRACT_ADDRESS = process.env.LEADERBOARD_CONTRACT_ADDRESS;

const ABI = [
  "function saveLeaderboard(address _requestedBy, address _userWallet, uint256 _userScore, uint256 _userStanding, address[] memory _topPlayerAddresses, uint256[] memory _topPlayerScores, uint256[] memory _topPlayerStandings) external",
  "function getSnapshot(uint256 _snapshotId) external view returns (uint256 snapshotId, uint256 timestamp, address requestedBy, tuple(address player, uint256 bestScore, uint256 standing, uint256 timestamp) userEntry, address firstPlace, address secondPlace, address thirdPlace)",
  "function getSnapshotTopPlayers(uint256 _snapshotId) external view returns (tuple(address player, uint256 bestScore, uint256 standing, uint256 timestamp)[])",
  "function getPlayerSnapshots(address _player) external view returns (uint256[])",
  "function getLatestSnapshot() external view returns (uint256 snapshotId, uint256 timestamp, address requestedBy, tuple(address player, uint256 bestScore, uint256 standing, uint256 timestamp) userEntry, address firstPlace, address secondPlace, address thirdPlace)",
  "function getLatestTop3() external view returns (address, address, address)",
  "function totalSnapshots() external view returns (uint256)",
  "function owner() external view returns (address)"
];

class LeaderboardService {
  constructor() {
    this.provider = null;
    this.wallet   = null;
    this.contract = null;
    this.initialized = false;
  }

  _init() {
    if (this.initialized) return;
    const key = process.env.PRIVATE_KEY;
    if (!key || key.startsWith("0xyour-")) {
      console.warn("⚠️  LeaderboardService: PRIVATE_KEY not set — leaderboard writes disabled");
      return;
    }
    this.provider = new ethers.JsonRpcProvider(
      process.env.OG_MAINNET_RPC || "https://evmrpc.0g.ai",
      { chainId: 16661, name: "0g-mainnet" }
    );
    this.wallet   = new ethers.Wallet(key, this.provider);
    this.contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, this.wallet);
    this.initialized = true;
    console.log("🏆 Leaderboard Service Connected");
    console.log("📍 Contract:", CONTRACT_ADDRESS);
  }

  async saveLeaderboardOnChain(requestedBy, userWallet, leaderboardData) {
    this._init();
    if (!this.contract) return { success: false, error: "PRIVATE_KEY not configured" };
    try {
      const { userScore, userStanding, topPlayers } = leaderboardData;

      const topPlayerAddresses = topPlayers.slice(0, 10).map(p => p.walletAddress);
      const topPlayerScores    = topPlayers.slice(0, 10).map(p => p.highScore);
      const topPlayerStandings = topPlayers.slice(0, 10).map((_, i) => i + 1);

      const gasEstimate = await this.contract.saveLeaderboard.estimateGas(
        requestedBy, userWallet, userScore, userStanding,
        topPlayerAddresses, topPlayerScores, topPlayerStandings
      );

      const tx = await this.contract.saveLeaderboard(
        requestedBy, userWallet, userScore, userStanding,
        topPlayerAddresses, topPlayerScores, topPlayerStandings,
        { gasLimit: gasEstimate * 120n / 100n }
      );

      const receipt = await tx.wait();
      return {
        success: true,
        txHash: tx.hash,
        blockNumber: receipt.blockNumber,
        explorerUrl: `https://chainscan.0g.ai/tx/${tx.hash}`
      };
    } catch (error) {
      console.error("❌ Blockchain leaderboard save error:", error.message);
      return { success: false, error: error.message };
    }
  }

  async getSnapshot(snapshotId) {
    this._init();
    if (!this.contract) return null;
    try {
      const snapshot   = await this.contract.getSnapshot(snapshotId);
      const topPlayers = await this.contract.getSnapshotTopPlayers(snapshotId);
      return {
        snapshotId: Number(snapshot.snapshotId),
        timestamp:  Number(snapshot.timestamp),
        requestedBy: snapshot.requestedBy,
        userEntry: {
          player:    snapshot.userEntry.player,
          bestScore: Number(snapshot.userEntry.bestScore),
          standing:  Number(snapshot.userEntry.standing),
          timestamp: Number(snapshot.userEntry.timestamp)
        },
        top3: {
          first:  snapshot.firstPlace,
          second: snapshot.secondPlace,
          third:  snapshot.thirdPlace
        },
        topPlayers: topPlayers.map(p => ({
          player:    p.player,
          bestScore: Number(p.bestScore),
          standing:  Number(p.standing),
          timestamp: Number(p.timestamp)
        }))
      };
    } catch { return null; }
  }

  async getLatestSnapshot() {
    this._init();
    if (!this.contract) return null;
    try {
      const snapshot = await this.contract.getLatestSnapshot();
      return await this.getSnapshot(Number(snapshot.snapshotId));
    } catch { return null; }
  }

  async getPlayerSnapshots(playerAddress) {
    this._init();
    if (!this.contract) return [];
    try {
      const ids = await this.contract.getPlayerSnapshots(playerAddress);
      return ids.map(id => Number(id));
    } catch { return []; }
  }

  async getTotalSnapshots() {
    this._init();
    if (!this.contract) return 0;
    try {
      return Number(await this.contract.totalSnapshots());
    } catch { return 0; }
  }

  async getLatestTop3() {
    this._init();
    if (!this.contract) return { first: null, second: null, third: null };
    try {
      const [first, second, third] = await this.contract.getLatestTop3();
      return { first, second, third };
    } catch { return { first: null, second: null, third: null }; }
  }

  isReady() {
    this._init();
    return !!CONTRACT_ADDRESS && !!this.wallet && !!this.provider;
  }

  getContractInfo() {
    return {
      address: CONTRACT_ADDRESS,
      network: "0G Mainnet",
      chainId: 16661,
      explorerUrl: `https://chainscan.0g.ai/address/${CONTRACT_ADDRESS}`,
      rpcUrl: this.provider?._getConnection?.().url || process.env.OG_MAINNET_RPC || "https://evmrpc.0g.ai"
    };
  }
}

module.exports = new LeaderboardService();
