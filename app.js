document.addEventListener('DOMContentLoaded', () => {

    // ══════════════════════════════════════════════════════════
    //  MOBILE NAV (Hamburger)
    // ══════════════════════════════════════════════════════════
    const hamburger  = document.getElementById('hamburger');
    const navLinks   = document.getElementById('nav-links');
    const navOverlay = document.getElementById('nav-overlay');

    function openNav() {
        hamburger.classList.add('open');
        navLinks.classList.add('open');
        navOverlay.classList.add('open');
        document.body.style.overflow = 'hidden';
    }
    function closeNav() {
        hamburger.classList.remove('open');
        navLinks.classList.remove('open');
        navOverlay.classList.remove('open');
        document.body.style.overflow = '';
    }
    hamburger.addEventListener('click', () =>
        hamburger.classList.contains('open') ? closeNav() : openNav()
    );
    navOverlay.addEventListener('click', closeNav);
    document.querySelectorAll('.nav-link-item').forEach(a => a.addEventListener('click', closeNav));

    // ══════════════════════════════════════════════════════════
    //  DOM REFS
    // ══════════════════════════════════════════════════════════
    const form         = document.getElementById('download-form');
    const urlInput     = document.getElementById('video-url');
    const pasteBtn     = document.getElementById('paste-btn');
    const loadingState = document.getElementById('loading-state');
    const loadingText  = loadingState.querySelector('p');
    const errorState   = document.getElementById('error-state');
    const resultState  = document.getElementById('result-state');
    const errorMessage = document.getElementById('error-message');
    const retryBtn     = document.getElementById('retry-btn');
    const mp4Btn       = document.getElementById('download-link-mp4');
    const mp3Btn       = document.getElementById('download-link-mp3');

    // Progress modal
    const progressModal    = document.getElementById('progress-modal');
    const progressTitle    = document.getElementById('progress-title');
    const progressSubtitle = document.getElementById('progress-subtitle');
    const progressBarFill  = document.getElementById('progress-bar-fill');
    const ringFill         = document.getElementById('ring-fill-circle');
    const ringPercent      = document.getElementById('ring-percent');
    const statSpeed        = document.getElementById('stat-speed').querySelector('span');
    const statEta          = document.getElementById('stat-eta').querySelector('span');
    const statSize         = document.getElementById('stat-size').querySelector('span');
    const cancelBtn        = document.getElementById('progress-cancel-btn');

    const RING_CIRC = 264; // 2π × 42

    // ══════════════════════════════════════════════════════════
    //  STATE
    // ══════════════════════════════════════════════════════════
    let currentUrl      = '';
    let selectedHeight   = null;   // e.g. 1080 — null means "best available"
    let selectedLabel    = 'Best';
    let activeSSE        = null;
    let connectTimer     = null;

    // ══════════════════════════════════════════════════════════
    //  PASTE
    // ══════════════════════════════════════════════════════════
    pasteBtn.addEventListener('click', async () => {
        try {
            const t = await navigator.clipboard.readText();
            if (t) urlInput.value = t;
        } catch (_) {
            alert('Clipboard access denied. Please paste with Ctrl+V.');
        }
    });

    // ══════════════════════════════════════════════════════════
    //  RETRY
    // ══════════════════════════════════════════════════════════
    retryBtn.addEventListener('click', () => {
        hideAll();
        urlInput.value = '';
        urlInput.focus();
    });

    // ══════════════════════════════════════════════════════════
    //  FORM SUBMIT → fetch info
    // ══════════════════════════════════════════════════════════
    form.addEventListener('submit', async e => {
        e.preventDefault();
        const url = urlInput.value.trim();
        if (!url) return;

        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            showError('Please enter a valid URL starting with https://');
            return;
        }

        currentUrl = url;
        showLoading('Fetching video info…');

        try {
            const r = await fetch('/api/info', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url }),
            });
            const data = await r.json();
            if (!r.ok || data.error) throw new Error(data.error || 'Failed to fetch info.');
            
            // If the server used Puppeteer fallback to find the direct stream, use that for download
            if (data.streamUrl) currentUrl = data.streamUrl;
            
            showResult(data);
        } catch (err) {
            showError(err.message || 'Could not process this URL. Make sure the server is running.');
        }
    });

    // ══════════════════════════════════════════════════════════
    //  CANCEL DOWNLOAD
    // ══════════════════════════════════════════════════════════
    cancelBtn.addEventListener('click', () => {
        if (activeSSE) { activeSSE.close(); activeSSE = null; }
        hideProgress();
    });

    // ══════════════════════════════════════════════════════════
    //  TRIGGER DOWNLOAD
    // ══════════════════════════════════════════════════════════
    async function triggerDownload(type) {
        const btn = type === 'video' ? mp4Btn : mp3Btn;
        const orig = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Starting…';
        btn.disabled = true;

        try {
            const body = {
                url: currentUrl,
                type: type === 'video' ? 'video' : 'audio',
            };
            // Send height for quality selection (height-based works across all yt-dlp clients)
            if (type === 'video' && selectedHeight) {
                body.height = selectedHeight;
            }

            const r = await fetch('/api/start-download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const { jobId, error } = await r.json();
            if (error) throw new Error(error);

            openProgress(type);

            // Open SSE stream
            const sse = new EventSource(`/api/progress/${jobId}`);
            activeSSE = sse;

            sse.onmessage = ev => handleSSE(JSON.parse(ev.data), jobId);
            sse.onerror   = () => {
                sse.close();
                activeSSE = null;
                if (!progressModal.classList.contains('hidden')) {
                    setProgressUI(0, '❌ Connection lost', 'Server may have restarted');
                }
            };

        } catch (err) {
            hideProgress();
            showError(err.message || 'Failed to start download.');
        } finally {
            setTimeout(() => {
                btn.innerHTML = orig;
                btn.disabled  = false;
            }, 2000);
        }
    }

    // ══════════════════════════════════════════════════════════
    //  SSE EVENT HANDLER
    // ══════════════════════════════════════════════════════════
    function handleSSE(data, jobId) {
        switch (data.status) {
            case 'downloading':
                stopConnectTimer();
                setProgressUI(
                    data.percent,
                    'Downloading…',
                    'High quality download in progress',
                    data.speed,
                    data.eta,
                    data.size,
                );
                break;

            case 'processing':
                stopConnectTimer();
                setProgressUI(99, 'Processing…', 'Merging video + audio with ffmpeg…', '', 'Almost done', '');
                break;

            case 'done':
                stopConnectTimer();
                setProgressUI(100, '✅ Complete!', 'Saving file to your device…');
                if (activeSSE) { activeSSE.close(); activeSSE = null; }
                setTimeout(() => {
                    const a = document.createElement('a');
                    a.href = `/api/fetch/${jobId}`;
                    a.style.display = 'none';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    setTimeout(hideProgress, 2500);
                }, 500);
                break;

            case 'error':
                stopConnectTimer();
                if (activeSSE) { activeSSE.close(); activeSSE = null; }
                setProgressUI(0, '❌ Error', data.error || 'Download failed.');
                setTimeout(() => {
                    hideProgress();
                    showError(data.error || 'Download failed. Please try again.');
                }, 2500);
                break;
        }
    }

    // ══════════════════════════════════════════════════════════
    //  PROGRESS MODAL
    // ══════════════════════════════════════════════════════════
    function openProgress(type) {
        setRing(0);
        progressBarFill.style.width = '0%';
        progressTitle.textContent    = type === 'video'
            ? `Downloading MP4${selectedLabel !== 'Best' ? ` — ${selectedLabel}` : ''}…`
            : 'Downloading MP3…';
        statSpeed.textContent = '—';
        statEta.textContent   = '—';
        statSize.textContent  = '—';
        progressModal.classList.remove('hidden');

        // Cycle through connecting messages while yt-dlp warms up
        const msgs = ['Connecting to server…', 'Starting yt-dlp…', 'Fetching stream…', 'Almost ready…'];
        let i = 0;
        progressSubtitle.textContent = msgs[0];
        stopConnectTimer();
        connectTimer = setInterval(() => {
            i = Math.min(i + 1, msgs.length - 1);
            progressSubtitle.textContent = msgs[i];
        }, 2500);
    }

    function hideProgress() {
        progressModal.classList.add('hidden');
        stopConnectTimer();
    }

    function stopConnectTimer() {
        if (connectTimer) { clearInterval(connectTimer); connectTimer = null; }
    }

    function setRing(pct) {
        const c = Math.max(0, Math.min(100, pct));
        progressBarFill.style.width     = `${c}%`;
        ringFill.style.strokeDashoffset = RING_CIRC - (c / 100) * RING_CIRC;
        ringPercent.textContent         = `${Math.round(c)}%`;
    }

    function setProgressUI(pct, title, subtitle, speed, eta, size) {
        setRing(pct);
        if (title    != null) progressTitle.textContent    = title;
        if (subtitle != null) progressSubtitle.textContent = subtitle;
        if (speed    != null) statSpeed.textContent = speed || '—';
        if (eta      != null) statEta.textContent   = (eta === '00:00' ? 'Almost done' : eta) || '—';
        if (size     != null) statSize.textContent  = size  || '—';
    }

    // ══════════════════════════════════════════════════════════
    //  DOWNLOAD BUTTON HANDLERS
    // ══════════════════════════════════════════════════════════
    mp4Btn.addEventListener('click', () => triggerDownload('video'));
    mp3Btn.addEventListener('click', () => triggerDownload('audio'));

    // ══════════════════════════════════════════════════════════
    //  STATE HELPERS
    // ══════════════════════════════════════════════════════════
    function hideAll() {
        loadingState.classList.add('hidden');
        errorState.classList.add('hidden');
        resultState.classList.add('hidden');
    }

    function showLoading(msg = 'Processing…') {
        hideAll();
        loadingText.textContent = msg;
        loadingState.classList.remove('hidden');
    }

    function showError(msg) {
        hideAll();
        errorMessage.textContent = msg;
        errorState.classList.remove('hidden');
    }

    // ══════════════════════════════════════════════════════════
    //  QUALITY PILL BUILDER
    // ══════════════════════════════════════════════════════════
    function buildQualityPills(formats) {
        const pillsEl   = document.getElementById('quality-pills');
        const mp4BtnTxt = document.getElementById('mp4-btn-text');
        if (!pillsEl || !mp4BtnTxt) return;
        pillsEl.innerHTML = '';

        // Collect unique heights from all video-bearing formats
        const byHeight = new Map();
        formats
            .filter(f => f.vcodec && f.vcodec !== 'none' && f.height)
            .sort((a, b) => {
                // Prefer video-only (higher quality) over muxed at same height
                const aVO = (!a.acodec || a.acodec === 'none') ? 1 : 0;
                const bVO = (!b.acodec || b.acodec === 'none') ? 1 : 0;
                if (bVO !== aVO) return bVO - aVO;
                return (b.filesize || 0) - (a.filesize || 0);
            })
            .forEach(f => {
                if (!byHeight.has(f.height)) byHeight.set(f.height, f);
            });

        // Always lead with "Best" (no height constraint)
        const opts = [{ label: '🏆 Best', sub: 'Auto', height: null }];
        [...byHeight.keys()]
            .sort((a, b) => b - a)
            .forEach(h => {
                let label = `${h}p`;
                if (h >= 2160)      label = '4K';
                else if (h >= 1440) label = '2K';
                else if (h >= 1080) label = '1080p HD';
                else if (h >= 720)  label = '720p HD';
                opts.push({ label, sub: '', height: h });
            });

        // Reset selection
        selectedHeight = null;
        selectedLabel  = 'Best';
        mp4BtnTxt.textContent = 'Download MP4 — Best Quality';

        opts.forEach((opt, idx) => {
            const btn = document.createElement('button');
            btn.className = 'quality-pill' + (idx === 0 ? ' active' : '');
            btn.innerHTML = `<span class="qp-label">${opt.label}</span>${opt.sub ? `<span class="qp-sub">${opt.sub}</span>` : ''}`;
            btn.addEventListener('click', () => {
                document.querySelectorAll('.quality-pill').forEach(p => p.classList.remove('active'));
                btn.classList.add('active');
                selectedHeight = opt.height;
                selectedLabel  = opt.label.replace('🏆 ', '');
                mp4BtnTxt.textContent = `Download MP4 — ${selectedLabel}`;
            });
            pillsEl.appendChild(btn);
        });

        if (opts.length === 1) {
            pillsEl.insertAdjacentHTML('beforeend', '<span class="qp-note">Quality info unavailable — best will be used</span>');
        }
    }

    // ══════════════════════════════════════════════════════════
    //  SHOW RESULT
    // ══════════════════════════════════════════════════════════
    function showResult(info) {
        hideAll();

        // Thumbnail
        const thumb = document.getElementById('video-thumb');
        if (thumb) {
            thumb.innerHTML = info.thumbnail
                ? `<img src="${info.thumbnail}" alt="Thumbnail" style="width:100%;height:100%;object-fit:cover;border-radius:12px;">`
                : '<i class="fa-solid fa-video"></i>';
        }

        // Title
        const titleEl = document.getElementById('video-title-display');
        if (titleEl) titleEl.textContent = info.title ? `🎬 ${info.title}` : '';

        // Quality pills
        buildQualityPills(info.formats || []);

        resultState.classList.remove('hidden');
    }

});
