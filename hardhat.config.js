require("dotenv").config();
require("@nomicfoundation/hardhat-ethers");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: { enabled: true, runs: 200 }
    }
  },
  networks: {
    "0g-mainnet": {
      url:      process.env.OG_MAINNET_RPC || "https://evmrpc.0g.ai",
      chainId:  16661,
      accounts: process.env.ZG_PRIVATE_KEY ? [process.env.ZG_PRIVATE_KEY] : []
    },
    "0g-newton": {
      url:      process.env.ZG_RPC_URL || "https://evmrpc.0g.ai",
      chainId:  16600,
      accounts: process.env.ZG_PRIVATE_KEY ? [process.env.ZG_PRIVATE_KEY] : []
    }
  }
};
