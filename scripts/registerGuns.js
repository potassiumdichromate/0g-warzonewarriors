require('dotenv').config();
const { ethers } = require('ethers');
const abi = require('../shared/WarzoneInAppPurchase.json');

// --- Validate ENV ---
const {
  IAP_RPC_URL,
  OWNER_PRIVATE_KEY,
  IAP_CONTRACT_ADDRESS
} = process.env;

if (!IAP_RPC_URL) {
  throw new Error("❌ IAP_RPC_URL is missing in .env");
}

if (!OWNER_PRIVATE_KEY) {
  throw new Error("❌ OWNER_PRIVATE_KEY is missing in .env");
}

if (!IAP_CONTRACT_ADDRESS) {
  throw new Error("❌ IAP_CONTRACT_ADDRESS is missing in .env");
}

// --- Setup ---
const provider = new ethers.providers.JsonRpcProvider(IAP_RPC_URL);
const signer = new ethers.Wallet(OWNER_PRIVATE_KEY, provider);
const contract = new ethers.Contract(IAP_CONTRACT_ADDRESS, abi, signer);

// --- Data ---
const guns = [
  { name: 'Spread',        price: '5'  },
  { name: 'Chaser',        price: '6'  },
  { name: 'Famas',         price: '7'  },
  { name: 'Laser',         price: '8'  },
  { name: 'Split',         price: '9'  },
  { name: 'Fireball',      price: '10' },
  { name: 'Tesla',         price: '12' },
  { name: 'Kame Power',    price: '13' },
  { name: 'Flame Thrower', price: '15' },
];

// --- Main Execution ---
(async () => {
  try {
    console.log("🚀 Starting gun registration...\n");

    for (const gun of guns) {
      try {
        const priceWei = ethers.utils.parseEther(gun.price);

        console.log(`⏳ Registering ${gun.name}...`);

        const tx = await contract.setProduct(
          'Guns',
          gun.name,
          priceWei,
          true
        );

        console.log(`📤 Tx sent: ${tx.hash}`);

        await tx.wait();

        console.log(`✅ Registered: ${gun.name} @ ${gun.price} SOMI\n`);

      } catch (err) {
        console.error(`❌ Failed for ${gun.name}:`, err.message);
      }
    }

    console.log("🎉 All done!");
    process.exit(0);

  } catch (error) {
    console.error("🔥 Fatal error:", error);
    process.exit(1);
  }
})();