const express = require('express');
const cors = require('cors');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ─── Temp directory ────────────────────────────────────────────────────────────
const TMP_DIR = path.join(__dirname, 'tmp_downloads');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

// ─── Job store ─────────────────────────────────────────────────────────────────
const jobs = new Map();

// ─── Find yt-dlp ──────────────────────────────────────────────────────────────
function getYtDlpPath() {
    const isWin = process.platform === 'win32';
    try {
        const cmd = isWin ? 'where yt-dlp' : 'which yt-dlp';
        const r = execSync(cmd, { encoding: 'utf8' }).trim().split('\n')[0].trim();
        if (r) return r;
    } catch (_) {}
    for (const fb of ['yt-dlp', 'yt-dlp.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'yt-dlp', 'yt-dlp.exe')]) {
        try { execSync(`"${fb}" --version`, { encoding: 'utf8' }); return fb; } catch (_) {}
    }
    return 'yt-dlp';
}
const YT_DLP = getYtDlpPath();
console.log(`✅ yt-dlp: ${YT_DLP}`);

// ─── Check ffmpeg ──────────────────────────────────────────────────────────────
function hasFfmpeg() {
    try { execSync('ffmpeg -version', { encoding: 'utf8', stdio: 'ignore' }); return true; } catch (_) { return false; }
}
const HAS_FFMPEG = hasFfmpeg();
console.log(HAS_FFMPEG ? '✅ ffmpeg found' : '⚠️  ffmpeg NOT found — quality will be limited');

// ─── yt-dlp arg sets ──────────────────────────────────────────────────────
let cookiesArg = [];
const cookiesPath = path.join(__dirname, 'cookies.txt');
if (fs.existsSync(cookiesPath)) {
    cookiesArg = ['--cookies', cookiesPath];
    console.log('✅ Found cookies.txt - passing to yt-dlp');
} else {
    console.log('⚠️  No cookies.txt found - YouTube may block downloads from Datacenter IPs');
}

// INFO: No extractor-args → yt-dlp uses its own best client (returns ALL qualities)
// Using --extractor-args with 'web' was breaking info fetch due to YouTube anti-bot
const INFO_ARGS = [
    '--no-playlist', '--no-warnings', '--no-check-certificate',
    '--no-cache-dir',
    '--extractor-args', 'youtube:player_client=android,android_vr;client=android,ios',
    ...cookiesArg
];

// DOWNLOAD: no extractor-args — android client only has 360p muxed streams
// yt-dlp's default client has ALL streams including 4K
const DL_ARGS = [
    '--no-playlist', '--no-warnings', '--no-check-certificate',
    '--no-cache-dir',
    '--extractor-args', 'youtube:player_client=android,android_vr;client=android,ios',
    '-S', 'vcodec:h264,res,acodec:m4a',
    '--concurrent-fragments', '4',
    '--buffer-size', '1M',
    '--newline',
    ...cookiesArg
];

// ─── Cleanup every 10 minutes ─────────────────────────────────────────────────
setInterval(() => {
    try {
        const now = Date.now();
        fs.readdirSync(TMP_DIR).forEach(f => {
            const fp = path.join(TMP_DIR, f);
            if (now - fs.statSync(fp).mtimeMs > 10 * 60 * 1000) fs.unlinkSync(fp);
        });
    } catch (_) {}
    for (const [id, job] of jobs.entries()) {
        if ((job.status === 'done' || job.status === 'error') &&
            Date.now() - job.createdAt > 10 * 60 * 1000) jobs.delete(id);
    }
}, 10 * 60 * 1000);

// ─── Puppeteer Stream Extractor ───────────────────────────────────────────────
async function extractStreamUrl(url) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-web-security',
                '--disable-dev-shm-usage'
            ]
        });
        const page = await browser.newPage();
        
        await page.setRequestInterception(true);
        page.on('request', req => {
            const rt = req.resourceType();
            if (['image', 'stylesheet', 'font'].includes(rt)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        let streamUrl = null;
        page.on('request', request => {
            const reqUrl = request.url();
            if ((reqUrl.includes('.m3u8') || reqUrl.includes('.mp4') || reqUrl.includes('.flv')) && !reqUrl.includes('ad')) {
                if (!streamUrl) streamUrl = reqUrl;
            }
        });

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        
        try {
            // 1. Click around the main page to load iframes
            await page.evaluate(() => {
                document.body.click();
                const buttons = document.querySelectorAll('.play-btn, iframe, #play, .server-item');
                buttons.forEach(b => { try { b.click(); } catch(e){} });
            });

            await new Promise(r => setTimeout(r, 2000));

            // 2. Inject click/play logic into EVERY iframe (Bypasses MegaCloud/RabbitStream embeds)
            for (const frame of page.frames()) {
                try {
                    await frame.evaluate(() => {
                        document.body.click();
                        const v = document.querySelector('video');
                        if (v) v.play();
                        const buttons = document.querySelectorAll('.play-btn, .vjs-play-control, .plyr__control, .jw-icon-display, .art-state');
                        buttons.forEach(b => { try { b.click(); } catch(e){} });
                    });
                } catch(e) {}
            }
        } catch(e) {}

        // Wait for the .m3u8 stream request to fire
        await new Promise(r => setTimeout(r, 8000));
        await browser.close();
        return streamUrl;
    } catch (e) {
        if (browser) await browser.close();
        return null;
    }
}

// ─── Terabox Paid API ─────────────────────────────────────────────────────────
async function fetchTeraboxInfo(targetUrl) {
    const apiKey = process.env.TERABOX_RAPIDAPI_KEY || '5074d40d75msh575879a3941d625p157655jsn15142dc1fdd7';
    
    // Using the exact API provided: terabox-downloader-direct-download-link-generator
    const r = await fetch('https://terabox-downloader-direct-download-link-generator.p.rapidapi.com/fetch', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-rapidapi-key': apiKey,
            'x-rapidapi-host': 'terabox-downloader-direct-download-link-generator.p.rapidapi.com'
        },
        body: JSON.stringify({ url: targetUrl })
    });
    
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || 'Terabox API Error');
    
    // The API returns an array of files or resolutions.
    const file = Array.isArray(data.files) ? data.files[0] : (Array.isArray(data) ? data[0] : (data.response || data));
    const directLink = file?.resolutions?.['Fast Download'] || file?.resolutions?.['HD Video'] || file?.dlink || file?.link || file?.downloadLink || data?.downloadLink;
    
    if (!directLink) {
        console.error("Terabox API Data:", JSON.stringify(data));
        throw new Error('API succeeded but did not return a valid direct download link. Check API documentation.');
    }

    return {
        title: file?.server_filename || file?.title || 'Terabox File',
        thumbnail: file?.thumbs?.url1 || file?.thumbnail || null,
        duration: null,
        platform: 'TeraBox',
        formats: [{
            format_id: 'best',
            ext: 'mp4',
            quality: 'HD',
            height: 1080,
            vcodec: 'avc1',
            acodec: 'mp4a'
        }],
        streamUrl: directLink
    };
}

// ─── GET /api/info ────────────────────────────────────────────────────────────
app.post('/api/info', async (req, res) => {
    let { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    // 🔴 Convert YouTube Shorts and youtu.be to standard watch URLs (Bypasses aggressive Shorts bot detection)
    if (url.includes('youtube.com/shorts/')) {
        const videoId = url.split('/shorts/')[1].split('?')[0];
        url = `https://www.youtube.com/watch?v=${videoId}`;
        console.log(`🔄 Converted Shorts URL to standard watch URL: ${url}`);
    } else if (url.includes('youtu.be/')) {
        const videoId = url.split('youtu.be/')[1].split('?')[0];
        url = `https://www.youtube.com/watch?v=${videoId}`;
        console.log(`🔄 Converted youtu.be URL to standard watch URL: ${url}`);
    }

    // Intercept Terabox URLs and use the paid API instead of yt-dlp/puppeteer
    if (url.includes('terabox.com') || url.includes('teraboxapp.com') || url.includes('1024tera.com')) {
        try {
            const info = await fetchTeraboxInfo(url);
            return res.json(info);
        } catch (e) {
            return res.status(400).json({ error: `TeraBox API Failed: ${e.message}` });
        }
    }

    function fetchInfo(targetUrl, isStream = false) {
        let data = '', err = '';
        const proc = spawn(YT_DLP, ['--dump-json', ...INFO_ARGS, targetUrl]);
        proc.stdout.on('data', d => data += d);
        proc.stderr.on('data', d => err += d);
        proc.on('close', async code => {
            if (code !== 0 || !data.trim()) {
                console.error(`\n❌ yt-dlp info fetch failed for ${targetUrl}`);
                console.error(`Exit Code: ${code}`);
                console.error(`Error Output: ${err}\n`);

                if (!isStream) {
                    console.log('yt-dlp failed, attempting puppeteer fallback for:', targetUrl);
                    const streamUrl = await extractStreamUrl(targetUrl);
                    if (streamUrl) {
                        console.log('Puppeteer found stream:', streamUrl);
                        return fetchInfo(streamUrl, true);
                    }
                }
                return res.status(400).json({ error: 'Could not fetch video info. URL may be invalid, private, or unsupported. Check server logs.' });
            }
            try {
                const info = JSON.parse(data.trim().split('\n')[0]);
                const formats = (info.formats || [])
                    .filter(f => f.ext && f.ext !== 'mhtml')
                    .map(f => ({
                        format_id: f.format_id,
                        ext: f.ext,
                        quality: f.format_note || f.resolution || '',
                        width: f.width,
                        height: f.height,
                        filesize: f.filesize || null,
                        vcodec: f.vcodec,
                        acodec: f.acodec,
                    }));
                res.json({
                    title: info.title || 'Video',
                    thumbnail: info.thumbnail || null,
                    duration: info.duration || null,
                    platform: info.extractor_key || 'Unknown',
                    formats,
                    streamUrl: isStream ? targetUrl : undefined
                });
            } catch (e) {
                res.status(500).json({ error: 'Failed to parse video info.' });
            }
        });
    }

    fetchInfo(url, false);
});

// ─── POST /api/start-download ─────────────────────────────────────────────────
app.post('/api/start-download', (req, res) => {
    let { url, type, height } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    // 🔴 Convert YouTube Shorts and youtu.be to standard watch URLs for download
    if (url.includes('youtube.com/shorts/')) {
        const videoId = url.split('/shorts/')[1].split('?')[0];
        url = `https://www.youtube.com/watch?v=${videoId}`;
    } else if (url.includes('youtu.be/')) {
        const videoId = url.split('youtu.be/')[1].split('?')[0];
        url = `https://www.youtube.com/watch?v=${videoId}`;
    }

    const jobId  = randomUUID();
    const fileId = randomUUID();
    const isAudio = type === 'audio';

    const job = {
        jobId, status: 'pending',
        percent: 0, speed: '', eta: '', size: '',
        filePath: null, error: null,
        sseClients: [],
        _fileId: fileId,
        _type: isAudio ? 'audio' : 'video',
        createdAt: Date.now(),
    };
    jobs.set(jobId, job);

    function broadcast(payload) {
        job.sseClients.forEach(c => {
            try { c.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (_) {}
        });
    }

    // ─── Progress line parser ─────────────────────────────────────────────────
    // yt-dlp outputs: [download]  45.3% of ~123.45MiB at 3.21MiB/s ETA 00:32
    const progressRe = /\[download\]\s+([\d.]+)%(?:\s+of\s+~?\s*([\d.]+\s*\S+))?\s+at\s+([\d.]+\s*\S+\/s)\s+ETA\s+(\S+)/;
    const mergeRe    = /\[Merger\]|\[ffmpeg\]|Merging formats/i;

    function parseLine(line) {
        const m = line.match(progressRe);
        if (m) {
            job.percent = parseFloat(m[1]);
            if (m[2]) job.size = m[2].trim();
            job.speed = m[3] ? m[3].trim() : job.speed;
            job.eta   = m[4] ? m[4].trim() : job.eta;
            job.status = 'downloading';
            broadcast({ status: 'downloading', percent: job.percent, speed: job.speed, eta: job.eta, size: job.size });
        } else if (mergeRe.test(line)) {
            job.status = 'processing';
            broadcast({ status: 'processing', percent: 99 });
        }
    }

    // ─── Build yt-dlp args ────────────────────────────────────────────────────
    let args;
    if (isAudio) {
        // ✅ Fixed: explicit .mp3 output path so file-finder works after --extract-audio renames it
        const outPath = path.join(TMP_DIR, `${fileId}.mp3`);
        if (HAS_FFMPEG) {
            args = [
                '-f', 'bestaudio/best',
                '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0',
                ...DL_ARGS,
                '-o', outPath, url,
            ];
        } else {
            args = [
                '-f', 'bestaudio[ext=m4a]/bestaudio/best',
                ...DL_ARGS,
                '-o', outPath, url,
            ];
        }
        job._expectedPath = outPath;
    } else {
        if (HAS_FFMPEG) {
            // ✅ Height-based: bestvideo[height<=N] works across all yt-dlp clients
            const fmt = height
                ? `bestvideo[height<=${height}][ext=mp4]+bestaudio/bestvideo[height<=${height}]+bestaudio/best`
                : 'bestvideo[ext=mp4]+bestaudio/bestvideo+bestaudio/best';
            args = [
                '-f', fmt,
                '--merge-output-format', 'mp4',
                ...DL_ARGS,
                '-o', path.join(TMP_DIR, `${fileId}.%(ext)s`), url,
            ];
        } else {
            const fmt = height
                ? `best[height<=${height}][ext=mp4]/best[height<=${height}]/best`
                : 'best[ext=mp4]/best';
            args = [
                '-f', fmt,
                ...DL_ARGS,
                '-o', path.join(TMP_DIR, `${fileId}.%(ext)s`), url,
            ];
        }
    }

    console.log(`⬇️  [${job._type.toUpperCase()}] job=${jobId} height=${height || 'best'}`);


    const proc = spawn(YT_DLP, args);
    job._proc = proc;

    let stderr = '';
    proc.stdout.on('data', d => d.toString().split('\n').forEach(l => l.trim() && parseLine(l)));
    proc.stderr.on('data', d => {
        const t = d.toString();
        stderr += t;
        process.stdout.write(d);
        t.split('\n').forEach(l => l.trim() && parseLine(l));
    });

    const killTimer = setTimeout(() => {
        proc.kill('SIGTERM');
        job.status = 'error';
        job.error  = 'Timed out — video too large or network too slow.';
        broadcast({ status: 'error', error: job.error });
    }, 15 * 60 * 1000);

    proc.on('close', code => {
        clearTimeout(killTimer);
        if (code !== 0) {
            job.status = 'error';
            job.error  = `Download failed (exit ${code}). ` + stderr.slice(-400);
            broadcast({ status: 'error', error: job.error });
            return;
        }

        // Find completed file — check explicit path first (audio), then scan directory
        let foundFile = null;
        if (job._expectedPath && fs.existsSync(job._expectedPath)) {
            foundFile = path.basename(job._expectedPath);
        } else {
            const files = fs.readdirSync(TMP_DIR).filter(f =>
                f.startsWith(fileId) && !f.endsWith('.part') && !f.endsWith('.ytdl') && !f.endsWith('.json')
            );
            if (files.length) foundFile = files[0];
        }

        if (!foundFile) {
            job.status = 'error';
            job.error  = 'Output file not found after download.';
            broadcast({ status: 'error', error: job.error });
            return;
        }

        job.filePath = path.join(TMP_DIR, foundFile);
        job.status   = 'done';
        job.percent  = 100;
        broadcast({ status: 'done', percent: 100, fetchUrl: `/api/fetch/${jobId}` });
        console.log(`✅ Done: ${job.filePath}`);
    });

    res.json({ jobId });
});

// ─── GET /api/progress/:jobId  (SSE) ─────────────────────────────────────────
app.get('/api/progress/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    // Send current snapshot immediately
    res.write(`data: ${JSON.stringify({
        status: job.status, percent: job.percent,
        speed: job.speed, eta: job.eta, size: job.size,
    })}\n\n`);

    if (job.status === 'done') {
        res.write(`data: ${JSON.stringify({ status: 'done', percent: 100, fetchUrl: `/api/fetch/${req.params.jobId}` })}\n\n`);
        return res.end();
    }
    if (job.status === 'error') {
        res.write(`data: ${JSON.stringify({ status: 'error', error: job.error })}\n\n`);
        return res.end();
    }

    job.sseClients.push(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 20000);
    req.on('close', () => {
        clearInterval(ping);
        job.sseClients = job.sseClients.filter(c => c !== res);
    });
});

// ─── GET /api/fetch/:jobId ────────────────────────────────────────────────────
app.get('/api/fetch/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job)                              return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'done' || !job.filePath) return res.status(400).json({ error: 'File not ready' });
    if (!fs.existsSync(job.filePath))     return res.status(410).json({ error: 'File already cleaned up' });

    const ext  = path.extname(job.filePath).replace('.', '') || (job._type === 'audio' ? 'mp3' : 'mp4');
    const name = `${job._type}_${Date.now()}.${ext}`;
    const size = fs.statSync(job.filePath).size;

    const MIME = {
        mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
        mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg',
    };
    const mime = MIME[ext] || (job._type === 'audio' ? 'audio/mpeg' : 'video/mp4');

    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', size);

    const stream = fs.createReadStream(job.filePath);
    stream.pipe(res);
    stream.on('close', () => {
        try { fs.unlinkSync(job.filePath); } catch (_) {}
        jobs.delete(job.jobId);
    });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`\n🚀 UniDownloader → http://localhost:${PORT}\n`));
