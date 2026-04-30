const express = require('express');
const cors = require('cors');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // Serve frontend files

// ─── Temp directory for downloads ──────────────────────────────────────────────
const TMP_DIR = path.join(__dirname, 'tmp_downloads');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

// ─── Helper: find yt-dlp binary ────────────────────────────────────────────────
function getYtDlpPath() {
    try {
        const result = execSync('where yt-dlp', { encoding: 'utf8' }).trim().split('\n')[0].trim();
        if (result) return result;
    } catch (_) {}
    // Common fallback paths
    const fallbacks = [
        'yt-dlp',
        'yt-dlp.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'yt-dlp', 'yt-dlp.exe'),
    ];
    for (const fb of fallbacks) {
        try { execSync(`"${fb}" --version`, { encoding: 'utf8' }); return fb; } catch (_) {}
    }
    return 'yt-dlp';
}

const YT_DLP = getYtDlpPath();
console.log(`✅ yt-dlp found at: ${YT_DLP}`);

// ─── Cleanup old temp files every 10 minutes ───────────────────────────────────
setInterval(() => {
    try {
        const files = fs.readdirSync(TMP_DIR);
        const now = Date.now();
        files.forEach(f => {
            const fp = path.join(TMP_DIR, f);
            const stat = fs.statSync(fp);
            if (now - stat.mtimeMs > 10 * 60 * 1000) {
                fs.unlinkSync(fp);
            }
        });
    } catch (_) {}
}, 10 * 60 * 1000);

// ─── Route: GET video info (for quality selection) ─────────────────────────────
app.post('/api/info', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const args = [
        '--dump-json',
        '--no-playlist',
        '--no-warnings',
        url
    ];

    let data = '';
    let errData = '';

    const proc = spawn(YT_DLP, args);
    proc.stdout.on('data', d => data += d.toString());
    proc.stderr.on('data', d => errData += d.toString());

    proc.on('close', code => {
        if (code !== 0 || !data.trim()) {
            return res.status(400).json({ error: 'Could not fetch video info. The URL might be invalid, private, or from an unsupported platform.' });
        }
        try {
            const info = JSON.parse(data.trim().split('\n')[0]); // parse first JSON object
            const formats = (info.formats || [])
                .filter(f => f.ext && f.ext !== 'mhtml')
                .map(f => ({
                    format_id: f.format_id,
                    ext: f.ext,
                    quality: f.format_note || f.resolution || f.quality || '',
                    width: f.width,
                    height: f.height,
                    filesize: f.filesize,
                    vcodec: f.vcodec,
                    acodec: f.acodec,
                }));

            res.json({
                title: info.title || 'Video',
                thumbnail: info.thumbnail || null,
                duration: info.duration || null,
                platform: info.extractor_key || 'Unknown',
                formats
            });
        } catch (e) {
            res.status(500).json({ error: 'Failed to parse video info.' });
        }
    });
});

// ─── Route: Download and stream to client ─────────────────────────────────────
app.get('/api/download', (req, res) => {
    const { url, type } = req.query; // type: 'video' or 'audio'
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const isAudio = type === 'audio';
    const fileId = randomUUID();
    const ext = isAudio ? 'mp3' : 'mp4';
    const outputPath = path.join(TMP_DIR, `${fileId}.%(ext)s`);
    const finalPath = path.join(TMP_DIR, `${fileId}.${ext}`);

    let args;

    if (isAudio) {
        args = [
            '-f', 'bestaudio/best',
            '-x',
            '--audio-format', 'mp3',
            '--audio-quality', '0',
            '--no-playlist',
            '--no-warnings',
            '-o', outputPath,
            url
        ];
    } else {
        args = [
            '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
            '--merge-output-format', 'mp4',
            '--no-playlist',
            '--no-warnings',
            '-o', outputPath,
            url
        ];
    }

    console.log(`⬇️  Downloading [${type}]: ${url}`);

    let errData = '';
    const proc = spawn(YT_DLP, args);
    proc.stderr.on('data', d => { errData += d.toString(); });

    proc.on('close', code => {
        if (code !== 0) {
            console.error('yt-dlp error:', errData);
            if (!res.headersSent) {
                return res.status(500).json({ error: 'Download failed. ' + errData.slice(0, 200) });
            }
            return;
        }

        // Find the actual downloaded file
        let downloadedFile = finalPath;
        if (!fs.existsSync(downloadedFile)) {
            // Search for any file with the fileId prefix
            const files = fs.readdirSync(TMP_DIR).filter(f => f.startsWith(fileId));
            if (files.length > 0) {
                downloadedFile = path.join(TMP_DIR, files[0]);
            } else {
                return res.status(500).json({ error: 'Downloaded file not found.' });
            }
        }

        const filename = `download_${Date.now()}.${isAudio ? 'mp3' : 'mp4'}`;
        const stat = fs.statSync(downloadedFile);

        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');
        res.setHeader('Content-Length', stat.size);

        const fileStream = fs.createReadStream(downloadedFile);
        fileStream.pipe(res);

        fileStream.on('close', () => {
            // Cleanup after sending
            try { fs.unlinkSync(downloadedFile); } catch (_) {}
        });

        fileStream.on('error', err => {
            console.error('Stream error:', err);
            try { fs.unlinkSync(downloadedFile); } catch (_) {}
        });
    });

    // Handle client disconnect
    req.on('close', () => {
        proc.kill('SIGTERM');
    });
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🚀 UniDownloader server running at http://localhost:${PORT}`);
    console.log(`   Open your browser and go to: http://localhost:${PORT}\n`);
});
