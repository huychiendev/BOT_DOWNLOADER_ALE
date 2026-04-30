require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const express = require('express');
const mongoose = require('mongoose');

// Constants from environment variables
const {
    PORT,
    MONGODB_URI,
    BOT_TOKEN,
    API_ENDPOINT,
    PING_INTERVAL,
    WEBHOOK_URL
} = process.env;

// Initialize bot and express app
const bot = new TelegramBot(BOT_TOKEN, {polling: true});
const app = express();
const userQueues = {};

// MongoDB connection
mongoose.connect(MONGODB_URI);

// Define MongoDB schemas
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

// New API endpoint for video data
app.get('/api/hybrid/video_data', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    try {
        const response = await axios.get(`${API_ENDPOINT}?url=${encodeURIComponent(url)}`);
        res.json(response.data);
    } catch (error) {
        console.error('Error fetching video data:', error);
        res.status(500).json({ error: 'Failed to fetch video data' });
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

        const response = await axios.get(`${API_ENDPOINT}?url=${encodeURIComponent(request.originalLink)}`);

        if (response.status === 200) {
            const videoData = response.data;

            if (videoData.code === 200 || videoData.code === 0) {
                // Lấy URL video từ cấu trúc dữ liệu phù hợp
                let videoUrl, hdVideoUrl;

                if (videoData.code === 0 && videoData.data) {
                    // Cấu trúc cho TikWM
                    const base = 'https://www.tikwm.com';
                    videoUrl = videoData.data.play;
                    hdVideoUrl = videoData.data.hdplay;
                    
                    if (videoUrl && !videoUrl.startsWith('http')) videoUrl = base + videoUrl;
                    if (hdVideoUrl && !hdVideoUrl.startsWith('http')) hdVideoUrl = base + hdVideoUrl;
                } else if (videoData.data?.video?.play_addr?.url_list) {
                    // Cấu trúc cho Douyin
                    videoUrl = videoData.data.video.play_addr.url_list[0];
                    hdVideoUrl = videoData.data.video.hd_play_addr?.url_list?.[0];
                } else if (videoData.data?.aweme_detail?.video?.play_addr?.url_list) {
                    // Cấu trúc cho TikTok
                    videoUrl = videoData.data.aweme_detail.video.play_addr.url_list[0];
                    hdVideoUrl = videoData.data.aweme_detail.video.hd_play_addr?.url_list?.[0];
                } else if (videoData.data?.play_addr?.url_list) {
                    // Cấu trúc thay thế
                    videoUrl = videoData.data.play_addr.url_list[0];
                    hdVideoUrl = videoData.data.hd_play_addr?.url_list?.[0];
                } else {
                    throw new Error('Không tìm thấy URL video trong dữ liệu');
                }

                // Sử dụng URL HD nếu có, nếu không thì dùng URL thường
                const finalVideoUrl = hdVideoUrl || videoUrl;

                // Lưu vào MongoDB
                const video = new Video({
                    userName: request.userName,
                    userHandle: request.userHandle,
                    originalLink: request.originalLink,
                    processedLink: finalVideoUrl
                });
                await video.save();

                await Request.findByIdAndUpdate(request._id, {status: 'completed'});

                // Gửi video qua Telegram
                await sendVideoToTelegram(request, finalVideoUrl, videoUrl);
            } else {
                await handleApiError(request, videoData);
            }
        } else {
            await handleApiError(request, { message: 'Lỗi không xác định từ API' });
        }
    } catch (error) {
        console.error('Error processing link:', error);
        await Request.findByIdAndUpdate(request._id, {
            status: 'error', 
            errorMessage: error.message
        });
        await bot.sendMessage(request.chatId, 
            `Có lỗi xảy ra khi xử lý link: ${request.originalLink}`
        );
    }
}

// Hàm xử lý lỗi từ API
async function handleApiError(request, videoData) {
    const errorMessage = videoData.detail?.message || 'Có lỗi xảy ra. Vui lòng kiểm tra lại link.';
    await Request.findByIdAndUpdate(request._id, {
        status: 'error', 
        errorMessage: errorMessage
    });
    await bot.sendMessage(request.chatId, 
        `Lỗi: ${errorMessage}. Vui lòng gửi đúng link TikTok hoặc Douyin.`
    );
}

async function sendVideoToTelegram(request, hdVideoUrl, standardVideoUrl) {
    try {
        // Thử gửi video HD
        await bot.sendVideo(request.chatId, hdVideoUrl, {
            reply_markup: {
                inline_keyboard: [[
                    {text: 'Xem link gốc', url: request.originalLink},
                    {text: 'Xem link video HD', url: hdVideoUrl}
                ]]
            }
        });
    } catch (error) {
        // Nếu thất bại, thử gửi video chuẩn
        await bot.sendVideo(request.chatId, standardVideoUrl, {
            reply_markup: {
                inline_keyboard: [[
                    {text: 'Xem link gốc', url: request.originalLink},
                    {text: 'Xem link video thường', url: standardVideoUrl}
                ]]
            }
        });
    }
    await bot.deleteMessage(request.chatId, request.messageId);
}

// Bot Message Handler
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const messageText = msg.text;

    if (!messageText) {
        await bot.sendMessage(chatId, 'No text found in the message.');
        return;
    }

    const links = messageText.match(/https?:\/\/(?:www\.|vt\.|v\.)?(tiktok\.com|douyin\.com)\/\S+/g);
    if (links?.length > 0) {
        await handleLinks(chatId, msg, links);
    } else {
        await bot.sendMessage(chatId, 'Vui lòng gửi một hoặc nhiều liên kết TikTok hoặc Douyin hợp lệ nha.');
    }
});

// Hàm xử lý các link
async function handleLinks(chatId, msg, links) {
    const processingMessage = await bot.sendMessage(
        chatId, 
        `Đã thêm ${links.length} video vào hàng đợi. Đang xử lý...`
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

// Helper Functions
function generateDashboardHTML(videos, requests) {
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
                    <tr>
                        <th>User Name</th>
                        <th>User Handle</th>
                        <th>Original Link</th>
                        <th>Status</th>
                        <th>Timestamp</th>
                    </tr>
                    ${requests.map(request => `
                        <tr>
                            <td>${request.userName}</td>
                            <td>${request.userHandle}</td>
                            <td><a href="${request.originalLink}" target="_blank">Original</a></td>
                            <td>${request.status}</td>
                            <td>${request.timestamp.toLocaleString()}</td>
                        </tr>
                    `).join('')}
                </table>

                <h2>Completed Downloads</h2>
                <table>
                    <tr>
                        <th>User Name</th>
                        <th>User Handle</th>
                        <th>Original Link</th>
                        <th>Processed Link</th>
                        <th>Timestamp</th>
                    </tr>
                    ${videos.map(video => `
                        <tr>
                            <td>${video.userName}</td>
                            <td>${video.userHandle}</td>
                            <td><a href="${video.originalLink}" target="_blank">Original</a></td>
                            <td><a href="${video.processedLink}" target="_blank">Processed</a></td>
                            <td>${video.timestamp.toLocaleString()}</td>
                        </tr>
                    `).join('')}
                </table>
            </body>
        </html>
    `;
}

// Start server and keep-alive ping
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

// Keep-alive ping
async function pingApp(url) {
    try {
        const response = await axios.get(url);
        console.log('Ping successful:', response.data);
    } catch (error) {
        console.error('Ping failed:', error.message);
    }
}

setInterval(() => pingApp(WEBHOOK_URL), PING_INTERVAL);
console.log('Worker started');
