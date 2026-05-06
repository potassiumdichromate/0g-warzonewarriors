const mongoose = require('mongoose');

const nameCounterSchema = new mongoose.Schema({
  _id: { type: String, default: 'default' },
  seq: { type: Number, default: 0 }
});

const NameCounter = mongoose.model('NameCounter', nameCounterSchema);

// Initialize the counter if it doesn't exist
const initializeCounter = async () => {
  const counter = await NameCounter.findById('default');
  if (!counter) {
    await NameCounter.create({ _id: 'default', seq: 0 });
  }
};

initializeCounter();

module.exports = NameCounter;
