const mongoose = require('mongoose');

const memeSchema = new mongoose.Schema({
  fileId: String,
  data: Buffer,
  contentType: String
});

module.exports = mongoose.model('Meme', memeSchema);
