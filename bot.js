require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const Meme = require("./memeSchema");
const crypto = require("crypto");
const axios = require("axios");
const { error } = require("console");

// Connect to MongoDB
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.log(err));

// In-memory store for the mappings and targetChannelId -> (for forwarding memes)
const callbackDataStore = {};
let targetChannelId = process.env.CHANNEL_ID

// Define a map to store the state for each chat
const chatStates = new Map();

// Function to hash the original data
function hashData(data) {
  return crypto.createHash("md5").update(data).digest("hex");
}

// Function to store the mapping
function storeCallbackData(hash, data) {
  callbackDataStore[hash] = data;
}
 
// Create a bot instance
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
let botUsername;

// Get bot's username
bot.getMe().then((me) => {
  botUsername = me.username;
});

// Listen for callback queries
bot.on("callback_query", async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const hashedMediaId = callbackQuery.data;

  // Retrieve the original data using the hash
  const originalFileId = callbackDataStore[hashedMediaId];

  let newMessageText;

  if (originalFileId) {
    try {
      let buffer, contentType;

      // Get the file path from Telegram API
      const file = await bot.getFile(originalFileId);
      const filePath = file.file_path;

      // Construct the complete URL for downloading the file
      const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`;

      // Fetch the file data using axios
      const response = await axios.get(url, { responseType: "arraybuffer", headers: { Accept: 'image/*, video/*' } });

      // Check if the response contains data
      if (response.data) {
        buffer = Buffer.from(response.data, "binary");

        if (filePath.startsWith("photos/")) {
          contentType = 'image/jpeg';
        } else if (filePath.startsWith("animations/")) {
          contentType = 'video/mp4'; 
        } else if (filePath.startsWith("videos/")) {
          contentType = 'video/mp4';
        } else {
          throw error;
        }

        // Save the media to MongoDB
        const newMedia = new Meme({
          fileId: originalFileId,
          data: buffer,
          contentType: contentType, 
        });
        await newMedia.save();

        newMessageText = "You have approved this media.";
      } else {
        throw new Error("Failed to fetch file data from Telegram.");
      }
    } catch (error) {
      // Send error message to admin
      bot.sendMessage(chatId, `Error: ${error.message}`);
    }
  } else {
    newMessageText = "You have rejected this media.";
  }

  // Edit the message text to display the approval or rejection
  bot.editMessageText(newMessageText, {
    chat_id: callbackQuery.message.chat.id,
    message_id: callbackQuery.message.message_id,
  }).catch(error => {
    // Send error message to admin
    bot.sendMessage(chatId, `Error updating message text: ${error.message}`);
  });
});

// Listen for channel updates
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userKey = `${chatId}-${userId}`; // Unique key for each user in each chat

  // Get the state for the current chat and user
  const userStates = chatStates.get(chatId) || new Map();
  const currentState = userStates.get(userId);

  // Check if the bot is in the "awaitingImage" state
  if (currentState === "awaitingImage") {
    // Check if the message is a photo
    if (msg.photo || msg.video || msg.animation) {
      // Clear the "afk" timer for this user if it exists
      const afkTimer = userStates.get(`${userKey}-timer`);
      if (afkTimer) {
        clearTimeout(afkTimer);
        userStates.delete(`${userKey}-timer`);
      }
      try {
        if (targetChannelId) {
          // Determine fileId
          let fileId;
          if (msg.photo) {
            fileId = msg.photo[msg.photo.length - 1].file_id; // Get the highest resolution photo
          } else if (msg.video) {
            fileId = msg.video.file_id;
          } else if (msg.animation) {
            fileId = msg.animation.file_id;
          }
    
          // Hash the fileId
          const hashedFileId = hashData(fileId);
          // Store the mapping
          storeCallbackData(hashedFileId, fileId);
    
          // Determine the forward method based on the content type
          const forwardMethod = msg.photo
            ? 'forwardMessage' // Forward photo
            : msg.video
            ? 'sendVideo' // Forward video
            : msg.animation
            ? 'sendAnimation' // Forward animation (GIF)
            : null;
    
          if (forwardMethod) {
            // Forward the media to the target channel
            if (forwardMethod === 'forwardMessage') {
              await bot.forwardMessage(targetChannelId, msg.chat.id, msg.message_id)
          } else {
              // If it's not a photo, you need to provide the chat ID of the message's origin
              await bot[forwardMethod](targetChannelId, fileId);
          }
    
            // Markup with buttons
            const replyMarkup = {
              inline_keyboard: [
                [
                  { text: "Approve", callback_data: `${hashedFileId}` },
                  { text: "Reject", callback_data: `Rejected` },
                ],
              ],
            };
    
            // Send the markup to admin's DM
            bot.sendMessage(targetChannelId, "Approve this meme?", {
              reply_markup: replyMarkup,
            });
    
            // Notify the user that the media has been forwarded to the admin
            bot.sendMessage(chatId, "Your media has been forwarded to the admin for approval.");
          } else {
            bot.sendMessage(chatId, "Unsupported media type.");
          }
        } else {
          bot.sendMessage(chatId,"An error occurred while forwarding the media to the admin.");
        }
      } catch (error) {
        bot.sendMessage(chatId,`An error occurred while forwarding the media to the admin. ${error}`);
      }
    
      // Clear user states
      userStates.delete(userId);
      if (userStates.size === 0) {
        chatStates.delete(chatId);
      } else {
        chatStates.set(chatId, userStates);
      }
    } else {
      // Handle cases where the message is not an image
      bot.sendMessage(chatId, "Please send a meme.");
    }
  } else {
    // Check if the bot's username is mentioned in the message text
    if (msg.text && msg.text.includes(`@${botUsername}`)) {
      // Check if the bot is not currently awaiting an image in this chat
      if (!currentState || currentState !== "awaitingImage") {
        // Switch bot to "awaitingImage" state for the current user in this chat
        userStates.set(userId, "awaitingImage");
        chatStates.set(chatId, userStates);

        bot.sendMessage(chatId, "Please send a meme.");

        // Set an "afk" timer for 45 seconds
        const afkTimer = setTimeout(() => {
          // Reset bot state for the current user in this chat
          userStates.delete(userId);
          if (userStates.size === 0) {
            chatStates.delete(chatId);
          } else {
            chatStates.set(chatId, userStates);
          }

          // Inform the user that the timer expired and the state is reset
          bot.sendMessage(
            chatId,
            `${msg.from.first_name} took too long to send an image. The conversation has ended.`
          );
        }, 45000);

        // Store the timer ID for the current user
        userStates.set(`${userKey}-timer`, afkTimer);
      }
    }
  }
});