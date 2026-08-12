require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const FormData = require('form-data');
const express = require('express');
const mongoose = require('mongoose');

const {
    PORT,
    MONGODB_URI,
    BOT_TOKEN,
    TIKWM_API,
    TIKWMAPI_BASE,
    TIKWMAPI_KEY,
    PING_INTERVAL,
    WEBHOOK_URL
} = process.env;

const bot = new TelegramBot(BOT_TOKEN, {polling: true});
const app = express();
const userQueues = {};

mongoose.connect(MONGODB_URI);

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

const BASE = 'https://www.tikwm.com';
const MAX_VIDEO_SIZE = 45 * 1024 * 1024;

app.get('/ping', (req, res) => { console.log('Ping received'); res.send('pong'); });
app.get('/', async (req, res) => {
    try {
        const videos = await Video.find().sort({timestamp: -1}).limit(100);
        const requests = await Request.find().sort({timestamp: -1}).limit(100);
        res.send(generateDashboardHTML(videos, requests));
    } catch (error) {
        res.status(500).send('Error fetching download history');
    }
});

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
        formData.append('web', '1');

        const response = await axios.post(TIKWM_API, formData, { headers: formData.getHeaders() });

        if (response.data.code === 0) {
            const data = response.data.data;

            let hdPath = (data.hdplay || '').replace(/\\\//g, '/');
            let normalPath = (data.play || '').replace(/\\\//g, '/');

            console.log('[DEBUG] hdplay cleaned:', hdPath);
            console.log('[DEBUG] hd_size:', data.hd_size);

            let finalUrl = null;
            let isHD = false;

            if (hdPath) {
                finalUrl = BASE + hdPath;
                isHD = true;
            } else if (normalPath) {
                finalUrl = BASE + normalPath;
                isHD = false;
            }

            const hdSize = Number(data.hd_size) || 0;
            if (isHD && hdSize > MAX_VIDEO_SIZE) {
                finalUrl = BASE + normalPath;
                isHD = false;
            }

            if (finalUrl) {
                await saveAndSendVideo(request, finalUrl, isHD);
            } else {
                await handleError(request, 'Không tìm thấy link');
            }
        } else {
            await handleError(request, 'API error');
        }
    } catch (error) {
        console.error('Error:', error);
        await handleError(request, error.message);
    }
}

async function saveAndSendVideo(request, finalUrl, isHD) {
    const video = new Video({
        userName: request.userName,
        userHandle: request.userHandle,
        originalLink: request.originalLink,
        processedLink: finalUrl
    });
    await video.save();
    await Request.findByIdAndUpdate(request._id, {status: 'completed'});
    await sendVideoToTelegram(request, finalUrl, isHD);
}

async function sendVideoToTelegram(request, finalUrl, isHD) {
    try {
        await bot.sendDocument(request.chatId.toString(), finalUrl, {
            reply_markup: {
                inline_keyboard: [[
                    {text: 'Xem link gốc', url: request.originalLink},
                    {text: `Link HD`, url: finalUrl}
                ]]
            }
        });
        await bot.deleteMessage(request.chatId.toString(), request.messageId.toString());
    } catch (error) {
        await bot.sendMessage(request.chatId.toString(), 
            `Video HD: ${finalUrl}\nGốc: ${request.originalLink}`);
    }
}

async function handleError(request, errorMessage) {
    await Request.findByIdAndUpdate(request._id, {status: 'error', errorMessage});
    await bot.sendMessage(request.chatId.toString(), `Có lỗi khi xử lý link: ${request.originalLink}`);
}

// User videos via tikwmapi.com (API key auth + cursor pagination)
async function processUserVideos(chatId, username) {
    try {
        const statusMsg = await bot.sendMessage(chatId, `Đang tải video từ: ${username}...`);
        const allVideos = [];
        let cursor = 0;
        let page = 1;

        while (true) {
            const { data } = await axios.get(`${TIKWMAPI_BASE}/user/posts`, {
                headers: { 'x-tikwmapi-key': TIKWMAPI_KEY },
                params: { unique_id: username, count: 30, cursor }
            });

            if (data.code !== 0 || !data.data?.videos?.length) break;

            allVideos.push(...data.data.videos);
            console.log(`[USER] ${username} - page ${page}, got ${data.data.videos.length}, total: ${allVideos.length}`);

            if (!data.data.hasMore) break;
            cursor = data.data.cursor;
            page++;
        }

        if (!allVideos.length) {
            await bot.sendMessage(chatId, `Không tìm thấy video từ: ${username}`);
            return;
        }

        await bot.editMessageText(`Tìm thấy ${allVideos.length} video. Đang gửi...`, {
            chat_id: chatId, message_id: statusMsg.message_id
        });

        allVideos.reverse();
        let sent = 0;
        for (const video of allVideos) {
            try {
                await sendUserVideo(chatId, username, video);
                sent++;
            } catch (e) {
                console.error(`[USER] Failed to send video ${video.video_id}:`, e.message);
            }
        }
        await bot.sendMessage(chatId, `Đã gửi ${sent}/${allVideos.length} video từ: ${username}`);
    } catch (error) {
        console.error('User videos error:', error.message);
        await bot.sendMessage(chatId, `Lỗi tải video từ: ${username}`);
    }
}

async function sendUserVideo(chatId, username, video) {
    const finalUrl = video.play;
    if (!finalUrl) return;
    await bot.sendDocument(chatId, finalUrl, {
        reply_markup: {
            inline_keyboard: [[
                {text: 'Xem link gốc', url: `https://www.tiktok.com/@${username}/video/${video.video_id}`},
                {text: 'Link video', url: finalUrl}
            ]]
        }
    });
}

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text) return;

    const usernameMatch = text.match(/^u:(.+)$/);
    if (usernameMatch) {
        await processUserVideos(chatId, usernameMatch[1]);
        return;
    }

    const links = text.match(/https?:\/\/(?:www\.|vt\.)?tiktok\.com\/\S+/g);
    if (links?.length) {
        await handleTiktokLinks(chatId, msg, links);
    } else {
        await bot.sendMessage(chatId, 'Vui lòng gửi link TikTok.');
    }
});

async function handleTiktokLinks(chatId, msg, links) {
    const processingMsg = await bot.sendMessage(chatId, `Đã thêm ${links.length} video vào queue...`);
    userQueues[chatId] = userQueues[chatId] || [];
    const userName = msg.from.first_name + (msg.from.last_name ? ' ' + msg.from.last_name : '');
    const userHandle = msg.from.username || 'N/A';

    for (const link of links) {
        const req = new Request({ 
            userName, userHandle, 
            chatId: chatId.toString(), 
            messageId: msg.message_id.toString(), 
            originalLink: link 
        });
        await req.save();
        userQueues[chatId].push(req);
    }
    if (userQueues[chatId].length === links.length) processQueue(chatId);

    setTimeout(() => bot.deleteMessage(chatId, processingMsg.message_id).catch(()=>{}), 5000);
}

function generateDashboardHTML(videos, requests) {
    return `<html><head><title>TikTok Dashboard</title><style>body{font-family:Arial;margin:20px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ddd;padding:8px}</style></head><body><h1>TikTok Download Dashboard</h1><h2>Requests</h2><table><tr><th>User</th><th>Handle</th><th>Original</th><th>Status</th><th>Time</th></tr>${requests.map(r=>`<tr><td>${r.userName}</td><td>${r.userHandle}</td><td><a href="${r.originalLink}">link</a></td><td>${r.status}</td><td>${r.timestamp.toLocaleString()}</td></tr>`).join('')}</table><h2>Completed</h2><table><tr><th>User</th><th>Handle</th><th>Original</th><th>Processed</th><th>Time</th></tr>${videos.map(v=>`<tr><td>${v.userName}</td><td>${v.userHandle}</td><td><a href="${v.originalLink}">link</a></td><td><a href="${v.processedLink}">link</a></td><td>${v.timestamp.toLocaleString()}</td></tr>`).join('')}</table></body></html>`;
}

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
setInterval(() => axios.get(WEBHOOK_URL).catch(()=>{}), PING_INTERVAL);
console.log('Bot started - FORCE HDPLAY + clean path + gửi link HD trực tiếp');
