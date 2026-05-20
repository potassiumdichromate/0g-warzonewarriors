const mongoose = require("mongoose");

module.exports = async () => {
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: true });
  console.log("✅ MongoDB Connected");

  try {
    await mongoose.connection.collection("playersaverecords").dropIndex("rootHash_1");
    console.log("[DB] Dropped legacy rootHash_1 unique index");
  } catch (e) {
    // Index doesn't exist — already dropped or never created, ignore
  }
};
