const { ethers } = require("ethers");
require("dotenv").config();

const CONTRACT_ADDRESS = process.env.SESSION_CONTRACT_ADDRESS;

const ABI = [
  "function saveSession(address _player, uint256 _coins, uint256 _bestScore) external",
  "function getPlayerSessions(address _player) external view returns (tuple(address player, uint256 coins, uint256 bestScore, uint256 timestamp)[])",
  "function getLatestSession(address _player) external view returns (tuple(address player, uint256 coins, uint256 bestScore, uint256 timestamp))",
  "function sessionCount(address _player) external view returns (uint256)",
  "function totalSessions() external view returns (uint256)",
  "function owner() external view returns (address)",
  "event SessionSaved(address indexed player, uint256 coins, uint256 bestScore, uint256 timestamp, uint256 sessionId)"
];

class SessionService {
  constructor() {
    this.initialized = false;
    this.provider = null;
    this.wallet   = null;
    this.contract = null;
  }

  async initialize() {
    if (this.initialized) return { success: true };

    try {
      this.provider = new ethers.JsonRpcProvider(
        process.env.OG_MAINNET_RPC || "https://evmrpc.0g.ai"
      );
      this.wallet   = new ethers.Wallet(process.env.PRIVATE_KEY, this.provider);
      this.contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, this.wallet);
      this.initialized = true;

      console.log("🔗 Connected to 0G Mainnet (sessions)");
      console.log("📍 Contract Address:", CONTRACT_ADDRESS);
      console.log("👤 Operator Address:", this.wallet.address);

      return { success: true };
    } catch (error) {
      console.error("❌ Failed to initialize session service:", error);
      return { success: false, error: error.message };
    }
  }

  async saveSessionOnChain(playerAddress, coins, bestScore) {
    try {
      if (!this.initialized) {
        const r = await this.initialize();
        if (!r.success) throw new Error(r.error);
      }

      const gasEstimate = await this.contract.saveSession.estimateGas(playerAddress, coins, bestScore);
      const tx = await this.contract.saveSession(
        playerAddress, coins, bestScore,
        { gasLimit: gasEstimate * 120n / 100n }
      );
      const receipt = await tx.wait();

      return {
        success: true,
        txHash: tx.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        explorerUrl: `https://chainscan.0g.ai/tx/${tx.hash}`
      };
    } catch (error) {
      console.error("❌ Blockchain session save error:", error.message);
      return { success: false, error: error.message };
    }
  }

  async getPlayerSessions(playerAddress) {
    try {
      if (!this.initialized) {
        const r = await this.initialize();
        if (!r.success) return [];
      }
      const sessions = await this.contract.getPlayerSessions(playerAddress);
      return sessions.map(s => ({
        player:    s.player,
        coins:     Number(s.coins),
        bestScore: Number(s.bestScore),
        timestamp: Number(s.timestamp),
        date:      new Date(Number(s.timestamp) * 1000).toISOString()
      }));
    } catch (error) {
      return [];
    }
  }

  async getLatestSession(playerAddress) {
    try {
      if (!this.initialized) {
        const r = await this.initialize();
        if (!r.success) return null;
      }
      const s = await this.contract.getLatestSession(playerAddress);
      return {
        player:    s.player,
        coins:     Number(s.coins),
        bestScore: Number(s.bestScore),
        timestamp: Number(s.timestamp),
        date:      new Date(Number(s.timestamp) * 1000).toISOString()
      };
    } catch (error) {
      return null;
    }
  }

  async getSessionCount(playerAddress) {
    try {
      if (!this.initialized) {
        const r = await this.initialize();
        if (!r.success) return 0;
      }
      return Number(await this.contract.sessionCount(playerAddress));
    } catch { return 0; }
  }

  async getTotalSessions() {
    try {
      if (!this.initialized) {
        const r = await this.initialize();
        if (!r.success) return 0;
      }
      return Number(await this.contract.totalSessions());
    } catch { return 0; }
  }

  async getOwner() {
    try {
      if (!this.initialized) {
        const r = await this.initialize();
        if (!r.success) return null;
      }
      return await this.contract.owner();
    } catch { return null; }
  }

  async healthCheck() {
    try {
      if (!this.initialized) {
        const r = await this.initialize();
        if (!r.success) throw new Error(r.error);
      }
      const balance      = await this.provider.getBalance(this.wallet.address);
      const totalSessions = await this.getTotalSessions();
      const owner        = await this.getOwner();
      return {
        healthy: true,
        wallet: this.wallet.address,
        balance: ethers.formatEther(balance),
        contractAddress: CONTRACT_ADDRESS,
        totalSessions: totalSessions.toString(),
        contractOwner: owner,
        network: "0G Mainnet",
        explorerUrl: `https://chainscan.0g.ai/address/${CONTRACT_ADDRESS}`
      };
    } catch (error) {
      return { healthy: false, error: error.message };
    }
  }

  isReady() {
    return this.initialized && !!this.contract && !!this.wallet && !!this.provider;
  }

  getContractInfo() {
    return {
      address: CONTRACT_ADDRESS,
      network: "0G Mainnet",
      explorerUrl: `https://chainscan.0g.ai/address/${CONTRACT_ADDRESS}`,
      rpcUrl: this.provider?._getConnection?.().url || "https://evmrpc.0g.ai"
    };
  }
}

module.exports = new SessionService();
