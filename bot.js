require('dotenv').config();
process.env.NTBA_FIX_350 = 1;
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const FormData = require('form-data');
const express = require('express');
const mongoose = require('mongoose');

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const {
    PORT,
    MONGODB_URI,
    BOT_TOKEN,
    PING_INTERVAL,
    WEBHOOK_URL,
    TIKWMAPI_BASE,
    TIKWMAPI_KEY,
    CF_CLEARANCE,
    PROXY_URL,
    API_ENDPOINT
} = process.env;

let axiosProxy = false;
if (PROXY_URL) {
    try {
        const u = new URL(PROXY_URL);
        axiosProxy = {
            protocol: u.protocol.replace(':', ''),
            host: u.hostname,
            port: Number(u.port) || 80
        };
        if (u.username) {
            axiosProxy.auth = { username: u.username, password: u.password };
        }
        console.log(`[PROXY_ENABLED] Routing requests via ${u.hostname}:${u.port || 80}`);
    } catch (e) {
        console.error('[PROXY_CONFIG_ERROR]', e.message);
    }
}

const TIKWM_BASE = 'https://www.tikwm.com';
const TIKWM_FREE_API = 'https://www.tikwm.com/api/';
const TIKWM_FREE_USER_API = 'https://www.tikwm.com/api/user/posts';
const MAX_TELEGRAM_FILE = 45 * 1024 * 1024;
const MAX_PAGES = 200;

const tikwmPaidApi = axios.create({
    baseURL: TIKWMAPI_BASE || 'https://api.tikwmapi.com',
    headers: TIKWMAPI_KEY ? { 'x-tikwmapi-key': TIKWMAPI_KEY } : {},
    proxy: axiosProxy
});

const bot = new TelegramBot(BOT_TOKEN, {
    polling: {
        autoStart: true,
        params: { timeout: 10 }
    }
});

bot.on('polling_error', (error) => {
    console.error('[POLLING_ERROR]', error.message);
    if (error.code === 'EFATAL') {
        setTimeout(() => {
            bot.stopPolling().then(() => bot.startPolling()).catch(() => { });
        }, 5000);
    }
});

const app = express();
const userQueues = {};

mongoose.connect(MONGODB_URI);

const videoSchema = new mongoose.Schema({
    userName: String,
    userHandle: String,
    originalLink: String,
    processedLink: String,
    timestamp: { type: Date, default: Date.now }
});

const requestSchema = new mongoose.Schema({
    userName: String,
    userHandle: String,
    chatId: String,
    messageId: String,
    originalLink: String,
    status: { type: String, enum: ['pending', 'downloading', 'completed', 'error'], default: 'pending' },
    errorMessage: String,
    timestamp: { type: Date, default: Date.now }
});

const Video = mongoose.model('VideoDownload', videoSchema);
const Request = mongoose.model('DownloadRequest', requestSchema);

app.get('/ping', (req, res) => { console.log('Ping received'); res.send('pong'); });
app.get('/', async (req, res) => {
    try {
        const videos = await Video.find().sort({ timestamp: -1 }).limit(100);
        const requests = await Request.find().sort({ timestamp: -1 }).limit(100);
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
        await processQueue(chatId);
    }
}

async function getVideoStream(url) {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    };
    if (url.includes('zjcdn.com') || url.includes('douyin')) {
        headers['Referer'] = 'https://www.douyin.com/';
    } else {
        headers['Referer'] = 'https://www.tiktok.com/';
    }

    const { data } = await axios.get(url, {
        responseType: 'stream',
        headers,
        proxy: axiosProxy
    });
    return data;
}

// Fetch single video with 2-tier fallback: Free TikWM API -> Paid TikWM API Key
async function fetchDouyinVideoData(originalLink) {
    if (!API_ENDPOINT) {
        console.error('[SINGLE_VIDEO_DOUYIN] Missing API_ENDPOINT in .env');
        return null;
    }
    try {
        const response = await axios.get(`${API_ENDPOINT}?url=${encodeURIComponent(originalLink)}`);
        if (response.status === 200 && response.data.code === 200) {
            const videoData = response.data;
            let videoUrl, hdVideoUrl;
            const title = videoData.data?.desc || videoData.data?.aweme_detail?.desc || '';

            if (videoData.data?.video?.play_addr?.url_list) {
                videoUrl = videoData.data.video.play_addr.url_list[0];
                hdVideoUrl = videoData.data.video.hd_play_addr?.url_list?.[0];
            } else if (videoData.data?.aweme_detail?.video?.play_addr?.url_list) {
                videoUrl = videoData.data.aweme_detail.video.play_addr.url_list[0];
                hdVideoUrl = videoData.data.aweme_detail.video.hd_play_addr?.url_list?.[0];
            } else if (videoData.data?.play_addr?.url_list) {
                videoUrl = videoData.data.play_addr.url_list[0];
                hdVideoUrl = videoData.data.hd_play_addr?.url_list?.[0];
            } else {
                return null;
            }

            return {
                data: {
                    play: videoUrl,
                    hdplay: hdVideoUrl || videoUrl,
                    title: title
                },
                source: 'DOUYIN_LOCAL_API'
            };
        }
    } catch (e) {
        console.error('[SINGLE_VIDEO_DOUYIN] API failed:', e.message);
    }
    return null;
}

async function fetchVideoData(originalLink) {
    if (originalLink.includes('douyin.com')) {
        return fetchDouyinVideoData(originalLink);
    }

    // Tier 1: Free direct API
    try {
        const formData = new FormData();
        formData.append('url', originalLink);
        formData.append('hd', '1');
        formData.append('web', '1');

        const { data: response } = await axios.post(TIKWM_FREE_API, formData, {
            headers: {
                ...formData.getHeaders(),
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Referer': 'https://www.tikwm.com/'
            },
            proxy: axiosProxy
        });

        if (response.code === 0 && response.data) {
            return { data: response.data, source: 'FREE' };
        }
    } catch (e) {
        console.log('[SINGLE_VIDEO] Free API failed, trying paid fallback:', e.message);
    }

    // Tier 2: Paid API Key Fallback
    if (TIKWMAPI_KEY) {
        try {
            const { data: response } = await tikwmPaidApi.get('/', {
                params: { url: originalLink, hd: 1 }
            });
            if (response.code === 0 && response.data) {
                return { data: response.data, source: 'PAID' };
            }
        } catch (e) {
            console.error('[SINGLE_VIDEO] Paid API failed:', e.message);
        }
    }

    return null;
}

async function processLink(request) {
    try {
        await Request.findByIdAndUpdate(request._id, { status: 'downloading' });

        const result = await fetchVideoData(request.originalLink);
        if (!result) {
            await handleError(request, 'Khong the lay du lieu video tu server');
            return;
        }

        console.log(`[PROCESS_LINK] URL: ${request.originalLink} | API_TIER: ${result.source}`);
        const { data } = result;
        let hdPath = (data.hdplay || '').replace(/\\\//g, '/');
        let normalPath = (data.play || '').replace(/\\\//g, '/');

        let finalUrl = null;
        let isHD = false;

        if (hdPath) {
            finalUrl = hdPath.startsWith('http') ? hdPath : TIKWM_BASE + hdPath;
            isHD = true;
        } else if (normalPath) {
            finalUrl = normalPath.startsWith('http') ? normalPath : TIKWM_BASE + normalPath;
            isHD = false;
        }

        const hdSize = Number(data.hd_size) || 0;
        if (isHD && hdSize > MAX_TELEGRAM_FILE && normalPath) {
            finalUrl = normalPath.startsWith('http') ? normalPath : TIKWM_BASE + normalPath;
            isHD = false;
        }

        if (finalUrl) {
            await saveAndSendVideo(request, finalUrl, isHD, data.title);
        } else {
            await handleError(request, 'Khong tim thay link video phu hop');
        }
    } catch (error) {
        console.error('Error:', error.message);
        await handleError(request, error.message);
    }
}

async function saveAndSendVideo(request, finalUrl, isHD, title) {
    const video = new Video({
        userName: request.userName,
        userHandle: request.userHandle,
        originalLink: request.originalLink,
        processedLink: finalUrl
    });
    await video.save();
    await Request.findByIdAndUpdate(request._id, { status: 'completed' });
    await sendVideoToTelegram(request, finalUrl, isHD, title);
}

async function sendVideoToTelegram(request, finalUrl, isHD, title) {
    const captionText = ''; // Tắt caption theo yêu cầu
    const keyboard = {
        inline_keyboard: [[
            { text: 'Xem link goc', url: request.originalLink },
            { text: isHD ? 'Link HD' : 'Link Video', url: finalUrl }
        ]]
    };

    try {
        console.log(`[STREAMING VIDEO] ${request.originalLink} -> ${isHD ? 'HD' : 'Normal'}`);
        const stream = await getVideoStream(finalUrl);
        await bot.sendVideo(request.chatId.toString(), stream, {
            caption: captionText,
            reply_markup: keyboard
        }, { filename: 'video.mp4', contentType: 'video/mp4' });
        console.log(`[SENT VIDEO SUCCESS] ${request.originalLink}`);
        
        // Xóa tin nhắn gốc chứa link của người dùng để gọn khung chat
        if (request.messageId) {
            bot.deleteMessage(request.chatId.toString(), request.messageId).catch(() => {});
        }
    } catch (error) {
        console.error('[SEND_VIDEO_FALLBACK]', error.message);
        try {
            await bot.sendMessage(request.chatId.toString(), captionText ? `${captionText}\n\n[Nhấn vào đây để tải Link HD](${finalUrl})` : `[Nhấn vào đây để tải Link HD](${finalUrl})`, {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
        } catch (e) { }
    }
}

async function handleError(request, errorMessage) {
    await Request.findByIdAndUpdate(request._id, { status: 'error', errorMessage });
    await bot.sendMessage(request.chatId.toString(), `Co loi khi xu ly link: ${request.originalLink}`);
}

// Fetch user channel posts with 2-tier fallback: Free API -> Paid API Key
async function processUserVideos(chatId, username) {
    try {
        const statusMsg = await bot.sendMessage(chatId, `Dang tai video tu kenh: ${username}...`);
        let allVideos = [];
        let usePaidFallback = false;
        let cursor = 0;

        // Tier 1: Try Free User API
        console.log(`[PROCESS_USER] Kenh: ${username} | Thu nghiem API_TIER: FREE (Goi TikWM API truc tiep)`);
        for (let page = 1; page <= MAX_PAGES; page++) {
            const formData = new FormData();
            formData.append('unique_id', username);
            formData.append('count', '30');
            formData.append('cursor', cursor.toString());
            formData.append('hd', '1');
            formData.append('web', '1');

            const headers = {
                ...formData.getHeaders(),
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Referer': 'https://www.tikwm.com/',
                'Origin': 'https://www.tikwm.com'
            };
            if (CF_CLEARANCE) {
                headers['Cookie'] = `cf_clearance=${CF_CLEARANCE}`;
            }

            try {
                const { data: pageData } = await axios.post(TIKWM_FREE_USER_API, formData, { headers, proxy: axiosProxy });

                if (typeof pageData === 'string' && pageData.includes('Just a moment')) {
                    console.log('[USER_POSTS] Cloudflare blocked free API, switching to paid fallback');
                    usePaidFallback = true;
                    break;
                }

                if (!pageData || pageData.code !== 0 || !pageData.data?.videos?.length) break;

                allVideos.push(...pageData.data.videos);
                if (!pageData.data.hasMore) break;
                cursor = pageData.data.cursor;
            } catch (e) {
                console.log('[USER_POSTS] Free API error, switching to paid fallback:', e.message);
                usePaidFallback = true;
                break;
            }
        }

        // Tier 2: Paid API Key Fallback if Tier 1 blocked/failed
        if (usePaidFallback && TIKWMAPI_KEY) {
            console.log(`[PROCESS_USER] Kenh: ${username} | Chuyen qua API_TIER: PAID (TikWM Paid API)`);
            console.log('[USER_POSTS] Running Tier 2 Paid API Fallback...');
            allVideos = [];
            cursor = 0;

            for (let page = 1; page <= MAX_PAGES; page++) {
                try {
                    const { data: pageData } = await tikwmPaidApi.get('/user/posts', {
                        params: { unique_id: username, count: 30, cursor }
                    });

                    if (!pageData || pageData.code !== 0 || !pageData.data?.videos?.length) break;

                    allVideos.push(...pageData.data.videos);
                    if (!pageData.data.hasMore) break;
                    cursor = pageData.data.cursor;
                } catch (e) {
                    console.error('[USER_POSTS_PAID_ERR]', e.message);
                    break;
                }
            }
        }

        if (!allVideos.length) {
            await bot.sendMessage(chatId, `Khong tim thay video tu kenh: ${username}`);
            return;
        }

        await bot.editMessageText(`Tim thay ${allVideos.length} video. Dang gui...`, {
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
        await bot.sendMessage(chatId, `Da gui xong ${sent}/${allVideos.length} video tu kenh: ${username}`);
    } catch (error) {
        console.error('User videos error:', error.message);
        await bot.sendMessage(chatId, `Loi khi tai video tu kenh: ${username}`);
    }
}

async function sendUserVideo(chatId, username, video) {
    let hdPath = (video.hdplay || '').replace(/\\\//g, '/');
    let normalPath = (video.play || '').replace(/\\\//g, '/');
    let finalUrl = hdPath ? (hdPath.startsWith('http') ? hdPath : TIKWM_BASE + hdPath) : (normalPath.startsWith('http') ? normalPath : TIKWM_BASE + normalPath);
    if (!finalUrl) return;

    const title = video.title || '';
    const captionText = ''; // Tắt caption theo yêu cầu
    const originalLink = `https://www.tiktok.com/@${username}/video/${video.video_id}`;
    const keyboard = {
        inline_keyboard: [[
            { text: 'Xem link goc', url: originalLink },
            { text: 'Link Video', url: finalUrl }
        ]]
    };

    try {
        const stream = await getVideoStream(finalUrl);
        await bot.sendVideo(chatId, stream, {
            caption: captionText,
            reply_markup: keyboard
        }, { filename: 'video.mp4', contentType: 'video/mp4' });
    } catch (e) {
        console.error(`[USER_VIDEO_FALLBACK] ${video.video_id}:`, e.message);
        await bot.sendMessage(chatId, captionText ? `${captionText}\n\n[Nhấn vào đây để tải Link](${finalUrl})` : `[Nhấn vào đây để tải Link](${finalUrl})`, {
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }
}

bot.on('message', async (msg) => {
    try {
        const chatId = msg.chat.id;
        const text = msg.text;
        console.log(`[BOT MSG] ChatID: ${chatId} | Text: ${text}`);
        if (!text) return;

        const usernameMatch = text.match(/^u:(.+)$/);
        if (usernameMatch) {
            await processUserVideos(chatId, usernameMatch[1]);
            return;
        }

        const links = text.match(/https?:\/\/(?:www\.|vt\.|v\.)?(tiktok|douyin)\.com\/\S+/g);
        if (links?.length) {
            await handleTiktokLinks(chatId, msg, links);
        } else {
            await bot.sendMessage(chatId, 'Vui long gui link TikTok hop le hoac lenh u:username');
        }
    } catch (e) {
        console.error('[MESSAGE_HANDLER_ERROR]', e.message);
    }
});

async function handleTiktokLinks(chatId, msg, links) {
    const processingMsg = await bot.sendMessage(chatId, `Da them ${links.length} video vao hang doi...`);
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

    setTimeout(() => bot.deleteMessage(chatId, processingMsg.message_id).catch(() => { }), 5000);
}

function generateDashboardHTML(videos, requests) {
    return `<html><head><title>TikTok Dashboard</title><style>body{font-family:Arial;margin:20px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ddd;padding:8px}</style></head><body><h1>TikTok Download Dashboard</h1><h2>Requests</h2><table><tr><th>User</th><th>Handle</th><th>Original</th><th>Status</th><th>Time</th></tr>${requests.map(r => `<tr><td>${r.userName}</td><td>${r.userHandle}</td><td><a href="${r.originalLink}">link</a></td><td>${r.status}</td><td>${r.timestamp.toLocaleString()}</td></tr>`).join('')}</table><h2>Completed</h2><table><tr><th>User</th><th>Handle</th><th>Original</th><th>Processed</th><th>Time</th></tr>${videos.map(v => `<tr><td>${v.userName}</td><td>${v.userHandle}</td><td><a href="${v.originalLink}">link</a></td><td><a href="${v.processedLink}">link</a></td><td>${v.timestamp.toLocaleString()}</td></tr>`).join('')}</table></body></html>`;
}

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
setInterval(() => axios.get(WEBHOOK_URL).catch(() => { }), PING_INTERVAL);
console.log('Bot started - Clean Standalone Engine with Multi-Tier Fallback');
