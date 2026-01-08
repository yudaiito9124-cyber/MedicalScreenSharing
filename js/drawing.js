// --- Konva / Drawing Globals ---
let localStage, localLayer;
let remoteStage, remoteLayer;
let isDrawing = false;

// Drawing State: Stores normalized lines to allow redrawing on resize
// Structure: { local: [ { points: [{x,y}, ...], color: '...' } ], remote: [...] }
const drawState = {
    local: [],  // Drawings on the local video
    remote: []  // Drawings on the remote video
};

// Current active line (normalized points accumulator)
let currentLocalLinePoints = null; // for drawing on local canvas
let currentRemoteLinePoints = null; // for drawing on remote canvas
let activeLinePolyline = null; // The actual Konva Line object being drawn currently

// Setup Stage
function initKonva() {
    // Local Canvas
    const localWrapper = document.getElementById('localWrapper');
    localStage = new Konva.Stage({
        container: 'localKonva',
        width: localWrapper.clientWidth,
        height: localWrapper.clientHeight,
    });
    localLayer = new Konva.Layer();
    localStage.add(localLayer);

    // Remote Canvas
    const remoteWrapper = document.getElementById('remoteWrapper');
    remoteStage = new Konva.Stage({
        container: 'remoteKonva',
        width: remoteWrapper.clientWidth,
        height: remoteWrapper.clientHeight,
    });
    remoteLayer = new Konva.Layer();
    remoteStage.add(remoteLayer);

    // Events
    setupDrawingEvents(localStage, localLayer, 'local', localVideo, localWrapper);
    setupDrawingEvents(remoteStage, remoteLayer, 'remote', remoteVideo, remoteWrapper);
}

// Helper: Video coordinate conversion
function getNormalizedVideoCoords(stageX, stageY, videoEl, wrapperEl) {
    if (!videoEl.videoWidth) return null;

    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;
    const ww = wrapperEl.clientWidth;
    const wh = wrapperEl.clientHeight;

    const videoAspect = vw / vh;
    const wrapperAspect = ww / wh;

    let renderW, renderH, offsetX, offsetY;

    if (wrapperAspect > videoAspect) {
        // Pillarbox
        renderH = wh;
        renderW = renderH * videoAspect;
        offsetX = (ww - renderW) / 2;
        offsetY = 0;
    } else {
        // Letterbox
        renderW = ww;
        renderH = renderW / videoAspect;
        offsetX = 0;
        offsetY = (wh - renderH) / 2;
    }

    if (stageX < offsetX || stageX > offsetX + renderW ||
        stageY < offsetY || stageY > offsetY + renderH) {
        return null;
    }

    const nx = (stageX - offsetX) / renderW;
    const ny = (stageY - offsetY) / renderH;
    return { x: nx, y: ny };
}

function getStageCoordsFromNormalized(nx, ny, videoEl, wrapperEl) {
    if (!videoEl.videoWidth) return { x: 0, y: 0 };

    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;
    const ww = wrapperEl.clientWidth;
    const wh = wrapperEl.clientHeight;

    const videoAspect = vw / vh;
    const wrapperAspect = ww / wh;

    let renderW, renderH, offsetX, offsetY;

    if (wrapperAspect > videoAspect) {
        renderH = wh;
        renderW = renderH * videoAspect;
        offsetX = (ww - renderW) / 2;
        offsetY = 0;
    } else {
        renderW = ww;
        renderH = renderW / videoAspect;
        offsetX = 0;
        offsetY = (wh - renderH) / 2;
    }

    const sx = offsetX + nx * renderW;
    const sy = offsetY + ny * renderH;
    return { x: sx, y: sy };
}

function setupDrawingEvents(stage, layer, contextName, videoElement, wrapperElement) {
    stage.on('mousedown touchstart', (e) => {
        isDrawing = true;
        const pos = stage.getPointerPosition();

        const norm = getNormalizedVideoCoords(pos.x, pos.y, videoElement, wrapperElement);
        if (norm) {
            // Start new line stroke
            const newLineEntry = {
                points: [{ x: norm.x, y: norm.y }],
                color: '#df4b26',
                isLocal: true // marked as drawn locally
            };
            drawState[contextName].push(newLineEntry);

            // Reference to the points array for high-freq updates
            if (contextName === 'local') currentLocalLinePoints = newLineEntry.points;
            else currentRemoteLinePoints = newLineEntry.points;

            // Visual
            activeLinePolyline = new Konva.Line({
                stroke: '#df4b26',
                strokeWidth: 5,
                globalCompositeOperation: 'source-over',
                points: [pos.x, pos.y],
                tension: 0,
                lineCap: 'round',
                lineJoin: 'round'
            });
            layer.add(activeLinePolyline);

            // Send
            sendDrawEvent('start', contextName, norm);
        } else {
            activeLinePolyline = null;
            if (contextName === 'local') currentLocalLinePoints = null;
            else currentRemoteLinePoints = null;
        }
    });

    stage.on('mousemove touchmove', (e) => {
        // Determine which accumulator current drawings belong to
        let currentPoints = (contextName === 'local') ? currentLocalLinePoints : currentRemoteLinePoints;

        if (!isDrawing || !activeLinePolyline || !currentPoints) return;

        e.evt.preventDefault();
        const pos = stage.getPointerPosition();

        // Add to visual
        const newPoints = activeLinePolyline.points().concat([pos.x, pos.y]);
        activeLinePolyline.points(newPoints);

        // Add to history (normalized)
        const norm = getNormalizedVideoCoords(pos.x, pos.y, videoElement, wrapperElement);
        if (norm) {
            currentPoints.push({ x: norm.x, y: norm.y });
            sendDrawEvent('move', contextName, norm);
        }
    });

    stage.on('mouseup touchend', () => {
        isDrawing = false;
        if (activeLinePolyline) {
            sendDrawEvent('end', contextName, null);
            activeLinePolyline = null;
            if (contextName === 'local') currentLocalLinePoints = null;
            else currentRemoteLinePoints = null;
        }
    });
}

function sendDrawEvent(action, originContext, normCoords) {
    if (typeof peer !== 'undefined' && peer && !peer.destroyed) {
        const data = JSON.stringify({
            type: 'draw',
            action: action,
            origin: originContext,
            coords: normCoords
        });
        try {
            peer.send(data);
        } catch (e) { /* ignore */ }
    }
}

// Handle incoming draw data
function handleDrawData(data) {
    let targetLayer, targetStage, targetVideo, targetWrapper, targetStateKey;

    // Mapping: Sender's 'local' -> Receiver's 'remote' canvas
    if (data.origin === 'local') {
        targetLayer = remoteLayer;
        targetStage = remoteStage;
        targetVideo = remoteVideo;
        targetWrapper = document.getElementById('remoteWrapper');
        targetStateKey = 'remote';
    } else {
        targetLayer = localLayer;
        targetStage = localStage;
        targetVideo = localVideo;
        targetWrapper = document.getElementById('localWrapper');
        targetStateKey = 'local';
    }

    if (data.action === 'clear') {
        drawState.local = [];
        drawState.remote = [];
        redrawAllLayers();
        return;
    }

    if (data.action === 'end') {
        targetStage.lastRemoteLinePoly = null;
        targetStage.lastRemotePoints = null;
        return;
    }

    if (!data.coords) return;

    if (data.action === 'start') {
        // Start new remote stroke
        const stagePos = getStageCoordsFromNormalized(data.coords.x, data.coords.y, targetVideo, targetWrapper);

        const newLineEntry = {
            points: [{ x: data.coords.x, y: data.coords.y }],
            color: '#df4b26', // same color for now
            isLocal: false
        };
        drawState[targetStateKey].push(newLineEntry);

        const line = new Konva.Line({
            stroke: '#df4b26',
            strokeWidth: 5,
            globalCompositeOperation: 'source-over',
            points: [stagePos.x, stagePos.y],
            tension: 0,
            lineCap: 'round',
            lineJoin: 'round'
        });

        targetLayer.add(line);

        targetStage.lastRemoteLinePoly = line;
        targetStage.lastRemotePoints = newLineEntry.points;

    } else if (data.action === 'move') {
        // Continue stroke
        const line = targetStage.lastRemoteLinePoly;
        const pointsArr = targetStage.lastRemotePoints;

        if (line && pointsArr) {
            const stagePos = getStageCoordsFromNormalized(data.coords.x, data.coords.y, targetVideo, targetWrapper);

            // visual
            const newPoints = line.points().concat([stagePos.x, stagePos.y]);
            line.points(newPoints);
            targetLayer.batchDraw();

            // history
            pointsArr.push({ x: data.coords.x, y: data.coords.y });
        }
    }
}

// Redraw all lines based on current container size
function redrawLayer(contextName, stage, layer, videoEl, wrapperEl) {
    layer.destroyChildren();

    const lines = drawState[contextName];
    if (!lines) return;

    lines.forEach(lineEntry => {
        // Convert all normalized points to stage points
        const flatPoints = [];
        lineEntry.points.forEach(pt => {
            const sp = getStageCoordsFromNormalized(pt.x, pt.y, videoEl, wrapperEl);
            flatPoints.push(sp.x, sp.y);
        });

        const kLine = new Konva.Line({
            stroke: lineEntry.color,
            strokeWidth: 5,
            points: flatPoints,
            tension: 0,
            lineCap: 'round',
            lineJoin: 'round'
        });
        layer.add(kLine);
    });
    layer.batchDraw();
}

function redrawAllLayers() {
    const localWrapper = document.getElementById('localWrapper');
    const remoteWrapper = document.getElementById('remoteWrapper');
    const localVideo = document.getElementById('localVideo');
    const remoteVideo = document.getElementById('remoteVideo');

    if (localStage && localWrapper && localVideo) {
        localStage.width(localWrapper.clientWidth);
        localStage.height(localWrapper.clientHeight);
        redrawLayer('local', localStage, localLayer, localVideo, localWrapper);
    }
    if (remoteStage && remoteWrapper && remoteVideo) {
        remoteStage.width(remoteWrapper.clientWidth);
        remoteStage.height(remoteWrapper.clientHeight);
        redrawLayer('remote', remoteStage, remoteLayer, remoteVideo, remoteWrapper);
    }
}

function clearAllDrawings() {
    drawState.local = [];
    drawState.remote = [];
    redrawAllLayers();

    if (typeof peer !== 'undefined' && peer && !peer.destroyed) {
        peer.send(JSON.stringify({ type: 'draw', action: 'clear' }));
    }
}

// Handle Resize
window.addEventListener('resize', () => {
    requestAnimationFrame(redrawAllLayers);
});
