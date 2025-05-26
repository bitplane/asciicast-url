// Main asciicast decoder logic
const statusEl = document.getElementById('status');
const errorEl = document.getElementById('error');
const playerContainer = document.getElementById('player-container');
const uploadContainer = document.getElementById('upload-container');
const fileInput = document.getElementById('file-input');
const asciicastInput = document.getElementById('asciicast-input');
const goButton = document.getElementById('go-button');
const linkContainer = document.getElementById('link-container');
const shareLink = document.getElementById('share-link');
const compressionStats = document.getElementById('compression-stats');

// Base62 encoder/decoder implementation
const BASE62_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function base62Encode(bytes) {
    // Convert bytes to BigInt
    let num = 0n;
    for (let i = 0; i < bytes.length; i++) {
        num = (num << 8n) | BigInt(bytes[i]);
    }
    
    if (num === 0n) return '0';
    
    let result = '';
    while (num > 0n) {
        const remainder = num % 62n;
        result = BASE62_CHARS[Number(remainder)] + result;
        num = num / 62n;
    }
    
    return result;
}

function base62Decode(str) {
    let result = 0n;
    const base = 62n;
    
    for (let i = 0; i < str.length; i++) {
        const char = str[str.length - 1 - i];
        const value = BigInt(BASE62_CHARS.indexOf(char));
        result += value * (base ** BigInt(i));
    }
    
    // Convert BigInt to Uint8Array
    const hex = result.toString(16);
    // Ensure even length
    const paddedHex = hex.length % 2 ? '0' + hex : hex;
    
    const bytes = new Uint8Array(paddedHex.length / 2);
    for (let i = 0; i < paddedHex.length; i += 2) {
        bytes[i/2] = parseInt(paddedHex.substring(i, i+2), 16);
    }
    
    return bytes;
}

// XZ compression/decompression
async function xzCompress(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    
    // Create a readable stream from the data
    const inputStream = new ReadableStream({
        start(controller) {
            controller.enqueue(data);
            controller.close();
        }
    });
    
    // Compress using xzwasm
    const compressedStream = new xzwasm.XzReadableStream(inputStream, { preset: 9 }); // Use maximum compression
    
    // Read compressed data
    const chunks = [];
    const reader = compressedStream.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
    }
    
    // Combine chunks
    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }
    
    return result;
}

async function xzDecompress(data) {
    try {
        // Create a readable stream from the compressed data
        const stream = new xzwasm.XzReadableStream(new Response(data).body);
        
        // Read all chunks from the stream
        const chunks = [];
        const reader = stream.getReader();
        
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
        }
        
        // Combine all chunks into a single Uint8Array
        const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        
        // Convert bytes to text
        return new TextDecoder().decode(result);
    } catch (err) {
        console.error("XZ decompression failed:", err);
        throw new Error(`XZ decompression failed: ${err.message}`);
    }
}

// Process URL query parameters
function getQueryParam(name) {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get(name);
}

// Handle file upload
fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (e) => {
        asciicastInput.value = e.target.result;
    };
    reader.readAsText(file);
});

// Handle GO button click
goButton.addEventListener('click', async () => {
    const asciicastData = asciicastInput.value.trim();
    if (!asciicastData) {
        alert('Please upload a file or paste asciicast data');
        return;
    }
    
    try {
        // Validate it's proper asciicast format (first line should be valid JSON)
        const firstLine = asciicastData.split('\n')[0];
        JSON.parse(firstLine);
        
        const originalSize = new TextEncoder().encode(asciicastData).length;
        
        // Compress with XZ
        statusEl.textContent = 'Compressing data with XZ...';
        const compressed = await xzCompress(asciicastData);
        
        const compressedSize = compressed.length;
        const ratio = ((1 - compressedSize / originalSize) * 100).toFixed(1);
        
        // Encode to base62
        statusEl.textContent = 'Encoding data...';
        const encoded = base62Encode(compressed);
        
        // Create shareable URL
        const url = new URL(window.location);
        url.searchParams.set('cast', encoded);
        
        shareLink.href = url.toString();
        shareLink.textContent = url.toString();
        compressionStats.textContent = `Original: ${(originalSize/1024).toFixed(1)}KB → Compressed: ${(compressedSize/1024).toFixed(1)}KB (${ratio}% reduction)`;
        linkContainer.classList.remove('hidden');
        
        statusEl.textContent = 'Link generated! Click to play the asciicast.';
    } catch (err) {
        errorEl.textContent = `Error: ${err.message}`;
        errorEl.style.display = 'block';
        statusEl.textContent = 'Failed to generate link.';
    }
});

// Main processing function
async function processAsciicast() {
    const castParam = getQueryParam('cast');
    if (!castParam) {
        statusEl.textContent = 'Ready to upload or paste asciicast data.';
        uploadContainer.classList.remove('hidden');
        return;
    }
    
    try {
        statusEl.textContent = 'Decoding base62 data...';
        const decodedData = base62Decode(castParam);
        console.log('Decoded data:', decodedData.length, 'bytes');
        
        statusEl.textContent = 'Decompressing XZ data...';
        const decompressedText = await xzDecompress(decodedData);
        console.log('Decompressed text length:', decompressedText.length);
        
        statusEl.textContent = 'Processing asciicast data...';
        
        // Asciicast files are NDJSON format (newline-delimited JSON)
        // The player expects the raw text, not parsed JSON
        console.log('Asciicast data length:', decompressedText.length);
        console.log('First line:', decompressedText.split('\n')[0]);
        
        // Create and initialize the asciinema player
        statusEl.textContent = 'Creating player...';
        playerContainer.classList.remove('hidden');
        
        // Clear any existing content
        playerContainer.innerHTML = '';
        
        // Create the player element
        const playerEl = document.createElement('div');
        playerEl.id = 'player';
        playerContainer.appendChild(playerEl);
        
        // Initialize the asciinema player with the asciicast data
        // The player expects a URL or a File/Blob object
        // Create a Blob from the asciicast text
        const blob = new Blob([decompressedText], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        
        AsciinemaPlayer.create(url, playerEl, {
            fit: 'width',
            autoPlay: true
        });
        
        // Clean up the object URL when done
        playerEl.addEventListener('destroy', () => {
            URL.revokeObjectURL(url);
        });
        
        statusEl.textContent = 'Playing asciicast.';
    } catch (err) {
        errorEl.textContent = `Error: ${err.message}\n\nStack: ${err.stack}`;
        errorEl.style.display = 'block';
        statusEl.textContent = 'Failed to process asciicast.';
        console.error("Error details:", err);
        
        // Show upload container as fallback
        uploadContainer.classList.remove('hidden');
    }
}

// Start processing when the page loads
window.addEventListener('load', processAsciicast);