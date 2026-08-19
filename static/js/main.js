// Global Detection State
const detectionsContainer = document.getElementById('detectionsContainer');
const trackHistory = new Map(); // track_id -> { shown: boolean, status: string, label: string }
let detectionCount = 0;
let recognizedCount = 0;
let unknownCount = 0;
let sharedMediaStream = null; // Cached stream to share the webcam across all 6 panels
const cameraInstances = [];

class CameraSystem {
    constructor(videoElement, canvasElement, toggleButton, cameraIndex, deviceIndex = null, sourceUrl = null, startInactive = false) {
        cameraInstances.push(this);
        this.video = videoElement;
        this.canvas = canvasElement;
        this.ctx = canvasElement.getContext('2d');
        this.toggleButton = toggleButton;
        this.statusIndicator = this.toggleButton.parentElement.querySelector('.status-indicator');
        this.cameraIndex = cameraIndex;
        this.deviceIndex = deviceIndex;
        this.sourceUrl = sourceUrl;
        this.fallbackToLocal = deviceIndex !== null;
        this.stream = null;
        this.processing = false;
        this.lastProcessTime = 0;
        this.frameInterval = 100; // 10 FPS (1000ms/10 = 100ms)
        this.isActive = false;
        this.activeTracks = new Set();
        this.isRemoteSource = Boolean(sourceUrl);

        // Set up toggle button listener first so inactive cameras can be connected
        this.setupEventListeners();

        if (startInactive) {
            // Don't auto-connect — just show offline state
            this.updateButtonState('Connect', 'OFF', 'status-offline');
        } else {
            this.initializeCamera();
        }
    }

    async initializeCamera() {
        try {
            if (this.isRemoteSource) {
                await this.setupVideoSource();
            } else {
                await this.setupMediaStream();
            }
            this.startProcessing();
            this.updateButtonState('Disconnect', 'LIVE', 'status-live');
        } catch (error) {
            console.error(`Camera ${this.cameraIndex} initialization failed:`, error);
            this.handleCameraError(error);
        }
    }

    async setupMediaStream() {
        // Reuse the already opened stream if available and active
        if (sharedMediaStream && sharedMediaStream.active) {
            console.log(`CameraSystem[${this.cameraIndex}] reusing shared local video stream`);
            this.stream = sharedMediaStream;
            this.video.srcObject = this.stream;
            
            // Try to trigger video play immediately
            this.video.play().catch(e => console.warn('Play failed on reused stream:', e));

            if (this.video.readyState >= 1) { // HAVE_METADATA or higher
                this.updateCanvasDimensions();
            } else {
                await new Promise((resolve, reject) => {
                    let resolved = false;
                    const onLoadedMeta = () => {
                        if (resolved) return;
                        resolved = true;
                        this.updateCanvasDimensions();
                        resolve();
                    };
                    const onError = (event) => {
                        if (resolved) return;
                        resolved = true;
                        reject(new Error('Unable to reuse shared local camera stream.'));
                    };
                    this.video.addEventListener('loadedmetadata', onLoadedMeta, { once: true });
                    this.video.addEventListener('error', onError, { once: true });
                    // Safety timeout of 2 seconds
                    setTimeout(() => {
                        if (resolved) return;
                        resolved = true;
                        console.warn(`CameraSystem[${this.cameraIndex}] shared stream metadata load timeout fallback`);
                        this.updateCanvasDimensions();
                        resolve();
                    }, 2000);
                });
            }
            return;
        }

        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(device => device.kind === 'videoinput');

        // Diagnostic: log available video devices for debugging
        try {
            console.log(`CameraSystem[${this.cameraIndex}] - available video devices:`, videoDevices);
            if (videoDevices.length > 0) {
                const labels = videoDevices.map((d, i) => `${i}: ${d.label || d.deviceId}`);
                // attach a tooltip to the toggle button so user can see which device index will be used
                try { this.toggleButton.title = labels.join('\n'); } catch (e) {}
                try { this.statusIndicator.title = labels.join('\n'); } catch (e) {}
            }
        } catch (e) {
            console.warn('Failed to write device diagnostics', e);
        }

        if (videoDevices.length === 0) {
            throw new Error('No local video input devices found');
        }

        const selectedIndex = this.deviceIndex !== null ? this.deviceIndex : 0;
        if (videoDevices.length <= selectedIndex) {
            throw new Error(`Local camera device ${selectedIndex} not available`);
        }

        const desiredDeviceId = videoDevices[selectedIndex].deviceId;
        console.log(`CameraSystem[${this.cameraIndex}] using local device index ${selectedIndex}:`, videoDevices[selectedIndex]);

        // Try strict constraints first, then progressively relax them on failure
        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    deviceId: { exact: desiredDeviceId },
                    width: { min: 640, ideal: 1280 },
                    height: { min: 480, ideal: 720 }
                }
            });
        } catch (err) {
            console.warn(`CameraSystem[${this.cameraIndex}] strict getUserMedia failed:`, err);

            // If constraints are not satisfied, try without width/height
            if (err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError') {
                try {
                    this.stream = await navigator.mediaDevices.getUserMedia({
                        video: { deviceId: { exact: desiredDeviceId } }
                    });
                    console.info(`CameraSystem[${this.cameraIndex}] succeeded using deviceId without size constraints`);
                } catch (err2) {
                    console.warn(`CameraSystem[${this.cameraIndex}] deviceId fallback failed:`, err2);
                }
            }

            // If still no stream, try default camera (no deviceId)
            if (!this.stream) {
                try {
                    this.stream = await navigator.mediaDevices.getUserMedia({ video: true });
                    console.info(`CameraSystem[${this.cameraIndex}] succeeded using default camera`);
                } catch (err3) {
                    console.error(`CameraSystem[${this.cameraIndex}] final fallback failed:`, err3);
                    throw err3;
                }
            }
        }

        // Cache the newly requested stream so other panels can reuse it
        sharedMediaStream = this.stream;

        this.video.srcObject = this.stream;
        this.video.play().catch(e => console.warn('Play failed on fresh stream:', e));

        if (this.video.readyState >= 1) {
            this.updateCanvasDimensions();
        } else {
            await new Promise((resolve, reject) => {
                let resolved = false;
                const onLoadedMeta = () => {
                    if (resolved) return;
                    resolved = true;
                    this.updateCanvasDimensions();
                    resolve();
                };
                const onError = (event) => {
                    if (resolved) return;
                    resolved = true;
                    const err = new Error('Unable to access local camera. Check permissions and device availability.');
                    try { console.error(`CameraSystem[${this.cameraIndex}] getUserMedia error:`, event); } catch (e) {}
                    reject(err);
                };
                this.video.addEventListener('loadedmetadata', onLoadedMeta, { once: true });
                this.video.addEventListener('error', onError, { once: true });
                // Safety timeout of 2 seconds
                setTimeout(() => {
                    if (resolved) return;
                    resolved = true;
                    console.warn(`CameraSystem[${this.cameraIndex}] fresh stream metadata load timeout fallback`);
                    this.updateCanvasDimensions();
                    resolve();
                }, 2000);
            });
        }
    }

    async setupVideoSource() {
        if (!this.sourceUrl) {
            throw new Error('No video source URL specified');
        }

        const supportedProtocols = ['http://', 'https://', 'blob:', 'data:'];
        if (!supportedProtocols.some(protocol => this.sourceUrl.startsWith(protocol))) {
            if (this.fallbackToLocal) {
                console.warn(`Camera ${this.cameraIndex} received unsupported source ${this.sourceUrl}; falling back to local camera ${this.deviceIndex}`);
                return this.setupMediaStream();
            }
            throw new Error(`Unsupported browser video source protocol: ${this.sourceUrl}. Use HTTP/HTTPS streaming or a browser-compatible proxy.`);
        }

        this.video.crossOrigin = 'anonymous';
        this.video.muted = true;
        this.video.playsInline = true;
        this.video.src = this.sourceUrl;

        // Try to trigger video play immediately
        this.video.play().catch(e => console.warn('Play failed on video source:', e));

        if (this.video.readyState >= 1) {
            this.updateCanvasDimensions();
        } else {
            await new Promise((resolve, reject) => {
                let resolved = false;
                const onLoadedMeta = () => {
                    if (resolved) return;
                    resolved = true;
                    this.updateCanvasDimensions();
                    resolve();
                };
                const onError = () => {
                    if (resolved) return;
                    resolved = true;
                    reject(new Error(`Unable to load video source: ${this.sourceUrl}`));
                };
                this.video.addEventListener('loadedmetadata', onLoadedMeta, { once: true });
                this.video.addEventListener('error', onError, { once: true });
                // Safety timeout of 2 seconds
                setTimeout(() => {
                    if (resolved) return;
                    resolved = true;
                    console.warn(`CameraSystem[${this.cameraIndex}] remote stream metadata load timeout fallback`);
                    this.updateCanvasDimensions();
                    resolve();
                }, 2000);
                this.video.load();
            });
        }
    }

    setupEventListeners() {
        window.addEventListener('resize', () => this.updateCanvasDimensions());
        this.toggleButton.addEventListener('click', () => this.toggleCamera());
    }

    startProcessing() {
        this.isActive = true;
        this.video.play();
        this.processVideoFrames();
        updateActiveCameraCount();
    }

    async processVideoFrames() {
        if (!this.isActive) return;

        const currentTime = Date.now();
        if (currentTime - this.lastProcessTime >= this.frameInterval) {
            await this.processFrame();
            this.lastProcessTime = currentTime;
        }

        requestAnimationFrame(() => this.processVideoFrames());
    }

    async processFrame() {
        if (this.processing || this.video.readyState !== 4) return;
        this.processing = true;

        try {
            const frame = this.captureVideoFrame();
            const detections = await this.sendForAnalysis(frame);
            this.handleDetectionResults(detections);
        } catch (error) {
            console.error('Frame processing error:', error);
        } finally {
            this.processing = false;
        }
    }

    captureVideoFrame() {
        const frameCanvas = document.createElement('canvas');
        frameCanvas.width = this.video.videoWidth;
        frameCanvas.height = this.video.videoHeight;
        const frameCtx = frameCanvas.getContext('2d');
        frameCtx.drawImage(this.video, 0, 0);
        return frameCanvas.toDataURL('image/jpeg', 0.7);
    }

    async sendForAnalysis(frameData) {
        const response = await fetch('/getdata/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                image: frameData,
                camera_id: this.cameraIndex
            })
        });
        if (!response.ok) {
            const errText = await response.text();
            console.error(`Camera ${this.cameraIndex} analysis failed (${response.status}):`, errText);
            return [];
        }
        return response.json();
    }

    handleDetectionResults(results) {
        if (Array.isArray(results)) {
            this.drawDetectionBoxes(results);

            // Process detections for this camera
            results.forEach(result => {
                if (result.track_id) {
                    // Only process new tracks
                    if (!trackHistory.has(result.track_id)) {
                        const isRecognized = result.status === 'recognized';

                        trackHistory.set(result.track_id, {
                            shown: false,
                            status: result.status,
                            label: result.label,
                            cameraIndex: this.cameraIndex
                        });

                        // Update counts
                        detectionCount++;
                        if (isRecognized) {
                            recognizedCount++;
                        } else {
                            unknownCount++;
                        }
                    }

                    // Get track info
                    const trackInfo = trackHistory.get(result.track_id);

                    // Create UI entry only if not shown before
                    if (!trackInfo.shown) {
                        createDetectionEntry(result, this.cameraIndex);
                        trackInfo.shown = true;
                        updateStatElements();
                    }
                }
            });
        }
    }

    drawDetectionBoxes(detections) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        const scaleX = this.canvas.width / this.video.videoWidth;
        const scaleY = this.canvas.height / this.video.videoHeight;

//        detections.forEach(detection => {
//            if (!detection.bbox) return;
//
//            const [x1, y1, x2, y2] = detection.bbox;
//            const width = x2 - x1;
//            const height = y2 - y1;
//
//            this.ctx.strokeStyle = detection.color || '#FF0000';
//            this.ctx.lineWidth = 2;
//            this.ctx.strokeRect(
//                x1 * scaleX,
//                y1 * scaleY,
//                width * scaleX,
//                height * scaleY
//            );
//
//            this.ctx.fillStyle = detection.color || '#FF0000';
//            this.ctx.font = '20px Arial';
//
//            this.ctx.fillText(
//                `${detection.label || 'Processing...'} `,
////                `${detection.label || 'Processing...'} ${Math.round(detection.confidence * 100)}%`,
//
//                x1 * scaleX,
//                y1 * scaleY - 10
//            );
//        });
            detections.forEach(detection => {
                    if (!detection.bbox) return;

                    const [x1, y1, x2, y2] = detection.bbox;
                    const width = x2 - x1;
                    const height = y2 - y1;

                    // --- Draw Bounding Box ---
                    this.ctx.strokeStyle = detection.color || '#FF0000';
                    this.ctx.lineWidth = 2;
                    this.ctx.strokeRect(
                        x1 * scaleX,
                        y1 * scaleY,
                        width * scaleX,
                        height * scaleY
                    );

                    // --- Text Label with Background ---
                    const labelText = detection.label || 'Processing...';
                    const roleAccessStr = (detection.role && detection.access_level) ? ` [${detection.role} - ${detection.access_level}]` : '';
                    const text = `${labelText}${roleAccessStr} ${Math.round(detection.confidence * 100)}%`;
                    this.ctx.font = '16px Arial';

                    // 1. Measure text dimensions
                    const textMetrics = this.ctx.measureText(text);
                    const textWidth = textMetrics.width;
                    const textHeight = 16; // Approximate height based on font size
                    const padding = 4;

                    // 2. Draw the background rectangle
                    const rectX = x1 * scaleX;
                    // Position the rectangle right above the bounding box
                    const rectY = y1 * scaleY - textHeight - (padding * 2);
                    this.ctx.fillStyle = detection.color || '#FF0000'; // Background color
                    this.ctx.fillRect(
                        rectX,
                        rectY,
                        textWidth + (padding * 2),
                        textHeight + (padding * 2)
                    );

                    // 3. Draw the text on top of the background
                    this.ctx.fillStyle = '#FFFFFF'; // Text color (white for contrast)
                    this.ctx.fillText(
                        text,
                        rectX + padding,
                        rectY + textHeight + padding // Position text inside the rectangle
                    );
                });
    }

    updateCanvasDimensions() {
        const videoWidth = this.video.videoWidth || 640;
        const videoHeight = this.video.videoHeight || 480;
        const videoRatio = videoWidth / videoHeight;
        const container = this.video.parentElement;

        if (!container) return;

        let containerWidth = container.clientWidth;
        let containerHeight = container.clientHeight;

        // Fall back to video size if container is collapsed or not rendered yet
        if (!containerWidth || !containerHeight) {
            containerWidth = videoWidth;
            containerHeight = videoHeight;
        }

        let width, height;
        if (containerWidth / containerHeight > videoRatio) {
            height = containerHeight;
            width = height * videoRatio;
        } else {
            width = containerWidth;
            height = width / videoRatio;
        }

        // Guarantee a minimum display dimension
        width = Math.max(width, 320);
        height = Math.max(height, 180);

        this.canvas.width = width;
        this.canvas.height = height;
        this.canvas.style.width = `${width}px`;
        this.canvas.style.height = `${height}px`;
    }

    stopCamera() {
        this.isActive = false;
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.video.srcObject = null;
            this.stream = null;
        }

        if (this.isRemoteSource) {
            this.video.pause();
            this.video.removeAttribute('src');
            this.video.load();
        }

        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.updateButtonState('Connect', 'OFFLINE', 'status-offline');
        updateActiveCameraCount();
    }

    async connectCamera() {
        try {
            if (this.isRemoteSource) {
                await this.setupVideoSource();
            } else {
                await this.setupMediaStream();
            }
            this.startProcessing();
            this.updateButtonState('Disconnect', 'LIVE', 'status-live');
        } catch (error) {
            console.error(`Camera ${this.cameraIndex} connection failed:`, error);
            this.handleCameraError(error);
        }
    }

    toggleCamera() {
        if (this.isActive) {
            this.stopCamera();
        } else {
            this.connectCamera();
        }
    }

    updateButtonState(buttonText, statusText, statusClass) {
        this.toggleButton.textContent = buttonText;
        this.statusIndicator.textContent = statusText;
        this.statusIndicator.className = 'status-indicator';
        this.statusIndicator.classList.add(statusClass);
    }

    handleCameraError(error) {
        console.error(`Camera ${this.cameraIndex} failed`, error);
        if (this.canvas) {
            this.canvas.style.backgroundColor = '#ff000020';
        }
        // Allow the user to attempt reconnects instead of permanently disabling the button
        this.toggleButton.disabled = false;
        this.toggleButton.textContent = 'Reconnect';
        // Show a helpful tooltip with the error message
        const msg = error && error.message ? error.message : (error ? String(error) : 'Unknown camera error');
        try { this.toggleButton.title = msg; } catch (e) {}
        try { this.statusIndicator.title = msg; } catch (e) {}

        this.statusIndicator.textContent = 'ERROR';
        this.statusIndicator.className = 'status-indicator';
        this.statusIndicator.classList.add('status-error');
        updateActiveCameraCount();
    }
}

// Global Functions
function updateStatElements() {
    const elements = {
        '.card:nth-child(2) .stat-number': detectionCount,
        '.card:nth-child(3) .stat-number': unknownCount,
        '.card:nth-child(4) .stat-number': recognizedCount
    };

    Object.entries(elements).forEach(([selector, value]) => {
        const element = document.querySelector(selector);
        if (element) element.textContent = value;
    });
}

function createDetectionEntry(detection, cameraIndex) {
    const timeStr = detection.timestamp ?
        new Date(detection.timestamp).toLocaleTimeString() :
        new Date().toLocaleTimeString();

    const roleTag = detection.role ? `<div style="font-size:0.75rem; color:#2db7f5; margin-top:2px;">${detection.role} &bull; ${detection.access_level || 'Full Access'}</div>` : '';

    const detectionItem = document.createElement('div');
    detectionItem.className = 'det-item';
    detectionItem.innerHTML = `
        <div class="det-item-name">
            <i class="fas fa-video det-icon"></i>
            <div>
                <strong>${detection.label || 'Unknown'}</strong>
                ${roleTag}
                <small>Camera ${cameraIndex + 1} - ${timeStr}</small>
            </div>
        </div>
        <div class="det-det">
            <div class="det-status ${detection.status || 'unknown'}">
                ${(detection.status || 'Unknown').toUpperCase()}
            </div>
            <small>${Math.round(detection.confidence * 100)}% match</small>
        </div>
    `;

    detectionsContainer.prepend(detectionItem);
    maintainDetectionListLimit();
}

function maintainDetectionListLimit() {
    while (detectionsContainer.children.length > 80) {
        detectionsContainer.removeChild(detectionsContainer.lastChild);
    }
}

async function getVideoInputDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        return [];
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(device => device.kind === 'videoinput');
}

function updateActiveCameraCount() {
    const activeCount = cameraInstances.filter(cam => cam.isActive).length;
    const activeEl = document.querySelector('.card:nth-child(1) .stat-number');
    if (activeEl) {
        activeEl.textContent = activeCount;
    }
}

async function initializeCameraSystems() {
    try {
        const cameras = document.querySelectorAll('.cam-card');
        const localDevices = await getVideoInputDevices();
        const availableDeviceIndices = localDevices.map((_, index) => index);

        console.log('Detected local video devices:', localDevices);

        let localCameraCounter = 0;
        let initializedCount = 0;

        for (const [index, cameraCard] of cameras.entries()) {
            const videoElement = cameraCard.querySelector('video');
            const canvasElement = cameraCard.querySelector('canvas');
            const toggleButton = cameraCard.querySelector('.toggle-camera');

            if (!videoElement || !canvasElement || !toggleButton) {
                continue;
            }

            const sourceUrl = videoElement.getAttribute('data-stream-src');
            let deviceIndex = null;
            let startInactive = false;

            if (!sourceUrl) {
                if (localCameraCounter < availableDeviceIndices.length) {
                    deviceIndex = availableDeviceIndices[localCameraCounter];
                    localCameraCounter += 1;
                } else {
                    // No physical webcam available for this slot, start as inactive/offline
                    console.log(`Starting camera card ${index} as inactive (offline) since no physical webcam device is available`);
                    startInactive = true;
                }
            } else {
                // Check if remote camera should start inactive (based on current HTML button state)
                const buttonText = toggleButton.textContent.trim().toLowerCase();
                startInactive = (buttonText === 'connect' || buttonText === 'disconnected');
            }

            console.log(`Assigning camera card ${index} -> deviceIndex=${deviceIndex}, sourceUrl=${sourceUrl || 'local'}, inactive=${startInactive}`);

            new CameraSystem(
                videoElement,
                canvasElement,
                toggleButton,
                index, // use static index so it maps correctly to CAM IDs
                deviceIndex,
                sourceUrl || null,
                startInactive
            );
            initializedCount += 1;
        }

        // Dynamically update the total cameras "of X" in the stats card
        const totalCamerasEl = document.querySelector('.card:nth-child(1) .stat-detail');
        if (totalCamerasEl) {
            totalCamerasEl.textContent = `of ${initializedCount}`;
        }
        updateActiveCameraCount();
    } catch (error) {
        console.error('Camera initialization error:', error);
        alert('Error initializing cameras. Please check your devices and permissions.');
    }
}

// Initialize on DOM Load
document.addEventListener('DOMContentLoaded', () => {
    initializeCameraSystems();

    // Clear detections button
    document.querySelector('.clear-detections')?.addEventListener('click', () => {
        detectionsContainer.innerHTML = '';
        detectionCount = 0;
        recognizedCount = 0;
        unknownCount = 0;
        trackHistory.clear();
        updateStatElements();
    });
});