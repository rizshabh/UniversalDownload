FROM node:20-bookworm-slim

# Install necessary system dependencies for Puppeteer, ffmpeg, and yt-dlp
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ffmpeg \
    python3 \
    chromium \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp binary
RUN wget -qO /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

# Tell Puppeteer to use the installed Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Set up working directory
WORKDIR /app

# Copy package.json and install dependencies
COPY package*.json ./
RUN npm install

# Copy application code
COPY . .

# Expose the port
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
