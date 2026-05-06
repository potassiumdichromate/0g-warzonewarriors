const mongoose = require('mongoose');

const IAPPurchaseSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true, unique: true },
    orderHash: { type: String, required: true, unique: true },
    walletAddress: { type: String, required: true, index: true },
    txHash: { type: String, required: true, unique: true },
    category: { type: String, required: true },
    product: { type: String, required: true },
    priceEth: { type: String, required: true },
    priceWei: { type: String, required: true },
    price: { type: Number, required: true },
    delivered: { type: Boolean, default: true },
    chainId: { type: Number },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

module.exports =
  mongoose.models.WarzoneIAPPurchase ||
  mongoose.model('WarzoneIAPPurchase', IAPPurchaseSchema);
