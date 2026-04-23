require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const FormData = require('form-data');
const express = require('express');
const mongoose = require('mongoose');

// Constants from environment variables
const {
    PORT,
    MONGODB_URI,
    BOT_TOKEN,
    TIKWM_API,
    TIKWM_USER_API,
    PING_INTERVAL,
    WEBHOOK_URL,
    DEFAULT_VIDEO_LIMIT
} = process.env;

// Initialize bot and express app
const bot = new TelegramBot(BOT_TOKEN, {polling: true});
const app = express();
const userQueues = {};

// MongoDB connection
mongoose.connect(MONGODB_URI);

// MongoDB schemas
const videoSchema = new mongoose.Schema({
    userName: String,
    userHandle: String,
    originalLink: String,
    processedLink: String,
    timestamp: {type: Date, default: Date.now}
});

const requestSchema = new mongoose.Schema({
    userName: String,
    userHandle: String,
    chatId: String,
    messageId: String,
    originalLink: String,
    status: {type: String, enum: ['pending', 'downloading', 'completed', 'error'], default: 'pending'},
    errorMessage: String,
    timestamp: {type: Date, default: Date.now}
});

const Video = mongoose.model('VideoDownload', videoSchema);
const Request = mongoose.model('DownloadRequest', requestSchema);

// API Routes
app.get('/ping', (req, res) => {
    console.log('Ping received');
    res.send('pong');
});

app.get('/', async (req, res) => {
    try {
        const videos = await Video.find().sort({timestamp: -1}).limit(100);
        const requests = await Request.find().sort({timestamp: -1}).limit(100);
        res.send(generateDashboardHTML(videos, requests));
    } catch (error) {
        res.status(500).send('Error fetching download history');
    }
});

// Video Processing Functions
async function processQueue(chatId) {
    if (userQueues[chatId]?.length > 0) {
        const request = userQueues[chatId][0];
        await processLink(request);
        userQueues[chatId].shift();
        processQueue(chatId);
    }
}

async function processLink(request) {
    try {
        await Request.findByIdAndUpdate(request._id, {status: 'downloading'});

        const formData = new FormData();
        formData.append('url', request.originalLink);
        formData.append('hd', '1');

        const response = await axios.post(TIKWM_API, formData, {
            headers: {
                ...formData.getHeaders(),
                'Content-Type': 'multipart/form-data'
            }
        });

        if (response.data.code === 0) {
            const videoUrl = response.data.data.play;
            const videoUrlhdplay = response.data.data.hdplay;

            await saveAndSendVideo(request, videoUrl, videoUrlhdplay);
        } else {
            await handleError(request, 'API error');
        }
    } catch (error) {
        console.error('Error:', error);
        await handleError(request, error.message);
    }
}

async function saveAndSendVideo(request, videoUrl, videoUrlhdplay) {
    // Save to MongoDB
    const video = new Video({
        userName: request.userName,
        userHandle: request.userHandle,
        originalLink: request.originalLink,
        processedLink: videoUrlhdplay
    });
    await video.save();

    // Update request status
    await Request.findByIdAndUpdate(request._id, {status: 'completed'});

    // Send video
    await sendVideoToTelegram(request, videoUrl, videoUrlhdplay);
}

async function sendVideoToTelegram(request, videoUrl, videoUrlhdplay) {
    try {
        // Try HD video first
        await sendVideo(request, videoUrlhdplay, true);
    } catch (error) {
        console.log('HD video failed, trying standard version...', error);
        try {
            // Try standard video
            await sendVideo(request, videoUrl, false);
        } catch (stdError) {
            console.log('Standard video failed, sending fallback link...', stdError);
            await bot.sendMessage(
                request.chatId.toString(), 
                `Không thể tải video, bạn có thể xem tại link: ${videoUrlhdplay}`
            );
        }
    }
}

async function sendVideo(request, videoUrl, isHD) {
    await bot.sendVideo(request.chatId.toString(), videoUrl, {
        reply_markup: {
            inline_keyboard: [[
                {text: 'Xem link gốc', url: request.originalLink},
                {text: `Xem link video ${isHD ? 'HD' : 'thường'}`, url: videoUrl}
            ]]
        }
    });
    await bot.deleteMessage(request.chatId.toString(), request.messageId.toString());
}

async function handleError(request, errorMessage) {
    await Request.findByIdAndUpdate(request._id, {
        status: 'error', 
        errorMessage: errorMessage
    });
    await bot.sendMessage(
        request.chatId.toString(), 
        `Có lỗi xảy ra khi xử lý link: ${request.originalLink}`
    );
}

// User Videos Processing
async function processUserVideos(chatId, username) {
    try {
        const formData = new FormData();
        formData.append('unique_id', encodeURIComponent(username));
        formData.append('count', DEFAULT_VIDEO_LIMIT);
        formData.append('hd', '1');

        await bot.sendMessage(chatId, `Đang tải tất cả video từ tài khoản: ${username}. Vui lòng chờ...`);

        const response = await axios.post(TIKWM_USER_API, formData, {
            headers: formData.getHeaders()
        });

        if (response.data.code === 0) {
            await processUserVideoList(chatId, username, response.data.data.videos);
        } else {
            await bot.sendMessage(chatId, `Không thể tải video từ tài khoản: ${username}`);
        }
    } catch (error) {
        console.error('Error fetching user videos:', error);
        await bot.sendMessage(chatId, `Có lỗi xảy ra khi tải video từ tài khoản: ${username}`);
    }
}

async function processUserVideoList(chatId, username, videos) {
    await bot.sendMessage(chatId, `Tìm thấy ${videos.length} video. Đang xử lý...`);

    // Reverse videos array to process from oldest to newest
    videos.reverse();

    for (let i = 0; i < videos.length; i++) {
        try {
            await sendUserVideo(chatId, username, videos[i]);
        } catch (error) {
            console.log(`Failed to send video ${i + 1}:`, error);
        }
    }

    await bot.sendMessage(chatId, `Đã gửi tất cả video từ tài khoản: ${username}`);
}

async function sendUserVideo(chatId, username, video) {
    await bot.sendVideo(chatId, video.play, {
        reply_markup: {
            inline_keyboard: [[
                {text: 'Xem link gốc', url: `https://www.tiktok.com/@${username}/video/${video.video_id}`}
            ]]
        }
    });
}

// Message Handler
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const messageText = msg.text;

    if (!messageText) {
        await bot.sendMessage(chatId, 'No text found in the message.');
        return;
    }

    const usernameMatch = messageText.match(/^u:(.+)$/);
    if (usernameMatch) {
        await processUserVideos(chatId, usernameMatch[1]);
        return;
    }

    const tiktokLinks = messageText.match(/https?:\/\/(?:www\.|vt\.)?tiktok\.com\/\S+/g);
    if (tiktokLinks?.length > 0) {
        await handleTiktokLinks(chatId, msg, tiktokLinks);
    } else {
        await bot.sendMessage(chatId, 'Vui lòng gửi một hoặc nhiều liên kết TikTok hợp lệ.');
    }
});

// Xử lý các link TikTok
async function handleTiktokLinks(chatId, msg, links) {
    const processingMessage = await bot.sendMessage(
        chatId,
        `Da them ${links.length} video vao hang doi. Dang xu ly...`
    );

    userQueues[chatId] = userQueues[chatId] || [];

    const userName = msg.from.first_name + (msg.from.last_name ? ' ' + msg.from.last_name : '');
    const userHandle = msg.from.username || 'N/A';

    for (const link of links) {
        const request = new Request({
            userName,
            userHandle,
            chatId: chatId.toString(),
            messageId: msg.message_id.toString(),
            originalLink: link
        });
        await request.save();
        userQueues[chatId].push(request);
    }

    if (userQueues[chatId].length === links.length) {
        processQueue(chatId);
    }

    setTimeout(() => {
        bot.deleteMessage(chatId, processingMessage.message_id)
            .catch(error => console.error('Error deleting processing message:', error));
    }, 5000);
}

// Dashboard HTML
function generateDashboardHTML(videos, requests) {
    const requestRows = requests.map(r => `
        <tr>
            <td>${r.userName}</td>
            <td>${r.userHandle}</td>
            <td><a href="${r.originalLink}" target="_blank">Original</a></td>
            <td>${r.status}</td>
            <td>${r.timestamp.toLocaleString()}</td>
        </tr>
    `).join('');

    const videoRows = videos.map(v => `
        <tr>
            <td>${v.userName}</td>
            <td>${v.userHandle}</td>
            <td><a href="${v.originalLink}" target="_blank">Original</a></td>
            <td><a href="${v.processedLink}" target="_blank">Processed</a></td>
            <td>${v.timestamp.toLocaleString()}</td>
        </tr>
    `).join('');

    return `
        <html>
            <head>
                <title>TikTok Download Dashboard</title>
                <style>
                    body { font-family: Arial, sans-serif; margin: 0; padding: 20px; }
                    table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
                    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
                    th { background-color: #f2f2f2; }
                    h2 { margin-top: 30px; }
                </style>
            </head>
            <body>
                <h1>TikTok Download Dashboard</h1>
                <h2>Download Requests</h2>
                <table>
                    <tr><th>User Name</th><th>User Handle</th><th>Original Link</th><th>Status</th><th>Timestamp</th></tr>
                    ${requestRows}
                </table>
                <h2>Completed Downloads</h2>
                <table>
                    <tr><th>User Name</th><th>User Handle</th><th>Original Link</th><th>Processed Link</th><th>Timestamp</th></tr>
                    ${videoRows}
                </table>
            </body>
        </html>
    `;
}

// Keep-alive ping
async function pingApp(url) {
    try {
        await axios.get(url);
    } catch (error) {
        console.error('Ping failed:', error.message);
    }
}

// Start server and keep-alive ping
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

setInterval(() => pingApp(WEBHOOK_URL), PING_INTERVAL);
console.log('Bot is running...');
console.log('Worker started');
