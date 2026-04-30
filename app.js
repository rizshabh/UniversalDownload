document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('download-form');
    const urlInput = document.getElementById('video-url');
    const pasteBtn = document.getElementById('paste-btn');

    const loadingState = document.getElementById('loading-state');
    const errorState = document.getElementById('error-state');
    const resultState = document.getElementById('result-state');
    const errorMessage = document.getElementById('error-message');
    const retryBtn = document.getElementById('retry-btn');

    const downloadMp4Btn = document.getElementById('download-link-mp4');
    const downloadMp3Btn = document.getElementById('download-link-mp3');

    const API_BASE = ''; // Relative URL — works on localhost AND live hosting

    // ── Paste Button ────────────────────────────────────────────────
    pasteBtn.addEventListener('click', async () => {
        try {
            const text = await navigator.clipboard.readText();
            if (text) urlInput.value = text;
        } catch (_) {
            alert('Could not access clipboard. Please paste with Ctrl+V.');
        }
    });

    // ── Retry Button ────────────────────────────────────────────────
    retryBtn.addEventListener('click', () => {
        hideAllStates();
        urlInput.value = '';
        urlInput.focus();
    });

    // ── Form Submit ─────────────────────────────────────────────────
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const url = urlInput.value.trim();
        if (!url) return;

        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            showError('Please enter a valid URL starting with https://');
            return;
        }

        showLoading('Fetching video info...');

        try {
            const res = await fetch(`${API_BASE}/api/info`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url })
            });

            const data = await res.json();

            if (!res.ok || data.error) {
                throw new Error(data.error || 'Failed to get video info.');
            }

            showResult(data, url);

        } catch (err) {
            console.error(err);
            showError(err.message || 'Could not process this URL. Make sure the server is running and the link is valid.');
        }
    });

    // ── State Helpers ────────────────────────────────────────────────
    function hideAllStates() {
        loadingState.classList.add('hidden');
        errorState.classList.add('hidden');
        resultState.classList.add('hidden');
    }

    function showLoading(msg = 'Processing...') {
        hideAllStates();
        loadingState.querySelector('p').textContent = msg;
        loadingState.classList.remove('hidden');
    }

    function showError(msg) {
        hideAllStates();
        errorMessage.textContent = msg;
        errorState.classList.remove('hidden');
    }

    function showResult(info, originalUrl) {
        hideAllStates();

        // Update video thumbnail if available
        const previewBox = document.querySelector('.video-preview-placeholder');
        if (info.thumbnail) {
            previewBox.innerHTML = `<img src="${info.thumbnail}" alt="Video Thumbnail" style="width:100%;height:100%;object-fit:cover;border-radius:12px;">`;
        } else {
            previewBox.innerHTML = `<i class="fa-solid fa-video"></i>`;
        }

        // Add title display
        let titleEl = document.getElementById('video-title-display');
        if (!titleEl) {
            titleEl = document.createElement('p');
            titleEl.id = 'video-title-display';
            titleEl.style.cssText = 'margin-bottom:15px;font-weight:600;font-size:1rem;color:#f8fafc;text-align:left;word-break:break-word;';
            document.querySelector('.download-options').before(titleEl);
        }
        if (info.title) titleEl.textContent = `🎬 ${info.title}`;

        // Set up MP4 download
        const encodedUrl = encodeURIComponent(originalUrl);
        downloadMp4Btn.href = `${API_BASE}/api/download?url=${encodedUrl}&type=video`;
        downloadMp4Btn.download = 'video.mp4';
        downloadMp4Btn.onclick = (e) => {
            downloadMp4Btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Downloading... Please wait';
            downloadMp4Btn.classList.add('disabled');
            // Re-enable after delay (download is a link, browser handles it)
            setTimeout(() => {
                downloadMp4Btn.innerHTML = '<i class="fa-solid fa-film"></i> Download MP4 (Highest Quality)';
                downloadMp4Btn.classList.remove('disabled');
            }, 5000);
        };

        // Set up MP3 download
        downloadMp3Btn.href = `${API_BASE}/api/download?url=${encodedUrl}&type=audio`;
        downloadMp3Btn.download = 'audio.mp3';
        downloadMp3Btn.onclick = (e) => {
            downloadMp3Btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Extracting Audio...';
            downloadMp3Btn.classList.add('disabled');
            setTimeout(() => {
                downloadMp3Btn.innerHTML = '<i class="fa-solid fa-music"></i> Download MP3 (Audio Only)';
                downloadMp3Btn.classList.remove('disabled');
            }, 5000);
        };

        resultState.classList.remove('hidden');
    }
});
