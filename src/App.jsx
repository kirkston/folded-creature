import { useState, useRef, useEffect, useCallback } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────
const SECTIONS = [
  { id: "head",  part: "HEAD",  color: "#C0392B", hint: "Draw a head — stop near the neck. The next person sees just the bottom edge to connect from." },
  { id: "body",  part: "BODY",  color: "#C0392B", hint: "Connect from the faint lines at top and draw the torso down to the hips." },
  { id: "legs",  part: "LEGS",  color: "#C0392B", hint: "Connect from the faint lines at top and draw the legs and feet all the way down!" },
];
const CANVAS_W = 380;
const CANVAS_H = 320;
const PEEK_H   = 28;
const COLORS   = ["#1a1a1a","#C0392B","#2980b9","#27ae60","#e67e22","#8e44ad","#16a085","#d35400","#7f8c8d","#ffffff"];
const POLL_MS  = 3000; // how often joiners poll for next section

// ─── Firebase storage layer ──────────────────────────────────────────────────
// Uses static imports (Vite build) — works on any hosted domain.
import { initializeApp } from "firebase/app";
import { getDatabase, ref, get, set } from "firebase/database";

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCnZS_zSEn5SL38nyXs2eqD2tgED4EZ3vQ",
  authDomain: "folded-creature.firebaseapp.com",
  databaseURL: "https://folded-creature-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "folded-creature",
  storageBucket: "folded-creature.firebasestorage.app",
  messagingSenderId: "353480202088",
  appId: "1:353480202088:web:9442079620b40ba733e8dd",
};
const FIREBASE_ENABLED = !!FIREBASE_CONFIG.databaseURL;

const STORAGE_PREFIX = "fc_game:";
const _memStore = {};
let _storageMode = null;
let _firebaseDb = null;

function _initFirebase() {
  if (!FIREBASE_ENABLED || _firebaseDb) return _firebaseDb;
  try {
    const app = initializeApp(FIREBASE_CONFIG);
    _firebaseDb = { db: getDatabase(app), ref, get, set };
    return _firebaseDb;
  } catch(e) {
    console.warn("Firebase init failed, falling back:", e.message);
    return null;
  }
}

async function _detectStorage() {
  if (_storageMode) return _storageMode;
  if (FIREBASE_ENABLED) {
    const fb = _initFirebase();
    if (fb) { _storageMode = "firebase"; return _storageMode; }
  }
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const k = "__fc_probe:" + Date.now();
      window.localStorage.setItem(k, "1");
      const ok = window.localStorage.getItem(k) === "1";
      window.localStorage.removeItem(k);
      if (ok) { _storageMode = "localStorage"; return _storageMode; }
    }
  } catch(e) { /* fall through */ }
  _storageMode = "memory";
  return _storageMode;
}

async function storeGame(code, data) {
  const mode = await _detectStorage();
  const key = STORAGE_PREFIX + code;
  const json = JSON.stringify(data);
  try {
    if (mode === "firebase") {
      await _firebaseDb.set(_firebaseDb.ref(_firebaseDb.db, "games/" + code), data);
    } else if (mode === "localStorage") {
      window.localStorage.setItem(key, json);
    } else {
      _memStore[key] = json;
    }
  } catch(e) {
    console.warn("storeGame fallback to memory:", e.message);
    _storageMode = "memory";
    _memStore[key] = json;
    throw new Error("Storage failed: " + (e.message || String(e)));
  }
}
async function loadGame(code) {
  const mode = await _detectStorage();
  const key = STORAGE_PREFIX + code;
  try {
    if (mode === "firebase") {
      const snap = await _firebaseDb.get(_firebaseDb.ref(_firebaseDb.db, "games/" + code));
      return snap.exists() ? snap.val() : null;
    }
    const raw = (mode === "localStorage")
      ? window.localStorage.getItem(key)
      : _memStore[key];
    return raw ? JSON.parse(raw) : null;
  } catch(e) {
    throw new Error("Storage get failed: " + (e.message || String(e)));
  }
}
async function getStorageMode() { return await _detectStorage(); }
function makeCode() {
  return Math.random().toString(36).slice(2,7).toUpperCase();
}
// Generate connection anchor points — fixed symmetric positions so they feel intentional.
// Three points: left-third, centre, right-third of the canvas.
function makeAnchors(width = 380) {
  const pts = [
    Math.round(width * 0.25),
    Math.round(width * 0.50),
    Math.round(width * 0.75),
  ];
  return { head_to_body: pts, body_to_legs: pts };
}

// ─── DrawingCanvas ────────────────────────────────────────────────────────────
// Flood fill helper for the bucket tool. Stops at any pixel that's notably
// darker than the start pixel (treats ink as a boundary). Operates in-place
// on the given canvas context.
function floodFillAt(ctx, startX, startY, hexColour) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  if (startX < 0 || startX >= W || startY < 0 || startY >= H) return;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  // Read start pixel — we'll only flood pixels with similar brightness
  const sIdx = (startY * W + startX) * 4;
  const sR = d[sIdx], sG = d[sIdx+1], sB = d[sIdx+2];
  const sBright = (sR + sG + sB) / 3;
  // Don't fill if the user tapped on dark ink (they tapped a line, not a region)
  if (sBright < 100) return;
  // Parse target colour
  const hex = hexColour.replace("#", "");
  const tR = parseInt(hex.slice(0, 2), 16);
  const tG = parseInt(hex.slice(2, 4), 16);
  const tB = parseInt(hex.slice(4, 6), 16);
  // Don't fill if target colour is the same as start pixel (already this colour)
  if (Math.abs(tR - sR) < 5 && Math.abs(tG - sG) < 5 && Math.abs(tB - sB) < 5) return;
  // BFS flood fill — accept pixels within a brightness tolerance of the start pixel
  const visited = new Uint8Array(W * H);
  const stack = [[startX, startY]];
  // Tolerance: how much darker can a pixel be before it counts as "ink"?
  // 80 brightness units gives a reasonable buffer — pen strokes are usually <100 brightness,
  // start is >100, so we want to stop somewhere between.
  const BRIGHT_TOLERANCE = 60;
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || x >= W || y < 0 || y >= H) continue;
    const i = y * W + x;
    if (visited[i]) continue;
    const di = i * 4;
    const bright = (d[di] + d[di+1] + d[di+2]) / 3;
    // Stop at ink: pixel notably darker than the start
    if (sBright - bright > BRIGHT_TOLERANCE) { visited[i] = 1; continue; }
    visited[i] = 1;
    d[di] = tR; d[di+1] = tG; d[di+2] = tB; d[di+3] = 255;
    stack.push([x+1, y], [x-1, y], [x, y+1], [x, y-1]);
  }
  ctx.putImageData(img, 0, 0);
}

function DrawingCanvas({ sectionIndex, onDone, peekImageData, peekHeight, anchors, doneLabel }) {
  const canvasRef  = useRef(null);
  const scrollRef  = useRef(null);  // ref for the scrollable zoom container
  const [color, setColor]       = useState("#1a1a1a");
  const [brushSize, setBrushSize] = useState(5);
  const [tool, setTool]         = useState("pen");
  const [zoom, setZoom]           = useState(false);
  const [scrollMode, setScrollMode] = useState(false); // true=scroll, false=draw (only matters when zoomed)
  const [undoStack, setUndoStack]  = useState([]);
  const toolRef      = useRef(tool);
  const colorRef     = useRef(color);
  const brushRef     = useRef(brushSize);
  const zoomRef      = useRef(zoom);
  const scrollModeRef = useRef(scrollMode);
  const isDrawingRef = useRef(false);
  const lastPos      = useRef(null);

  useEffect(() => { toolRef.current      = tool;       }, [tool]);
  useEffect(() => { colorRef.current     = color;      }, [color]);
  useEffect(() => { brushRef.current     = brushSize;  }, [brushSize]);
  useEffect(() => { zoomRef.current      = zoom;       }, [zoom]);
  useEffect(() => { scrollModeRef.current = scrollMode; }, [scrollMode]);

  const drawPeek = useCallback((ctx) => {
    if (!peekImageData) return;
    const img = new Image();
    img.onload = () => {
      ctx.save();
      ctx.globalAlpha = 0.38;
      const srcH = peekHeight || CANVAS_H;
      ctx.drawImage(img, 0, srcH - PEEK_H, CANVAS_W, PEEK_H, 0, 0, CANVAS_W, PEEK_H);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#c9b8b8";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.moveTo(0, PEEK_H); ctx.lineTo(CANVAS_W, PEEK_H); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    };
    img.src = peekImageData;
  }, [peekImageData, peekHeight]);

  const drawAnchors = useCallback((ctx) => {
    if (!anchors) return;
    ctx.save();

    const drawDots = (xs, y, direction) => {
      // direction: "up" = arrows point up (connect from above), "down" = arrows point down
      xs.forEach(x => {
        // Outer ring
        ctx.fillStyle = "rgba(192,57,43,0.15)";
        ctx.beginPath();
        ctx.arc(x, y, 14, 0, Math.PI * 2);
        ctx.fill();
        // Inner dot
        ctx.fillStyle = "#C0392B";
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fill();
        // Dashed line extending toward edge
        ctx.strokeStyle = "#C0392B";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        const lineLen = 22;
        const dy = direction === "up" ? -lineLen : lineLen;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + dy);
        ctx.stroke();
        ctx.setLineDash([]);
        // Arrowhead
        const ax = x, ay = y + dy;
        const ah = direction === "up" ? -6 : 6;
        ctx.fillStyle = "#C0392B";
        ctx.beginPath();
        ctx.moveTo(ax, ay + ah);
        ctx.lineTo(ax - 5, ay);
        ctx.lineTo(ax + 5, ay);
        ctx.closePath();
        ctx.fill();
      });
    };

    if (sectionIndex === 0 && anchors.head_to_body) {
      // Head: dots at bottom pointing down — "connect your drawing down to here"
      drawDots(anchors.head_to_body, CANVAS_H - 20, "down");
    } else if (sectionIndex === 1) {
      // Body: dots at top and bottom
      if (anchors.head_to_body) drawDots(anchors.head_to_body, 20, "up");
      if (anchors.body_to_legs) drawDots(anchors.body_to_legs, CANVAS_H - 20, "down");
    } else if (sectionIndex === 2 && anchors.body_to_legs) {
      // Legs: dots at top pointing up
      drawDots(anchors.body_to_legs, 20, "up");
    }
    ctx.restore();
  }, [anchors, sectionIndex]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff8f8";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    drawPeek(ctx);
    drawAnchors(ctx);
  }, [drawPeek, drawAnchors]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const getPos = (e) => {
      const r = canvas.getBoundingClientRect();
      const sx = canvas.width / r.width, sy = canvas.height / r.height;
      const src = e.touches ? e.touches[0] : e;
      return { x: (src.clientX - r.left) * sx, y: (src.clientY - r.top) * sy };
    };
    const saveSnapshot = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const snap = canvas.toDataURL();
      setUndoStack(prev => [...prev.slice(-19), snap]); // keep last 20 states
    };

    const onStart = (e) => {
      if (scrollModeRef.current) return; // scroll mode — let container pan
      e.preventDefault();
      const pos = getPos(e);
      const ctx = canvas.getContext("2d");
      saveSnapshot(); // save before each stroke
      if (toolRef.current === "bucket") {
        try { floodFillAt(ctx, Math.round(pos.x), Math.round(pos.y), colorRef.current); }
        catch(err) { console.warn("Flood fill failed:", err.message); }
        return;
      }
      isDrawingRef.current = true;
      lastPos.current = pos;
      const size = toolRef.current === "eraser" ? brushRef.current * 5 : brushRef.current;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, size / 2, 0, Math.PI * 2);
      ctx.fillStyle = toolRef.current === "eraser" ? "#fff8f8" : colorRef.current;
      ctx.fill();
    };
    const onMove  = (e) => {
      if (scrollModeRef.current) return; // scroll mode — let container pan
      e.preventDefault();
      if (!isDrawingRef.current) return;
      const ctx = canvas.getContext("2d");
      const pos = getPos(e);
      ctx.lineWidth   = toolRef.current === "eraser" ? brushRef.current * 5 : brushRef.current;
      ctx.lineCap     = "round"; ctx.lineJoin = "round";
      ctx.strokeStyle = toolRef.current === "eraser" ? "#fff8f8" : colorRef.current;
      ctx.beginPath(); ctx.moveTo(lastPos.current.x, lastPos.current.y); ctx.lineTo(pos.x, pos.y); ctx.stroke();
      lastPos.current = pos;
    };
    const onEnd = (e) => { e.preventDefault(); isDrawingRef.current = false; lastPos.current = null; };
    const opts = { passive: false };
    canvas.addEventListener("touchstart", onStart, opts); canvas.addEventListener("touchmove", onMove, opts); canvas.addEventListener("touchend", onEnd, opts);
    canvas.addEventListener("mousedown",  onStart, opts); canvas.addEventListener("mousemove", onMove, opts); canvas.addEventListener("mouseup",  onEnd, opts);
    canvas.addEventListener("mouseleave", onEnd, opts);
    return () => {
      canvas.removeEventListener("touchstart", onStart); canvas.removeEventListener("touchmove", onMove); canvas.removeEventListener("touchend", onEnd);
      canvas.removeEventListener("mousedown",  onStart); canvas.removeEventListener("mousemove", onMove); canvas.removeEventListener("mouseup",  onEnd);
      canvas.removeEventListener("mouseleave", onEnd);
    };
  }, []);

  const handleDone = () => {
    const canvas = canvasRef.current;
    const saveY = peekImageData ? PEEK_H : 0;
    const saveH = CANVAS_H - saveY;
    const c2 = document.createElement("canvas");
    c2.width = CANVAS_W; c2.height = saveH;
    c2.getContext("2d").drawImage(canvas, 0, saveY, CANVAS_W, saveH, 0, 0, CANVAS_W, saveH);
    onDone({ imageData: c2.toDataURL(), croppedHeight: saveH });
  };

  const undo = () => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    setUndoStack(s => s.slice(0, -1));
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      ctx.drawImage(img, 0, 0);
    };
    img.src = prev;
  };

  const clearCanvas = () => {
    // Save current state before clearing so clear is undoable
    const canvas = canvasRef.current;
    setUndoStack(prev => [...prev.slice(-19), canvas.toDataURL()]);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff8f8"; ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    drawPeek(ctx);
  };

  const section = SECTIONS[sectionIndex];

  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:10, width:"100%" }}>
      <div style={{ background:"#fdf0f0", border:"2px dashed #e8b4b4", borderRadius:12, padding:"8px 14px",
        color:"#a06060", fontFamily:"'Nunito',sans-serif", fontSize:12, width:"100%",
        textAlign:"center", lineHeight:1.5, boxSizing:"border-box" }}>
        {section.hint}
      </div>

      {/* Canvas — fixed-height scrollable container when zoomed */}
      <div
        ref={scrollRef}
        style={{
          width:"100%",
          borderRadius: zoom ? 8 : 16,
          overflow: zoom ? "auto" : "hidden",
          boxShadow:"0 4px 24px #C0392B22",
          border: zoom ? "2px solid #8e44ad" : "2px solid #e8c8c8",
          height: zoom ? Math.min(CANVAS_H, 340) + "px" : undefined,
          touchAction: (zoom && scrollMode) ? "pan-x pan-y" : "none",
          WebkitOverflowScrolling: "touch",
          overscrollBehavior: "contain",
          position: "relative",
        }}
      >
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          style={{
            display:"block",
            width: zoom ? CANVAS_W * 2 + "px" : "100%",
            height: zoom ? CANVAS_H * 2 + "px" : "auto",
            touchAction: "none",
            // Disable pointer events only in scroll mode
            pointerEvents: (zoom && scrollMode) ? "none" : "auto",
          }}
        />
        {peekImageData && !zoom && (
          <div style={{ position:"absolute", top: PEEK_H + 2, left:8, pointerEvents:"none",
            fontFamily:"'Nunito',sans-serif", fontSize:10, color:"#c9a0a0" }}>
            ↑ connect here
          </div>
        )}
      </div>

      {zoom && (
        <div style={{ display:"flex", gap:8, width:"100%", alignItems:"center" }}>
          <button
            onClick={() => setScrollMode(false)}
            style={{ flex:1, padding:"7px 8px", borderRadius:20, border:"2px solid",
              borderColor: !scrollMode ? "#C0392B" : "#ddd",
              background: !scrollMode ? "#fdf0f0" : "#fff",
              fontFamily:"'Nunito',sans-serif", fontSize:12, cursor:"pointer",
              color: !scrollMode ? "#C0392B" : "#999", fontWeight: !scrollMode ? 700 : 400 }}>
            ✏️ Draw
          </button>
          <button
            onClick={() => setScrollMode(true)}
            style={{ flex:1, padding:"7px 8px", borderRadius:20, border:"2px solid",
              borderColor: scrollMode ? "#8e44ad" : "#ddd",
              background: scrollMode ? "#f5eeff" : "#fff",
              fontFamily:"'Nunito',sans-serif", fontSize:12, cursor:"pointer",
              color: scrollMode ? "#8e44ad" : "#999", fontWeight: scrollMode ? 700 : 400 }}>
            🖐 Scroll
          </button>
        </div>
      )}

      {/* Colour picker — spectrum + presets */}
      <div style={{ width:"100%", display:"flex", flexDirection:"column", gap:6 }}>
        {/* Spectrum + eraser row */}
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          {/* Native colour wheel */}
          <label style={{ position:"relative", width:36, height:36, borderRadius:"50%",
            background: `conic-gradient(red,yellow,lime,cyan,blue,magenta,red)`,
            cursor:"pointer", border:"2px solid #ddd", overflow:"hidden",
            boxShadow: tool==="pen" && !COLORS.includes(color) ? "0 0 0 3px #333" : "none",
            flexShrink:0 }}>
            <input type="color" value={color}
              onChange={e => { setColor(e.target.value); setTool("pen"); }}
              style={{ opacity:0, position:"absolute", inset:0, width:"100%", height:"100%", cursor:"pointer" }} />
          </label>
          {/* Current colour swatch */}
          <div style={{ width:36, height:36, borderRadius:"50%", background:color,
            border:"2px solid #ddd", flexShrink:0,
            boxShadow: tool==="pen" ? "0 0 0 2px #fff, 0 0 0 4px " + color + "88" : "none" }} />
          <div style={{ flex:1 }} />
          <button onClick={() => { setZoom(z => { if (z) setScrollMode(false); return !z; }); }} style={{
            padding:"5px 10px", borderRadius:20, fontSize:14, cursor:"pointer",
            border:`2px solid ${zoom ? "#8e44ad" : "#ddd"}`,
            background: zoom ? "#f5eeff" : "#fff", fontFamily:"'Nunito',sans-serif",
          }}>{zoom ? "🔍×2" : "🔍"}</button>
          <button onClick={() => setTool(t => t==="bucket" ? "pen" : "bucket")} style={{
            padding:"5px 10px", borderRadius:20, fontSize:14, cursor:"pointer",
            border:`2px solid ${tool==="bucket" ? "#C0392B" : "#ddd"}`,
            background: tool==="bucket" ? "#fdf0f0" : "#fff", fontFamily:"'Nunito',sans-serif",
          }}>🪣</button>
          <button onClick={() => setTool(t => t==="eraser" ? "pen" : "eraser")} style={{
            padding:"5px 10px", borderRadius:20, fontSize:14, cursor:"pointer",
            border:`2px solid ${tool==="eraser" ? "#C0392B" : "#ddd"}`,
            background: tool==="eraser" ? "#fdf0f0" : "#fff", fontFamily:"'Nunito',sans-serif",
          }}>🧹</button>
        </div>
        {/* Preset swatches */}
        <div style={{ display:"flex", gap:5, flexWrap:"wrap", alignItems:"center" }}>
          {COLORS.map(c => (
            <button key={c} onClick={() => { setColor(c); setTool("pen"); }} style={{
              width:24, height:24, borderRadius:"50%", background:c, padding:0, cursor:"pointer",
              border: color===c && tool==="pen" ? "3px solid #333" : "2px solid #ddd",
              boxShadow: c==="#ffffff" ? "inset 0 0 0 1px #ddd" : "none",
              transform: color===c && tool==="pen" ? "scale(1.2)" : "scale(1)", transition:"transform 0.1s",
              flexShrink:0,
            }} />
          ))}
        </div>
      </div>

      {/* Brush + clear */}
      <div style={{ display:"flex", gap:8, alignItems:"center" }}>
        <span style={{ fontFamily:"'Nunito',sans-serif", color:"#bbb", fontSize:12 }}>Size:</span>
        {[2,5,9,16].map(s => (
          <button key={s} onClick={() => { setBrushSize(s); setTool("pen"); }} style={{
            width:s+14, height:s+14, borderRadius:"50%", border:"none", cursor:"pointer",
            background: brushSize===s && tool!=="eraser" ? "#C0392B" : "#e0d0d0",
          }} />
        ))}
        <button onClick={undo} disabled={undoStack.length === 0} style={{
          padding:"3px 12px", borderRadius:20, border:"2px solid #eee",
          background:"#fff", cursor: undoStack.length === 0 ? "default" : "pointer",
          fontSize:12, fontFamily:"'Nunito',sans-serif",
          color: undoStack.length === 0 ? "#ddd" : "#8e44ad",
        }}>↩ Undo</button>
        <button onClick={clearCanvas} style={{
          padding:"3px 12px", borderRadius:20, border:"2px solid #eee",
          background:"#fff", cursor:"pointer", fontSize:12,
          fontFamily:"'Nunito',sans-serif", color:"#C0392B",
        }}>Clear</button>
      </div>

      <button onClick={handleDone} style={{
        width:"100%", padding:"14px", borderRadius:50, border:"none",
        background:"#C0392B", color:"#fff",
        fontFamily:"'Playfair Display',serif", fontSize:18, fontWeight:700,
        cursor:"pointer", boxShadow:"0 4px 16px #C0392B44", letterSpacing:0.5,
      }}>
        {doneLabel || "Done — Pass it on"}
      </button>
    </div>
  );
}



// ─── RevealCanvas ─────────────────────────────────────────────────────────────


// ─── Character rendering ──────────────────────────────────────────────────────
// Builds a smooth rounded cartoon character from the kids' line drawings by:
// 1. Detecting the overall silhouette (all the ink) and smoothing it with
//    dilation + blur so it becomes a clean rounded blob.
// 2. Using that silhouette as a mask for a gradient "clay" fill — this gives
//    a Pixar-esque volumetric body regardless of what the kids drew.
// 3. Finding the head region (largest blob in the top third) and overlaying
//    proper cartoon eyes + mouth at detected positions.
// 4. Adding shoes at the bottom, arm highlights, glow etc.

function getInkMask(srcCanvas) {
  const W = srcCanvas.width, H = srcCanvas.height;
  const ctx = srcCanvas.getContext("2d");
  const mask = new Uint8ClampedArray(W * H);
  try {
    const { data } = ctx.getImageData(0, 0, W, H);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const brightness = (data[i] + data[i+1] + data[i+2]) / 3;
      if (data[i+3] > 100 && brightness < 200) mask[p] = 255;
    }
  } catch(e) {
    console.warn("getInkMask: getImageData failed, returning empty mask", e.message);
  }
  return { mask, W, H };
}

// Dilate the mask to fill in the body — expand ink by `radius` pixels so
// everything becomes a chunky blob silhouette.
function dilateMask(mask, W, H, radius) {
  // Fast separable dilation: horizontal pass then vertical pass.
  // Uses a sliding window of "distance to nearest ink pixel" along each axis.
  const h = new Uint8ClampedArray(W * H);
  // Horizontal pass
  for (let y = 0; y < H; y++) {
    let last = -radius - 1;
    // Left to right
    for (let x = 0; x < W; x++) {
      if (mask[y * W + x]) last = x;
      if (x - last <= radius) h[y * W + x] = 255;
    }
    // Right to left
    last = W + radius + 1;
    for (let x = W - 1; x >= 0; x--) {
      if (mask[y * W + x]) last = x;
      if (last - x <= radius) h[y * W + x] = 255;
    }
  }
  // Vertical pass
  const out = new Uint8ClampedArray(W * H);
  for (let x = 0; x < W; x++) {
    let last = -radius - 1;
    for (let y = 0; y < H; y++) {
      if (h[y * W + x]) last = y;
      if (y - last <= radius) out[y * W + x] = 255;
    }
    last = H + radius + 1;
    for (let y = H - 1; y >= 0; y--) {
      if (h[y * W + x]) last = y;
      if (last - y <= radius) out[y * W + x] = 255;
    }
  }
  return out;
}

// Erosion is the inverse of dilation — shrinks the mask by radius pixels.
// Used to find the "body core" (limbs removed).
function erodeMask(mask, W, H, radius) {
  // Invert → dilate → invert
  const inv = new Uint8ClampedArray(W * H);
  for (let i = 0; i < mask.length; i++) inv[i] = mask[i] ? 0 : 255;
  const dInv = dilateMask(inv, W, H, radius);
  const out = new Uint8ClampedArray(W * H);
  for (let i = 0; i < out.length; i++) out[i] = dInv[i] ? 0 : 255;
  return out;
}

// Convert mask → canvas so we can blur it
function maskToCanvas(mask, W, H, colour = "#000") {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(W, H);
  const [r, g, b] = [0, 0, 0]; // we'll use alpha for mask
  const hasColour = colour !== "#000";
  const cR = hasColour ? parseInt(colour.slice(1,3),16) : 0;
  const cG = hasColour ? parseInt(colour.slice(3,5),16) : 0;
  const cB = hasColour ? parseInt(colour.slice(5,7),16) : 0;
  for (let i = 0, p = 0; i < img.data.length; i += 4, p++) {
    img.data[i]   = cR;
    img.data[i+1] = cG;
    img.data[i+2] = cB;
    img.data[i+3] = mask[p];
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// Extract palette colours
function extractPalette(canvas, n = 6) {
  const ctx = canvas.getContext("2d");
  try {
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const buckets = {};
    for (let i = 0; i < data.length; i += 16) {
      if (data[i+3] < 200) continue;
      const r = data[i], g = data[i+1], b = data[i+2];
      if (r > 230 && g > 230 && b > 230) continue;
      const key = (r >> 5) * 1024 + (g >> 5) * 32 + (b >> 5);
      if (!buckets[key]) buckets[key] = { r, g, b, count: 0 };
      buckets[key].count++;
    }
    return Object.values(buckets).sort((a, b) => b.count - a.count).slice(0, n);
  } catch(e) {
    console.warn("extractPalette: getImageData failed, using defaults", e.message);
    // Fallback palette — pleasant defaults
    return [
      { r: 155, g: 107, b: 204 },
      { r: 100, g: 180, b: 220 },
    ];
  }
}

// Find the head bounding box — look for the largest ink cluster in the top third
function findHeadBox(mask, W, H) {
  const stride = 4;
  let minX = W, maxX = 0, minY = H, maxY = 0, count = 0;
  const limit = H / 3;
  for (let y = 0; y < limit; y += stride) {
    for (let x = 0; x < W; x += stride) {
      if (mask[y * W + x]) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        count++;
      }
    }
  }
  if (count < 5) return null;
  return { minX, maxX, minY, maxY, cx: (minX+maxX)/2, cy: (minY+maxY)/2, w: maxX-minX, h: maxY-minY };
}

// Find bottom of the body — lowest ink pixel
function findBodyBottom(mask, W, H) {
  for (let y = H - 1; y >= 0; y--) {
    for (let x = 0; x < W; x += 4) {
      if (mask[y * W + x]) return y;
    }
  }
  return H - 40;
}

// Draw a big chunky cartoon eye
function drawEye(ctx, x, y, size, options = {}) {
  // Anime-style eye:
  // - Heavy curved upper lid with eyelashes
  // - Large vertical-oval iris with strong vertical gradient
  // - Star or rounded dark pupil
  // - Two white shine highlights (big upper, small lower)
  // - Faint lower lashes
  const { irisColour = "#a060e0", side = "L" } = options;
  ctx.save();
  ctx.translate(x, y);
  // Mirror left eye so its lid leans the other way
  const flip = side === "L" ? -1 : 1;

  // ── 1. White of the eye (background) ────────────────────────────────────
  // Tall vertical oval, slight gradient bottom→top
  const wg = ctx.createLinearGradient(0, -size, 0, size);
  wg.addColorStop(0, "#ffffff");
  wg.addColorStop(1, "#e8eef2");
  ctx.fillStyle = wg;
  ctx.beginPath();
  ctx.ellipse(0, 0, size * 0.85, size * 1.15, 0, 0, Math.PI * 2);
  ctx.fill();

  // ── 2. Iris — large vertical oval with bold colour gradient ─────────────
  // Iris is sized to fill most of the eye whites
  const irisW = size * 0.78;
  const irisH = size * 1.05;
  const ig = ctx.createLinearGradient(0, -irisH, 0, irisH);
  ig.addColorStop(0, darken(irisColour, 50));   // very dark at top
  ig.addColorStop(0.4, irisColour);
  ig.addColorStop(0.8, lighten(irisColour, 20));
  ig.addColorStop(1, lighten(irisColour, 60));  // pale at bottom
  ctx.fillStyle = ig;
  ctx.beginPath();
  ctx.ellipse(0, size * 0.05, irisW, irisH, 0, 0, Math.PI * 2);
  ctx.fill();

  // Subtle iris darken-ring around the edge (depth)
  ctx.strokeStyle = darken(irisColour, 60);
  ctx.lineWidth = Math.max(1, size * 0.06);
  ctx.stroke();

  // ── 3. Pupil — rounded dark vertical shape ──────────────────────────────
  // Use a soft 4-sided star-like shape for whimsy
  ctx.fillStyle = "#1a0f1f";
  ctx.beginPath();
  const pSize = size * 0.32;
  // Pinched diamond/star — like a sparkle frozen in place
  ctx.moveTo(0, -pSize * 1.2);
  ctx.bezierCurveTo(pSize * 0.4, -pSize * 0.5, pSize * 0.9, -pSize * 0.3, pSize * 0.7, 0);
  ctx.bezierCurveTo(pSize * 0.9, pSize * 0.3, pSize * 0.4, pSize * 0.5, 0, pSize * 1.2);
  ctx.bezierCurveTo(-pSize * 0.4, pSize * 0.5, -pSize * 0.9, pSize * 0.3, -pSize * 0.7, 0);
  ctx.bezierCurveTo(-pSize * 0.9, -pSize * 0.3, -pSize * 0.4, -pSize * 0.5, 0, -pSize * 1.2);
  ctx.closePath();
  ctx.fill();

  // ── 4. Highlights (anime sparkle) ───────────────────────────────────────
  // Big upper-left shine
  const hg = ctx.createRadialGradient(-size * 0.25, -size * 0.45, 0, -size * 0.25, -size * 0.45, size * 0.32);
  hg.addColorStop(0, "rgba(255,255,255,1)");
  hg.addColorStop(0.6, "rgba(255,255,255,0.95)");
  hg.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = hg;
  ctx.beginPath();
  ctx.arc(-size * 0.25, -size * 0.45, size * 0.32, 0, Math.PI * 2);
  ctx.fill();

  // Smaller lower-right shine
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(size * 0.3, size * 0.6, size * 0.1, 0, Math.PI * 2);
  ctx.fill();

  // Tiny pupil sparkle
  ctx.beginPath();
  ctx.arc(-pSize * 0.3, -pSize * 0.3, pSize * 0.15, 0, Math.PI * 2);
  ctx.fill();

  // ── 5. Heavy upper lid + eyelashes ──────────────────────────────────────
  // Wide curved black band across the top of the eye
  ctx.fillStyle = "#1a1410";
  ctx.beginPath();
  // Top lid is a thick crescent. Outer corner extends slightly past the eye.
  // Inner corner points down toward the iris.
  ctx.moveTo(-size * 0.95 * flip, -size * 0.05);          // outer corner
  ctx.bezierCurveTo(
    -size * 0.9 * flip, -size * 1.0,
     size * 0.9 * flip, -size * 1.0,
     size * 0.85 * flip, -size * 0.15                     // inner corner
  );
  // Bottom of the lid arches down across the iris top
  ctx.bezierCurveTo(
     size * 0.7 * flip, -size * 0.2,
    -size * 0.7 * flip, -size * 0.2,
    -size * 0.95 * flip, -size * 0.05
  );
  ctx.closePath();
  ctx.fill();

  // Eyelash strokes — short curved lines fanning up from the lid
  ctx.strokeStyle = "#1a1410";
  ctx.lineWidth = Math.max(1.5, size * 0.08);
  ctx.lineCap = "round";
  const lashes = [
    { x: -0.85, len: 0.5, ang: -0.3 },
    { x: -0.55, len: 0.55, ang: -0.15 },
    { x: -0.2, len: 0.55, ang: 0 },
    { x: 0.15, len: 0.50, ang: 0.1 },
    { x: 0.5, len: 0.45, ang: 0.25 },
    { x: 0.78, len: 0.4, ang: 0.4 },
  ];
  for (const l of lashes) {
    const lx = l.x * size * flip;
    const ly = -size * 0.78;
    const angle = (l.ang) * flip;
    const tipX = lx + Math.sin(angle) * size * l.len;
    const tipY = ly - Math.cos(angle) * size * l.len;
    ctx.beginPath();
    ctx.moveTo(lx, ly);
    // Slight curve via quadratic
    const cpX = (lx + tipX) / 2 + Math.cos(angle) * size * 0.05 * flip;
    const cpY = (ly + tipY) / 2 - size * 0.05;
    ctx.quadraticCurveTo(cpX, cpY, tipX, tipY);
    ctx.stroke();
  }

  // ── 6. Lower lash strokes — small upward ticks under the eye ────────────
  ctx.lineWidth = Math.max(1, size * 0.05);
  for (let i = 0; i < 3; i++) {
    const fx = (-0.4 + i * 0.4) * size * flip;
    const fy = size * 1.05;
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.lineTo(fx + size * 0.04 * flip, fy + size * 0.18);
    ctx.stroke();
  }

  ctx.restore();
}

function lighten(hex, amt) {
  if (!hex || typeof hex !== "string" || !hex.startsWith("#") || hex.length < 7) return "#ffffff";
  const r = parseInt(hex.slice(1,3),16) || 0;
  const g = parseInt(hex.slice(3,5),16) || 0;
  const b = parseInt(hex.slice(5,7),16) || 0;
  return `rgb(${Math.min(255,r+amt)},${Math.min(255,g+amt)},${Math.min(255,b+amt)})`;
}
function darken(hex, amt) {
  if (!hex || typeof hex !== "string" || !hex.startsWith("#") || hex.length < 7) return "#000000";
  const r = parseInt(hex.slice(1,3),16) || 0;
  const g = parseInt(hex.slice(3,5),16) || 0;
  const b = parseInt(hex.slice(5,7),16) || 0;
  return `rgb(${Math.max(0,r-amt)},${Math.max(0,g-amt)},${Math.max(0,b-amt)})`;
}

// Draw cute shoes at bottom of feet
function drawShoes(ctx, x, y, size, colour = "#fff") {
  ctx.save();
  ctx.translate(x, y);
  // Sole
  ctx.fillStyle = "#2a1a14";
  ctx.beginPath();
  ctx.ellipse(0, size * 0.35, size * 0.9, size * 0.35, 0, 0, Math.PI * 2);
  ctx.fill();
  // Upper
  const g = ctx.createLinearGradient(0, -size*0.3, 0, size*0.3);
  g.addColorStop(0, lighten(colour, 30));
  g.addColorStop(1, colour);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(0, 0, size * 0.85, size * 0.55, 0, Math.PI, 0);
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = "#1a1410";
  ctx.stroke();
  // Laces dot
  ctx.fillStyle = "#1a1410";
  ctx.beginPath(); ctx.arc(0, -size*0.1, size*0.06, 0, Math.PI*2); ctx.fill();
  ctx.restore();
}

// Main character renderer — FAST version using pure canvas filter operations.
// No pixel-level mask work — relies on GPU-accelerated CSS filter: blur().
function renderCharacter(raw, opts = {}) {
  const { sectionBoundaries = null } = opts;
  const W = Math.floor(raw.width || 380);
  const H = Math.floor(raw.height || 600);
  if (W < 10 || H < 10) {
    console.warn("renderCharacter: invalid dimensions", W, H);
    return raw;
  }
  const out = document.createElement("canvas");
  out.width = W; out.height = H;
  const ctx = out.getContext("2d");

  try {
    // 1. Build alpha mask from DARK INK ONLY — not the cream background.
    const mask = document.createElement("canvas");
    mask.width = W; mask.height = H;
    const mctx = mask.getContext("2d");
    try {
      const tmpCtx = raw.getContext("2d");
      const srcData = tmpCtx.getImageData(0, 0, W, H);
      const maskImg = mctx.createImageData(W, H);
      for (let i = 0; i < srcData.data.length; i += 4) {
        const r = srcData.data[i], g = srcData.data[i+1], b = srcData.data[i+2];
        const brightness = (r + g + b) / 3;
        // Anything noticeably darker than cream background (~250) = ink
        if (brightness < 230) {
          maskImg.data[i]   = r;
          maskImg.data[i+1] = g;
          maskImg.data[i+2] = b;
          // Stronger alpha for darker pixels — sharp falloff
          const darkness = 230 - brightness;
          maskImg.data[i+3] = Math.min(255, darkness * 4);
        }
      }
      mctx.putImageData(maskImg, 0, 0);
    } catch(e) {
      console.warn("Mask build failed:", e.message);
      mctx.drawImage(raw, 0, 0);
    }

    // 3. Plain white background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);

    // 4. AUTO-COLOUR enclosed regions in the drawing.
    // Detect white/cream pixels that are TRAPPED inside coloured outlines
    // (i.e. surrounded by ink so flood-fill from the canvas edge can't reach them)
    // and fill them with the colour of the nearest surrounding ink.
    let filledCanvas = null;
    try {
      const tmpCtx = raw.getContext("2d");
      const srcData = tmpCtx.getImageData(0, 0, W, H);
      const src = srcData.data;
      // Build a per-pixel classification:
      //   0 = ink (dark coloured stroke)
      //   1 = empty (light/cream pixel — could be inside or outside a shape)
      const empty = new Uint8Array(W * H);
      for (let i = 0, p = 0; i < src.length; i += 4, p++) {
        const brightness = (src[i] + src[i+1] + src[i+2]) / 3;
        empty[p] = brightness >= 230 ? 1 : 0;
      }

      // Build a "near ink" map — pixels within INK_PROXIMITY of any ink pixel.
      // Edge pixels NEAR ink will be treated as walls (so an arm reaching off
      // the canvas still counts as enclosed). Edges far from any ink are
      // safely "outside" and seed the flood.
      // Smaller proximity = won't bridge across separate body sections.
      // Section boundaries are now hard walls (added below), so within a section
      // we can be more aggressive about bridging small gaps in outlines.
      const INK_PROXIMITY = 7;
      const nearInk = new Uint8Array(W * H);
      // Mark all ink pixels first
      for (let p = 0; p < empty.length; p++) {
        if (!empty[p]) nearInk[p] = 1;
      }
      // Dilate that mask outward by INK_PROXIMITY using a fast separable pass
      const horiz = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) {
        let last = -INK_PROXIMITY - 1;
        for (let x = 0; x < W; x++) {
          if (nearInk[y * W + x]) last = x;
          if (x - last <= INK_PROXIMITY) horiz[y * W + x] = 1;
        }
        last = W + INK_PROXIMITY + 1;
        for (let x = W - 1; x >= 0; x--) {
          if (nearInk[y * W + x]) last = x;
          if (last - x <= INK_PROXIMITY) horiz[y * W + x] = 1;
        }
      }
      for (let x = 0; x < W; x++) {
        let last = -INK_PROXIMITY - 1;
        for (let y = 0; y < H; y++) {
          if (horiz[y * W + x]) last = y;
          if (y - last <= INK_PROXIMITY) nearInk[y * W + x] = 1;
        }
        last = H + INK_PROXIMITY + 1;
        for (let y = H - 1; y >= 0; y--) {
          if (horiz[y * W + x]) last = y;
          if (last - y <= INK_PROXIMITY) nearInk[y * W + x] = 1;
        }
      }

      // Mark section boundaries as horizontal walls so flood fill never
      // bridges across them. This prevents the body's interior from merging
      // with the legs' interior even when their outlines don't perfectly meet.
      // Wall is 5 pixels thick (rather than 3) so flood reliably can't sneak through.
      if (sectionBoundaries && sectionBoundaries.length > 0) {
        for (const by of sectionBoundaries) {
          if (by == null) continue;
          const yTop = Math.max(0, Math.floor(by) - 2);
          const yBot = Math.min(H - 1, Math.floor(by) + 2);
          for (let y = yTop; y <= yBot; y++) {
            for (let x = 0; x < W; x++) nearInk[y * W + x] = 1;
          }
        }
      }

      // Flood fill from edge pixels that are EMPTY and NOT near any ink.
      // Anything reached is the true "outside" (the surrounding background).
      // Edge pixels near ink act as walls — a half-circle drawn against the edge
      // stays enclosed.
      const reached = new Uint8Array(W * H);
      const stack = [];
      for (let x = 0; x < W; x++) {
        if (empty[x] && !nearInk[x]) { reached[x] = 1; stack.push(x); }
        const bot = (H - 1) * W + x;
        if (empty[bot] && !nearInk[bot]) { reached[bot] = 1; stack.push(bot); }
      }
      for (let y = 0; y < H; y++) {
        const left = y * W;
        if (empty[left] && !nearInk[left]) { reached[left] = 1; stack.push(left); }
        const right = y * W + (W - 1);
        if (empty[right] && !nearInk[right]) { reached[right] = 1; stack.push(right); }
      }
      // Flood through empty pixels but BLOCKED by the nearInk band — this
      // turns near-edge ink into a reliable wall even when there's a tiny
      // gap between the ink and the canvas border.
      while (stack.length) {
        const idx = stack.pop();
        const x = idx % W, y = (idx / W) | 0;
        if (x > 0)     { const n = idx - 1; if (empty[n] && !reached[n] && !nearInk[n]) { reached[n] = 1; stack.push(n); } }
        if (x < W-1)   { const n = idx + 1; if (empty[n] && !reached[n] && !nearInk[n]) { reached[n] = 1; stack.push(n); } }
        if (y > 0)     { const n = idx - W; if (empty[n] && !reached[n] && !nearInk[n]) { reached[n] = 1; stack.push(n); } }
        if (y < H-1)   { const n = idx + W; if (empty[n] && !reached[n] && !nearInk[n]) { reached[n] = 1; stack.push(n); } }
      }
      // Now expand "reached" by the same proximity so the band of empty pixels
      // adjacent to ink (which surrounded the strokes from outside) gets coloured
      // as outside too, not as enclosed.
      const reachedExpanded = new Uint8Array(W * H);
      reachedExpanded.set(reached);
      const eHoriz = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) {
        let last = -INK_PROXIMITY - 1;
        for (let x = 0; x < W; x++) {
          if (reached[y * W + x]) last = x;
          if (x - last <= INK_PROXIMITY) eHoriz[y * W + x] = 1;
        }
        last = W + INK_PROXIMITY + 1;
        for (let x = W - 1; x >= 0; x--) {
          if (reached[y * W + x]) last = x;
          if (last - x <= INK_PROXIMITY) eHoriz[y * W + x] = 1;
        }
      }
      for (let x = 0; x < W; x++) {
        let last = -INK_PROXIMITY - 1;
        for (let y = 0; y < H; y++) {
          if (eHoriz[y * W + x]) last = y;
          if (y - last <= INK_PROXIMITY) reachedExpanded[y * W + x] = 1;
        }
        last = H + INK_PROXIMITY + 1;
        for (let y = H - 1; y >= 0; y--) {
          if (eHoriz[y * W + x]) last = y;
          if (last - y <= INK_PROXIMITY) reachedExpanded[y * W + x] = 1;
        }
      }
      // Use the expanded reached for the inside/outside test.
      reached.set(reachedExpanded);

      // Any pixel where empty=1 and reached=0 is INSIDE a closed shape.
      // Group these into regions using flood fill. We do this in two phases:
      //
      // PHASE 1: Standard flood — finds all enclosed regions. A nested shape
      // (eye inside head) might NOT be detected separately if its outline has
      // gaps that connect it to the parent region.
      //
      // PHASE 2: Re-flood treating already-filled small regions as walls,
      // so we can detect a head's eye sockets that share borders with the head.
      //
      // We then fill SMALLEST regions first (so an eye gets its own colour),
      // then larger ones on top (so the head fills around the eye without
      // overwriting it).
      const filled = mctx.createImageData(W, H);
      const visited = new Uint8Array(W * H);
      const regions = []; // collected first, then sorted by size

      // Quick lookup: is this Y a section boundary?
      const isBoundaryY = (y) => {
        if (!sectionBoundaries) return false;
        for (const by of sectionBoundaries) {
          if (by != null && Math.abs(y - Math.floor(by)) <= 2) return true;
        }
        return false;
      };

      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const idx = y * W + x;
          if (visited[idx] || !empty[idx] || reached[idx]) continue;
          if (isBoundaryY(y)) { visited[idx] = 1; continue; }
          const regionPixels = [];
          const regionPixelSet = new Uint8Array(W * H); // for fast lookup
          const fstack = [idx];
          while (fstack.length) {
            const i = fstack.pop();
            if (visited[i]) continue;
            visited[i] = 1;
            if (!empty[i] || reached[i]) {
              continue;  // border ink — collected later via outer-edge scan
            }
            // Stop at section boundaries — they act as walls
            const iy = (i / W) | 0;
            if (isBoundaryY(iy)) continue;
            regionPixels.push(i);
            regionPixelSet[i] = 1;
            const ix = i % W;
            if (ix > 0)   fstack.push(i - 1);
            if (ix < W-1) fstack.push(i + 1);
            if (iy > 0)   fstack.push(i - W);
            if (iy < H-1) fstack.push(i + W);
          }
          if (regionPixels.length < 4) continue;

          // Compute bounding box for density and boundary checks
          let minX = W, maxX = 0, minY = H, maxY = 0;
          for (const p of regionPixels) {
            const px = p % W, py = (p / W) | 0;
            if (px < minX) minX = px; if (px > maxX) maxX = px;
            if (py < minY) minY = py; if (py > maxY) maxY = py;
          }
          const bboxW = maxX - minX + 1;
          const bboxH = maxY - minY + 1;
          const bboxArea = bboxW * bboxH;

          // SKIP FILLING regions that are sparse — i.e. their pixels fill less
          // than 50% of their bounding box. This means there's lots of ink
          // (kid's scribble fill) inside, and an auto-fill on top would
          // darken/cover their work.
          const density = regionPixels.length / bboxArea;
          if (density < 0.50) continue;

          // Skip tiny regions adjacent to a section boundary — these are thin slivers
          // formed where the kid's outline touches the boundary at a near-tangent.
          // They produce small artifacts of random colour.
          if (regionPixels.length < 200 && sectionBoundaries) {
            let nearBoundary = false;
            for (const by of sectionBoundaries) {
              if (by != null && (Math.abs(minY - by) < 8 || Math.abs(maxY - by) < 8)) {
                nearBoundary = true; break;
              }
            }
            if (nearBoundary) continue;
          }

          // EYE-WHITE DETECTION: a small, roughly-circular region surrounded only
          // by dark ink (no coloured outline). These are likely the whites of eyes
          // and should stay white, not get filled with the dark border colour.
          // Only skip if the region is small (under ~2000px = ~50px diameter)
          // because larger shapes can legitimately have black outlines.

          // OUTER-EDGE border colour collection.
          // For each row in the region's bounding box, find the leftmost and
          // rightmost ink pixels just outside the region — those belong to the
          // OUTER outline. This excludes nested shapes' outlines (which are
          // surrounded by region pixels on all sides).
          const borderColours = [];
          // Sample horizontal: leftmost & rightmost ink pixel adjacent to a region pixel on each row
          for (let yy = minY; yy <= maxY; yy++) {
            // Find first region pixel in this row, then walk left to find left border ink
            let leftRegionX = -1;
            for (let xx = minX; xx <= maxX; xx++) {
              if (regionPixelSet[yy * W + xx]) { leftRegionX = xx; break; }
            }
            if (leftRegionX > 0) {
              // Scan left from leftRegionX looking for ink within a few pixels
              for (let xx = leftRegionX - 1; xx >= Math.max(0, leftRegionX - 8); xx--) {
                const i = yy * W + xx;
                if (!empty[i]) {
                  const di = i * 4;
                  if (src[di+3] > 50) borderColours.push([src[di], src[di+1], src[di+2]]);
                  break;
                }
              }
            }
            let rightRegionX = -1;
            for (let xx = maxX; xx >= minX; xx--) {
              if (regionPixelSet[yy * W + xx]) { rightRegionX = xx; break; }
            }
            if (rightRegionX > 0 && rightRegionX < W - 1) {
              for (let xx = rightRegionX + 1; xx <= Math.min(W - 1, rightRegionX + 8); xx++) {
                const i = yy * W + xx;
                if (!empty[i]) {
                  const di = i * 4;
                  if (src[di+3] > 50) borderColours.push([src[di], src[di+1], src[di+2]]);
                  break;
                }
              }
            }
          }
          // Sample vertical: topmost & bottommost ink pixel adjacent to a region pixel on each column
          for (let xx = minX; xx <= maxX; xx++) {
            let topRegionY = -1;
            for (let yy = minY; yy <= maxY; yy++) {
              if (regionPixelSet[yy * W + xx]) { topRegionY = yy; break; }
            }
            if (topRegionY > 0) {
              for (let yy = topRegionY - 1; yy >= Math.max(0, topRegionY - 8); yy--) {
                const i = yy * W + xx;
                if (!empty[i]) {
                  const di = i * 4;
                  if (src[di+3] > 50) borderColours.push([src[di], src[di+1], src[di+2]]);
                  break;
                }
              }
            }
            let bottomRegionY = -1;
            for (let yy = maxY; yy >= minY; yy--) {
              if (regionPixelSet[yy * W + xx]) { bottomRegionY = yy; break; }
            }
            if (bottomRegionY > 0 && bottomRegionY < H - 1) {
              for (let yy = bottomRegionY + 1; yy <= Math.min(H - 1, bottomRegionY + 8); yy++) {
                const i = yy * W + xx;
                if (!empty[i]) {
                  const di = i * 4;
                  if (src[di+3] > 50) borderColours.push([src[di], src[di+1], src[di+2]]);
                  break;
                }
              }
            }
          }

          if (borderColours.length === 0) continue;
          regions.push({ regionPixels, borderColours });
        }
      }

      // Sort regions by size — smallest first, so nested shapes get coloured
      // before their containing parent overwrites them.
      regions.sort((a, b) => a.regionPixels.length - b.regionPixels.length);

      // Track which pixels are already filled; small region's pixels won't be
      // overwritten when a larger region tries to fill the same area.
      const alreadyFilled = new Uint8Array(W * H);

      for (const region of regions) {
        // Find the DOMINANT border colour for this region.
        // For nested shapes: filter out border pixels whose colour matches
        // the colour of an already-filled adjacent region — those aren't
        // really borders of THIS shape, they're borders of the inner shape.
        const colourBuckets = {};
        for (const c of region.borderColours) {
          const key = ((c[0] >> 5) << 10) | ((c[1] >> 5) << 5) | (c[2] >> 5);
          if (!colourBuckets[key]) colourBuckets[key] = { r: 0, g: 0, b: 0, n: 0 };
          colourBuckets[key].r += c[0];
          colourBuckets[key].g += c[1];
          colourBuckets[key].b += c[2];
          colourBuckets[key].n++;
        }
        let dominant = null;
        for (const k in colourBuckets) {
          if (!dominant || colourBuckets[k].n > dominant.n) dominant = colourBuckets[k];
        }
        const rAvg = Math.round(dominant.r / dominant.n);
        const gAvg = Math.round(dominant.g / dominant.n);
        const bAvg = Math.round(dominant.b / dominant.n);
        // Eye-white detection: small region (< ~2000px) with very dark dominant
        // border colour means it's likely the white of an eye. Leave it white.
        const brightness = (rAvg + gAvg + bAvg) / 3;
        if (region.regionPixels.length < 2000 && brightness < 60) continue;
        // Match outline colour exactly — no lightening so fills are rich.
        // The outline strokes drawn on top are slightly darker after contrast boost,
        // so the line still reads as the edge.
        const cR = rAvg;
        const cG = gAvg;
        const cB = bAvg;
        // Paint, skipping pixels already filled by a smaller nested region
        for (const p of region.regionPixels) {
          if (alreadyFilled[p]) continue;
          const di = p * 4;
          filled.data[di]   = cR;
          filled.data[di+1] = cG;
          filled.data[di+2] = cB;
          filled.data[di+3] = 255;
          alreadyFilled[p] = 1;
        }
      }
      filledCanvas = document.createElement("canvas");
      filledCanvas.width = W; filledCanvas.height = H;
      filledCanvas.getContext("2d").putImageData(filled, 0, 0);
    } catch(e) {
      console.warn("Auto-colour failed:", e.message);
    }

    // 4b. Draw the auto-filled regions onto the white background.
    // These are the painted-in colours of each enclosed shape — kept crisp.
    if (filledCanvas) {
      ctx.drawImage(filledCanvas, 0, 0);
    }

    // (Stroke-cluster fill removed — it was producing fuzzy halos around
    // strokes that obscured the actual drawing structure. The enclosed-region
    // fill above handles the colouring more cleanly.)

    // 5. Draw smoothed strokes on top.
    const smoothStrokes = document.createElement("canvas");
    smoothStrokes.width = W; smoothStrokes.height = H;
    const ssCtx = smoothStrokes.getContext("2d");
    try { ssCtx.filter = "blur(1.5px)"; } catch(e) {}
    ssCtx.drawImage(mask, 0, 0);
    try { ssCtx.filter = "none"; } catch(e) {}

    ctx.save();
    try { ctx.filter = "contrast(1.6) saturate(1.3)"; } catch(e) {}
    ctx.drawImage(smoothStrokes, 0, 0);
    ctx.drawImage(smoothStrokes, 0, 0);
    try { ctx.filter = "none"; } catch(e) {}
    ctx.restore();

    // 6. Seam blending — at each section boundary, apply a soft blur strip
    // so strokes from adjacent sections blend rather than hard-cutting.
    if (sectionBoundaries && sectionBoundaries.length > 0) {
      const SEAM_BLUR = 8;  // px blur in the blend zone
      const SEAM_H    = 28; // height of the blend zone around each seam
      for (const by of sectionBoundaries) {
        if (!by) continue;
        const sy = Math.max(0, Math.floor(by) - SEAM_H / 2);
        const sh = Math.min(H - sy, SEAM_H);
        // Extract the seam strip, blur it, draw back
        try {
          const seamCanvas = document.createElement("canvas");
          seamCanvas.width = W; seamCanvas.height = sh;
          const sctx = seamCanvas.getContext("2d");
          sctx.drawImage(ctx.canvas, 0, sy, W, sh, 0, 0, W, sh);
          // Blur the strip
          const blurCanvas = document.createElement("canvas");
          blurCanvas.width = W; blurCanvas.height = sh;
          const bctx = blurCanvas.getContext("2d");
          try { bctx.filter = `blur(${SEAM_BLUR}px)`; } catch(e) {}
          bctx.drawImage(seamCanvas, 0, 0);
          try { bctx.filter = "none"; } catch(e) {}
          // Blend back with a gradient mask — only blur the very centre of the seam
          const grad = ctx.createLinearGradient(0, sy, 0, sy + sh);
          grad.addColorStop(0,    "rgba(0,0,0,0)");
          grad.addColorStop(0.35, "rgba(0,0,0,0.7)");
          grad.addColorStop(0.65, "rgba(0,0,0,0.7)");
          grad.addColorStop(1,    "rgba(0,0,0,0)");
          ctx.save();
          ctx.globalAlpha = 0.5;
          ctx.drawImage(blurCanvas, 0, sy);
          ctx.restore();
        } catch(e) { /* skip seam blur if canvas ops fail */ }
      }
    }

    // 7. Find head box
    const head = findHeadBoxFromCanvas(raw);

    // 8. Cartoon eyes — but FIRST detect if the kid drew their own eyes
    // (look for dark roundish blobs in the head region). If we find any,
    // we don't overlay our cartoon eyes — let the kid's drawing stand.
    let drewOwnEyes = false;
    const eyeBlobs = [];  // detected eye blob centres so we can preserve eye whites
    if (head) {
      try {
        const tmpCtx = raw.getContext("2d");
        const region = tmpCtx.getImageData(
          Math.max(0, Math.floor(head.minX)),
          Math.max(0, Math.floor(head.minY)),
          Math.min(W, Math.floor(head.w)),
          Math.min(H, Math.floor(head.h))
        );
        const offX = Math.max(0, Math.floor(head.minX));
        const offY = Math.max(0, Math.floor(head.minY));
        // Count dark blobs by flood-filling clusters of dark pixels
        const rw = region.width, rh = region.height;
        const visited = new Uint8Array(rw * rh);
        let blobCount = 0;
        for (let y = 0; y < rh; y += 2) {
          for (let x = 0; x < rw; x += 2) {
            const idx = y * rw + x;
            if (visited[idx]) continue;
            const di = idx * 4;
            const brightness = (region.data[di] + region.data[di+1] + region.data[di+2]) / 3;
            // Look for VERY dark pixels (filled blobs, not just outlines)
            if (region.data[di+3] < 100 || brightness > 100) { visited[idx] = 1; continue; }
            // Flood fill to find blob extent
            const fstack = [[x, y]];
            let minX = x, maxX = x, minY = y, maxY = y, count = 0;
            while (fstack.length) {
              const [cx, cy] = fstack.pop();
              if (cx < 0 || cy < 0 || cx >= rw || cy >= rh) continue;
              const ci = cy * rw + cx;
              if (visited[ci]) continue;
              const cdi = ci * 4;
              const cb = (region.data[cdi] + region.data[cdi+1] + region.data[cdi+2]) / 3;
              if (region.data[cdi+3] < 100 || cb > 100) { visited[ci] = 1; continue; }
              visited[ci] = 1;
              count++;
              if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
              if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
              fstack.push([cx+2, cy], [cx-2, cy], [cx, cy+2], [cx, cy-2]);
            }
            // Eye-like criteria: roughly round, reasonable size relative to head
            const blobW = maxX - minX, blobH = maxY - minY;
            const aspectOK = blobW > 0 && blobH > 0 && (blobW / blobH < 3) && (blobH / blobW < 3);
            const sizeOK = count > 30 && blobW < head.w * 0.4 && blobH < head.h * 0.5;
            if (aspectOK && sizeOK) {
              blobCount++;
              eyeBlobs.push({
                cx: offX + (minX + maxX) / 2,
                cy: offY + (minY + maxY) / 2,
                radius: Math.max(blobW, blobH) / 2,
              });
            }
          }
        }
        // 1 or more dark blobs = kid drew their own eye(s)
        drewOwnEyes = blobCount >= 1;
      } catch(e) {
        console.warn("Eye detection failed:", e.message);
      }
    }

    // PROTECT EYE WHITES: for each detected eye blob, paint a white disk on
    // the rendered canvas at its location, scaled up slightly to cover the
    // surrounding eye-white area that auto-fill might have coloured in.
    if (eyeBlobs.length > 0) {
      ctx.save();
      for (const blob of eyeBlobs) {
        // Disk radius = 2.2x the dark-pupil radius — covers typical eye-white surround
        const r = blob.radius * 2.2;
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(blob.cx, blob.cy, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      // Re-draw the smoothed strokes on top so the kid's eye outlines are visible
      // again over the white we just painted
      ctx.save();
      try { ctx.filter = "contrast(1.6) saturate(1.3)"; } catch(e) {}
      ctx.drawImage(smoothStrokes, 0, 0);
      ctx.drawImage(smoothStrokes, 0, 0);
      try { ctx.filter = "none"; } catch(e) {}
      ctx.restore();
    }

    if (head && !drewOwnEyes) {
      const eyeSize = Math.max(22, Math.min(head.w * 0.18, 48));
      const sep     = Math.max(head.w * 0.26, eyeSize * 1.35);
      const eyeY    = head.minY + head.h * 0.50;

      // Pick iris colour that contrasts with the head's fill colour.
      // Sample the centre of the head from our composed canvas to see what's there.
      let headHue = 0;        // hue 0-360 of the head fill (or 0 if none detected)
      let headIsLight = true; // true if head is pale, so we pick saturated darker eye
      try {
        const headSample = ctx.getImageData(
          Math.max(0, Math.floor(head.cx) - 2),
          Math.max(0, Math.floor(eyeY) - 2),
          5, 5
        ).data;
        let rs = 0, gs = 0, bs = 0, n = 0;
        for (let i = 0; i < headSample.length; i += 4) {
          rs += headSample[i]; gs += headSample[i+1]; bs += headSample[i+2]; n++;
        }
        const hr = rs / n, hg = gs / n, hb = bs / n;
        headIsLight = (hr + hg + hb) / 3 > 180;
        // Convert RGB → HSL hue for complementary colour pick
        const max = Math.max(hr, hg, hb), min = Math.min(hr, hg, hb);
        const d = max - min;
        if (d > 5) {
          let h = 0;
          if (max === hr) h = ((hg - hb) / d) % 6;
          else if (max === hg) h = (hb - hr) / d + 2;
          else h = (hr - hg) / d + 4;
          headHue = (h * 60 + 360) % 360;
        }
      } catch(e) {}

      // Pick a complementary iris hue: 180° opposite the head's hue, with
      // light/dark adjusted so it pops on the head colour.
      const irisHue = (headHue + 180) % 360;
      // Light heads get bold dark iris; dark heads get bright iris
      const irisL = headIsLight ? 45 : 60;
      const irisS = 75;
      // HSL → RGB
      const hslToHex = (h, s, l) => {
        s /= 100; l /= 100;
        const c = (1 - Math.abs(2*l - 1)) * s;
        const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
        const m = l - c/2;
        let [r,g,b] = [0,0,0];
        if (h < 60)      [r,g,b] = [c,x,0];
        else if (h < 120)[r,g,b] = [x,c,0];
        else if (h < 180)[r,g,b] = [0,c,x];
        else if (h < 240)[r,g,b] = [0,x,c];
        else if (h < 300)[r,g,b] = [x,0,c];
        else             [r,g,b] = [c,0,x];
        const toHex = v => Math.round((v + m) * 255).toString(16).padStart(2, "0");
        return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
      };
      const iris = hslToHex(irisHue, irisS, irisL);
      drawEye(ctx, head.cx - sep, eyeY, eyeSize, { irisColour: iris, side: "L" });
      drawEye(ctx, head.cx + sep, eyeY, eyeSize, { irisColour: iris, side: "R" });

      // Small smirk mouth below eyes
      ctx.save();
      ctx.strokeStyle = "#3a1a0f";
      ctx.lineWidth = Math.max(2.5, eyeSize * 0.12);
      ctx.lineCap = "round";
      ctx.beginPath();
      const mouthY = eyeY + eyeSize * 1.9;
      ctx.moveTo(head.cx - eyeSize * 0.55, mouthY);
      ctx.quadraticCurveTo(head.cx, mouthY + eyeSize * 0.45, head.cx + eyeSize * 0.55, mouthY);
      ctx.stroke();
      ctx.restore();
    }

    return out;
  } catch(e) {
    console.error("renderCharacter inner error:", e);
    // Return whatever we have so far rather than throwing
    return out;
  }
}

// Fast head detection — samples pixels directly without building a full mask.
function findHeadBoxFromCanvas(canvas) {
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext("2d");
  try {
    const { data } = ctx.getImageData(0, 0, W, Math.floor(H / 3));
    let minX = W, maxX = 0, minY = H, maxY = 0, count = 0;
    const step = 4;
    for (let y = 0; y < Math.floor(H / 3); y += step) {
      for (let x = 0; x < W; x += step) {
        const i = (y * W + x) * 4;
        const b = (data[i] + data[i+1] + data[i+2]) / 3;
        if (data[i+3] > 100 && b < 200) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          count++;
        }
      }
    }
    if (count < 5) return null;
    return { minX, maxX, minY, maxY, cx: (minX+maxX)/2, cy: (minY+maxY)/2, w: maxX-minX, h: maxY-minY };
  } catch(e) {
    console.warn("findHeadBoxFromCanvas: getImageData failed, using guess", e.message);
    // Fallback: assume head is centred in top third
    const headH = H / 3;
    return {
      minX: W * 0.25, maxX: W * 0.75,
      minY: headH * 0.2, maxY: headH * 0.85,
      cx: W / 2, cy: headH * 0.5,
      w: W * 0.5, h: headH * 0.65
    };
  }
}

function lightenColour(c, amt) {
  if (c.startsWith("#")) return lighten(c, amt);
  const m = c.match(/\d+/g);
  if (!m) return c;
  return `rgb(${Math.min(255,+m[0]+amt)},${Math.min(255,+m[1]+amt)},${Math.min(255,+m[2]+amt)})`;
}
function darkenColour(c, amt) {
  if (c.startsWith("#")) return darken(c, amt);
  const m = c.match(/\d+/g);
  if (!m) return c;
  return `rgb(${Math.max(0,+m[0]-amt)},${Math.max(0,+m[1]-amt)},${Math.max(0,+m[2]-amt)})`;
}

// Filter presets — each returns a canvas
const FILTERS = {
  original: {
    name: "Original", subtitle: "As drawn",
    apply: (raw, opts) => raw,
  },
  cartoon: {
    name: "Cartoon", subtitle: "Smooth render",
    apply: (raw, opts) => renderCharacter(raw, opts),
  },
};

// ─── RevealCanvas ─────────────────────────────────────────────────────────────
function RevealCanvas({ sections, players = [] }) {
  const displayRef   = useRef(null);
  const rawRef       = useRef(null);
  const styledRef    = useRef(null);
  const containerRef = useRef(null);
  const rafRef       = useRef(null);

  const [stage,      setStage]      = useState("building");
  const [filterKey,  setFilterKey]  = useState("original");
  const [morphAlpha, setMorphAlpha] = useState(0);
  const [scale,      setScale]      = useState(1);
  const [working,    setWorking]    = useState(false);

  const totalHeight = sections.reduce((s, x) => s + (x.croppedHeight || CANVAS_H), 0);
  const DANCE_PAD = 40;
  const displayH  = totalHeight + DANCE_PAD;

  useEffect(() => {
    const maxH = window.innerHeight * 0.50;
    const maxW = containerRef.current?.offsetWidth || CANVAS_W;
    setScale(Math.min(1, maxH / displayH, maxW / CANVAS_W));
  }, [displayH]);

  useEffect(() => {
    const imgs = sections.map(() => new Image());
    let loaded = 0;
    imgs.forEach((img, i) => {
      img.onload = () => { if (++loaded === sections.length) build(imgs); };
      img.src = sections[i].imageData;
    });

    // For each loaded image, find the vertical bounds of the ink (top & bottom
    // pixels with dark content) so we can crop away empty whitespace.
    function findInkBounds(img) {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      const tmp = document.createElement("canvas");
      tmp.width = w; tmp.height = h;
      const tctx = tmp.getContext("2d");
      tctx.drawImage(img, 0, 0);
      let top = 0, bottom = h - 1;
      try {
        const { data } = tctx.getImageData(0, 0, w, h);
        // Scan top → bottom for first ink row
        outerTop:
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x += 3) {
            const i = (y * w + x) * 4;
            if (data[i+3] > 100 && (data[i] + data[i+1] + data[i+2]) / 3 < 220) {
              top = y; break outerTop;
            }
          }
        }
        // Scan bottom → top for last ink row
        outerBot:
        for (let y = h - 1; y >= 0; y--) {
          for (let x = 0; x < w; x += 3) {
            const i = (y * w + x) * 4;
            if (data[i+3] > 100 && (data[i] + data[i+1] + data[i+2]) / 3 < 220) {
              bottom = y; break outerBot;
            }
          }
        }
      } catch(e) { /* fall back to full bounds */ }
      // Add a tiny pad so the silhouette edges don't get cut off by the trim
      const PAD = 4;
      return {
        top:    Math.max(0, top - PAD),
        bottom: Math.min(h, bottom + PAD),
        height: Math.min(h, bottom + PAD) - Math.max(0, top - PAD),
        srcW:   w, srcH: h,
      };
    }

    function build(imgs) {
      // Compute ink bounds for each section
      const bounds = imgs.map(findInkBounds);

      // Larger overlap so sections blend at seams
      const OVERLAP = 20;
      const totals = bounds.reduce((sum, b, i) => sum + b.height - (i > 0 ? OVERLAP : 0), 0);

      const off = document.createElement("canvas");
      off.width = CANVAS_W;
      off.height = totals;
      const octx = off.getContext("2d");
      octx.fillStyle = "#fff8f8";
      octx.fillRect(0, 0, CANVAS_W, totals);

      // Stack the trimmed sections — each one drawn from its top ink bound, no gap
      let yCursor = 0;
      const yOff = [];
      bounds.forEach((b, i) => {
        yOff.push(yCursor);
        octx.drawImage(
          imgs[i],
          0, b.top, b.srcW, b.height,
          0, yCursor, CANVAS_W, b.height
        );
        yCursor += b.height - OVERLAP;
      });

      // Blend the seams — paint a gradient over each join zone so strokes
      // from adjacent sections fade into each other rather than hard-cutting.
      // We use "destination-out" to fade out the bottom of the upper section,
      // then draw the lower section on top (already done above, just refine).
      // Simpler approach: paint a cream→transparent gradient stripe at each seam.
      [yOff[1], yOff[2]].forEach(seamY => {
        if (!seamY) return;
        const BLEND = OVERLAP;
        // Fade bottom of upper section into the seam
        const fadeOut = octx.createLinearGradient(0, seamY - BLEND, 0, seamY + 2);
        fadeOut.addColorStop(0, "rgba(255,248,248,0)");
        fadeOut.addColorStop(1, "rgba(255,248,248,0.55)");
        octx.fillStyle = fadeOut;
        octx.fillRect(0, seamY - BLEND, CANVAS_W, BLEND + 2);
        // Fade top of lower section into the seam
        const fadeIn = octx.createLinearGradient(0, seamY, 0, seamY + BLEND);
        fadeIn.addColorStop(0, "rgba(255,248,248,0.55)");
        fadeIn.addColorStop(1, "rgba(255,248,248,0)");
        octx.fillStyle = fadeIn;
        octx.fillRect(0, seamY, CANVAS_W, BLEND);
      });

      rawRef.current = off;
      // Update the ref totals so the display canvas knows the new height
      tightHeightRef.current = totals;
      // Save section boundaries so the renderer can treat them as walls during flood fill
      // boundaries[0] = top edge of body, boundaries[1] = top edge of legs
      sectionBoundariesRef.current = [yOff[1], yOff[2]];

      // Slide-in animation onto display canvas — section by section
      const display = displayRef.current;
      const dctx = display.getContext("2d");
      dctx.fillStyle = "#fff8f8";
      dctx.fillRect(0, 0, CANVAS_W, displayH);
      bounds.forEach((b, i) => {
        setTimeout(() => {
          const y = yOff[i];
          const h = b.height;
          const t0 = performance.now();
          function frame(now) {
            const t = Math.min((now - t0) / 420, 1);
            const ease = 1 - Math.pow(1 - t, 3);
            dctx.save();
            dctx.beginPath(); dctx.rect(0, y, CANVAS_W, h); dctx.clip();
            dctx.fillStyle = "#fff8f8"; dctx.fillRect(0, y, CANVAS_W, h);
            dctx.globalAlpha = ease;
            dctx.drawImage(off, 0, y, CANVAS_W, h, 0, y + (1 - ease) * -55, CANVAS_W, h);
            dctx.globalAlpha = 1; dctx.restore();
            if (t < 1) requestAnimationFrame(frame);
            else if (i === bounds.length - 1) setStage("raw");
          }
          requestAnimationFrame(frame);
        }, i * 440);
      });
    }
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [sections]);

  const tightHeightRef = useRef(null);
  const sectionBoundariesRef = useRef(null);  // [bodyTopY, legsTopY] in stitched canvas

  const [renderError, setRenderError] = useState("");

  const applyFilter = (key) => {
    if (!rawRef.current || key === filterKey || working) return;
    setFilterKey(key);
    setWorking(true);
    setRenderError("");

    // Defer heavy work so the UI can paint the overlay
    setTimeout(() => {
      let styled;
      try {
        const t0 = performance.now();
        styled = FILTERS[key].apply(rawRef.current, { sectionBoundaries: sectionBoundariesRef.current });
        console.log(`[filter ${key}] rendered in ${(performance.now() - t0).toFixed(0)}ms`);
      } catch(e) {
        console.error("Filter error:", e);
        setRenderError(e.message || String(e));
        setWorking(false);
        return;
      }

      const from = styledRef.current || rawRef.current;
      styledRef.current = styled;
      setWorking(false);

      setStage("morphing");
      const dctx = displayRef.current.getContext("2d");
      const t0 = performance.now();
      const DUR = 1100;
      function morphFrame(now) {
        const t = Math.min((now - t0) / DUR, 1);
        const ease = t < 0.5 ? 2*t*t : -1 + (4 - 2*t)*t;
        setMorphAlpha(ease);
        dctx.clearRect(0, 0, CANVAS_W, displayH);
        dctx.globalAlpha = 1 - ease;
        dctx.drawImage(from, 0, 0);
        dctx.globalAlpha = ease;
        dctx.drawImage(styled, 0, 0);
        dctx.globalAlpha = 1;
        if (t < 1) rafRef.current = requestAnimationFrame(morphFrame);
        else setStage(key === "original" ? "raw" : "rendered");
      }
      rafRef.current = requestAnimationFrame(morphFrame);
    }, 50);
  };


  const [shareStatus, setShareStatus] = useState(""); // "" | "saving" | "saved" | "shared" | "error: ..."

  // Build a shareable card: the creature on a soft background with caption
  // showing who made it and a tiny "Folded Creature" wordmark.
  const buildShareCard = () => {
    const src = styledRef.current || rawRef.current;
    if (!src) return null;
    const W = src.width;
    const H = src.height;
    const PAD = 32;
    const TOP = 60;       // room for title at top
    const BOT = 80;       // room for caption + wordmark at bottom
    const card = document.createElement("canvas");
    card.width  = W + PAD * 2;
    card.height = H + TOP + BOT + PAD;
    const c = card.getContext("2d");

    // Background — soft cream gradient
    const bg = c.createLinearGradient(0, 0, 0, card.height);
    bg.addColorStop(0, "#fff8f8");
    bg.addColorStop(1, "#ffe8e8");
    c.fillStyle = bg;
    c.fillRect(0, 0, card.width, card.height);

    // Title
    c.fillStyle = "#3d1010";
    c.font = "700 32px 'Playfair Display', Georgia, serif";
    c.textAlign = "center";
    c.fillText("Ta-Daa!", card.width / 2, TOP - 18);

    // Drop-shadow then creature image
    c.save();
    c.shadowColor = "rgba(192,57,43,0.25)";
    c.shadowBlur = 24;
    c.shadowOffsetY = 8;
    c.fillStyle = "#fff";
    c.fillRect(PAD, TOP, W, H);
    c.restore();
    c.drawImage(src, PAD, TOP);

    // Border around image
    c.strokeStyle = "#C0392B";
    c.lineWidth = 3;
    c.strokeRect(PAD, TOP, W, H);

    // Caption: "X, Y, Z made a creature together"
    c.fillStyle = "#C0392B";
    c.font = "600 18px 'Nunito', system-ui, sans-serif";
    c.textAlign = "center";
    const playerList = players.filter(Boolean).join(", ") || "Three friends";
    c.fillText(`${playerList} made a creature together`, card.width / 2, TOP + H + 38);

    // Wordmark at bottom
    c.fillStyle = "#3d1010aa";
    c.font = "500 13px 'Nunito', system-ui, sans-serif";
    c.fillText("Folded Creature", card.width / 2, card.height - 18);

    return card;
  };

  // Build a transparent-background sticker — just the creature, tightly cropped,
  // no card chrome. Perfect for iMessage / WhatsApp / Telegram stickers.
  const buildSticker = () => {
    const src = styledRef.current || rawRef.current;
    if (!src) return null;
    const W = src.width, H = src.height;

    // First, build a transparent version: copy src but make near-white pixels
    // transparent so the sticker has a clean see-through background.
    const cutout = document.createElement("canvas");
    cutout.width = W; cutout.height = H;
    const cctx = cutout.getContext("2d");
    cctx.drawImage(src, 0, 0);
    try {
      const img = cctx.getImageData(0, 0, W, H);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i+1], b = d[i+2];
        const brightness = (r + g + b) / 3;
        // Anything close to white (the bg of the cartoon render) → transparent
        if (brightness > 240) {
          d[i+3] = 0;
        } else if (brightness > 220) {
          // Soft edge — partial transparency for anti-aliasing
          d[i+3] = Math.round(d[i+3] * (1 - (brightness - 220) / 20));
        }
      }
      cctx.putImageData(img, 0, 0);
    } catch(e) {
      console.warn("Sticker cutout failed:", e.message);
    }

    // Find the tight bounding box of remaining non-transparent pixels.
    let minX = W, maxX = 0, minY = H, maxY = 0, found = false;
    try {
      const img = cctx.getImageData(0, 0, W, H);
      const d = img.data;
      for (let y = 0; y < H; y += 2) {
        for (let x = 0; x < W; x += 2) {
          const a = d[(y * W + x) * 4 + 3];
          if (a > 30) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            found = true;
          }
        }
      }
    } catch(e) {}
    if (!found) { minX = 0; minY = 0; maxX = W - 1; maxY = H - 1; }

    // Add small padding & crop to a square (most messaging stickers prefer square)
    const PAD = 16;
    const w = maxX - minX, h = maxY - minY;
    const side = Math.max(w, h) + PAD * 2;
    const sticker = document.createElement("canvas");
    // iMessage stickers should be 408x408 minimum; WhatsApp wants 512x512.
    // Use 512 for max compatibility.
    const TARGET = 512;
    sticker.width = TARGET; sticker.height = TARGET;
    const sctx = sticker.getContext("2d");
    // Centre the cropped creature in the square canvas
    const scale = TARGET / side;
    const drawW = w * scale;
    const drawH = h * scale;
    sctx.drawImage(
      cutout,
      minX, minY, w, h,
      (TARGET - drawW) / 2, (TARGET - drawH) / 2, drawW, drawH
    );

    return sticker;
  };

  // Generic share/save flow — works for any canvas (card or sticker)
  const shareCanvas = async (canvas, opts = {}) => {
    const { kind = "image", suffix = "" } = opts;
    if (!canvas) {
      setShareStatus("error: nothing to save");
      setTimeout(() => setShareStatus(""), 3000);
      return;
    }
    const baseName = (players[0] || "creature").toLowerCase().replace(/[^a-z0-9]/g, "");
    const filename = `folded-${baseName}${suffix ? "-" + suffix : ""}.png`;

    // Try native share first
    if (typeof navigator !== "undefined" && navigator.canShare) {
      try {
        const blob = await new Promise((res, rej) => canvas.toBlob(
          b => b ? res(b) : rej(new Error("blob fail")), "image/png"));
        const file = new File([blob], filename, { type: "image/png" });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({
            files: [file],
            title: kind === "sticker" ? "Folded Creature Sticker" : "Folded Creature",
          });
          setShareStatus("shared");
          setTimeout(() => setShareStatus(""), 3500);
          return;
        }
      } catch(e) {
        if (e.name === "AbortError") { setShareStatus(""); return; }
        console.warn("Share failed, falling back to download:", e.message);
      }
    }

    // Fallback: download
    try {
      const link = document.createElement("a");
      link.download = filename;
      link.href = canvas.toDataURL("image/png");
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setShareStatus("saved");
      setTimeout(() => setShareStatus(""), 2500);
    } catch(e) {
      setShareStatus("error: " + e.message);
      setTimeout(() => setShareStatus(""), 3000);
    }
  };

  const saveImage = async () => {
    setShareStatus("saving");
    shareCanvas(buildShareCard());
  };

  const saveSticker = async () => {
    setShareStatus("saving");
    shareCanvas(buildSticker(), { kind: "sticker", suffix: "sticker" });
  };

  const scaledW = CANVAS_W * scale;
  const scaledH = displayH * scale;

  return (
    <div ref={containerRef} style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:12, width:"100%" }}>
      <div style={{
        position:"relative", width:scaledW, height:scaledH, flexShrink:0,
        borderRadius:20, overflow:"hidden",
        border:`3px solid ${filterKey!=="original" ? "#e67e22" : "#C0392B"}`,
        boxShadow: filterKey!=="original" ? "0 8px 48px #e67e2244" : "0 8px 48px #C0392B33",
        transition:"border-color 0.6s, box-shadow 0.6s",
        background:"#fff",
      }}>
        <canvas ref={displayRef} width={CANVAS_W} height={displayH}
          style={{ display:"block", width:scaledW, height:scaledH }} />
        {working && (
          <div style={{ position:"absolute", inset:0, background:"#ffffffaa",
            display:"flex", alignItems:"center", justifyContent:"center",
            fontFamily:"'Nunito',sans-serif", fontSize:14, color:"#C0392B", fontWeight:700 }}>
            ✨ Rendering...
          </div>
        )}
        {stage === "morphing" && !working && (
          <div style={{ position:"absolute", bottom:10, left:"50%", transform:"translateX(-50%)",
            background:"#000a", borderRadius:20, padding:"5px 14px",
            fontFamily:"'Nunito',sans-serif", fontSize:12, color:"#fff", whiteSpace:"nowrap" }}>
            ✨ {Math.round(morphAlpha * 100)}%
          </div>
        )}
      </div>

      {renderError && (
        <div style={{ background:"#fff0f0", border:"2px solid #C0392B", borderRadius:12,
          padding:"10px 14px", fontFamily:"monospace", fontSize:11,
          color:"#C0392B", maxWidth:scaledW, wordBreak:"break-word", width:"100%", boxSizing:"border-box" }}>
          <div style={{ fontWeight:700, marginBottom:4, fontFamily:"'Nunito',sans-serif" }}>Render error:</div>
          {renderError}
        </div>
      )}

      {stage !== "building" && (
        <div style={{ width:"100%", overflow:"auto", WebkitOverflowScrolling:"touch" }}>
          <div style={{ display:"flex", gap:8, paddingBottom:4, minWidth:"min-content", justifyContent:"center" }}>
            {Object.entries(FILTERS).map(([key, f]) => (
              <button key={key} onClick={() => applyFilter(key)} disabled={working} style={{
                flexShrink:0, minWidth:88,
                padding:"8px 12px", borderRadius:14, cursor: working ? "default" : "pointer",
                border: filterKey === key ? "2px solid #C0392B" : "2px solid #eee",
                background: filterKey === key ? "#fdf0f0" : "#fff",
                fontFamily:"'Nunito',sans-serif", display:"flex", flexDirection:"column",
                alignItems:"center", gap:2, opacity: working ? 0.5 : 1,
                transform: filterKey === key ? "scale(1.05)" : "scale(1)",
                transition:"all 0.2s",
                boxShadow: filterKey === key ? "0 4px 12px #C0392B33" : "0 2px 6px #0001",
              }}>
                <span style={{ fontSize:13, fontWeight:700, color: filterKey === key ? "#C0392B" : "#3d1010" }}>{f.name}</span>
                <span style={{ fontSize:10, color:"#888" }}>{f.subtitle}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {(stage === "raw" || stage === "rendered") && (
        <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:8 }}>
          <div style={{ display:"flex", gap:10, flexWrap:"wrap", justifyContent:"center" }}>
            <button onClick={saveImage} disabled={shareStatus === "saving"}
              style={rBtn("linear-gradient(135deg,#27ae60,#2980b9)")}>
              {shareStatus === "saving" ? "Preparing..." : "Save"}
            </button>
            <button onClick={saveSticker} disabled={shareStatus === "saving"}
              style={rBtn("linear-gradient(135deg,#e67e22,#C0392B)")}>
              Sticker
            </button>
          </div>
          {shareStatus && shareStatus !== "saving" && (
            <div style={{
              fontFamily:"'Nunito',sans-serif", fontSize:13, fontWeight:600,
              color: shareStatus.startsWith("error") ? "#C0392B" : "#27ae60",
              padding:"4px 12px", borderRadius:14,
              background: shareStatus.startsWith("error") ? "#fff0f0" : "#f0fff5",
              border: `1px solid ${shareStatus.startsWith("error") ? "#f5c0bb" : "#a8e6c1"}`,
              maxWidth:scaledW, textAlign:"center",
            }}>
              {shareStatus === "shared" && "✓ Tap 'Save Image' in the sheet to add to Photos"}
              {shareStatus === "saved"  && "✓ Saved to your device"}
              {shareStatus.startsWith("error") && shareStatus}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function rBtn(bg) {
  return {
    padding:"12px 22px", borderRadius:50, border:"none", background:bg,
    color:"#fff", fontFamily:"'Playfair Display',serif", fontSize:15, fontWeight:700,
    cursor:"pointer", boxShadow:"0 4px 16px #0003",
  };
}



// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [screen,         setScreen]        = useState("home");
  const [mode,           setMode]          = useState("passplay");
  const [players,        setPlayers]       = useState(["","",""]);
  const [myName,         setMyName]        = useState("");
  const [currentSection, setCurrentSection]= useState(0);
  const [drawings,       setDrawings]      = useState([]);

  // Async multiplayer state
  const [gameCode,       setGameCode]      = useState("");
  const [mySlot,         setMySlot]        = useState(null);
  const [myPart,         setMyPart]        = useState(null);
  const [gameSlots,      setGameSlots]     = useState({});
  const [anchors,        setAnchors]       = useState(null);
  const [mpError,        setMpError]       = useState("");
  const [joinCode,       setJoinCode]      = useState("");
  const [joinError,      setJoinError]     = useState("");
  const [copyFeedback,   setCopyFeedback]  = useState("");
  const [storageStatus,  setStorageStatus] = useState("checking...");
  const pollRef = useRef(null);
  const [activeGames,  setActiveGames]  = useState([]);
  const [recentGames,  setRecentGames]  = useState([]);
  const [gameStatuses, setGameStatuses] = useState({});

  // Load active + recent games from localStorage on mount
  useEffect(() => {
    try {
      const active = JSON.parse(localStorage.getItem("fc_active_games") || "[]");
      setActiveGames(active.filter(g => g.code && g.myName));
      const recent = JSON.parse(localStorage.getItem("fc_recent_games") || "[]");
      setRecentGames(recent);
    } catch(e) {}
  }, []);

  // Fetch live Firebase status for each active game
  useEffect(() => {
    if (activeGames.length === 0) return;
    const statuses = {};
    Promise.all(activeGames.map(async g => {
      try {
        const game = await loadGame(g.code);
        if (!game) { statuses[g.code] = { expired: true }; return; }
        const drawingCount = Object.values(game.slots || {}).filter(s => s.drawing).length;
        statuses[g.code] = { drawingCount, slots: game.slots || {}, status: game.status };
      } catch(e) { statuses[g.code] = { error: true }; }
    })).then(() => setGameStatuses(statuses));
  }, [activeGames]);

  const saveActiveGame = (code, name, part) => {
    try {
      const stored = JSON.parse(localStorage.getItem("fc_active_games") || "[]");
      const filtered = stored.filter(g => g.code !== code);
      const updated = [{ code, myName: name, myPart: part, ts: Date.now() }, ...filtered].slice(0, 5);
      localStorage.setItem("fc_active_games", JSON.stringify(updated));
      setActiveGames(updated);
    } catch(e) {}
  };

  const removeActiveGame = (code) => {
    try {
      const stored = JSON.parse(localStorage.getItem("fc_active_games") || "[]");
      const updated = stored.filter(g => g.code !== code);
      localStorage.setItem("fc_active_games", JSON.stringify(updated));
      setActiveGames(updated);
    } catch(e) {}
  };

  const saveRecentGame = (code, drawings, players) => {
    try {
      const stored = JSON.parse(localStorage.getItem("fc_recent_games") || "[]");
      const filtered = stored.filter(g => g.code !== code);
      // Store up to 5 completed games with their drawings for sticker re-saving
      const updated = [{ code, drawings, players, ts: Date.now() }, ...filtered].slice(0, 5);
      localStorage.setItem("fc_recent_games", JSON.stringify(updated));
      setRecentGames(updated);
    } catch(e) { console.warn("Couldn't save recent game:", e.message); }
  };

  // Poll share screen for updates when waiting for others
  const startSharePolling = (code) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const g = await loadGame(code);
        if (!g?.slots) return;
        setGameSlots(g.slots);
        if (g.status === "complete" || Object.values(g.slots).filter(s => s.drawing).length >= 3) {
          clearInterval(pollRef.current);
        }
      } catch(e) {}
    }, 5000); // poll every 5 seconds on share screen
  };

  const PARTS = ["head", "body", "legs"];
  const PART_SECTION = { head: 0, body: 1, legs: 2 };
  const PART_HINTS = {
    head: "Draw a head — any kind of creature! Finish near the bottom of the canvas.",
    body: "Draw the body — arms, torso, whatever! Connect from the top anchor dots.",
    legs: "Draw the legs and feet! Connect from the top anchor dots.",
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const url = new URL(window.location.href);
      const code = url.searchParams.get("code");
      if (code && /^[A-Z0-9]{3,8}$/i.test(code)) {
        setJoinCode(code.toUpperCase());
        setScreen("join");
      }
    } catch(e) {}
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const m = await getStorageMode();
        if (m === "firebase") setStorageStatus("ready · Firebase (cross-device)");
        else if (m === "localStorage") setStorageStatus("ready · localStorage (cross-tab only)");
        else setStorageStatus("ready · memory (single-tab test)");
      } catch(e) { setStorageStatus("error: " + (e.message || String(e))); }
    })();
  }, []);

  const Fonts = () => (
    <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=Nunito:wght@400;600;700&display=swap" rel="stylesheet" />
  );

  // Pass-and-play
  const startPassPlay = () => {
    if (players.some(p => !p.trim())) return;
    setMode("passplay"); setScreen("playing"); setCurrentSection(0); setDrawings([]);
  };
  const handleSectionDone = (data) => {
    const nd = [...drawings, data];
    setDrawings(nd);
    if (currentSection < 2) setScreen("handoff");
    else setScreen("reveal");
  };
  const handleHandoffContinue = () => {
    setCurrentSection(c => c+1);
    setScreen("playing");
  };

  // Async multiplayer
  const pickRandomPart = (slots) => {
    // Include reserved slots (creator's placeholder) as taken
    const taken = Object.values(slots).map(s => s.part).filter(Boolean);
    const available = PARTS.filter(p => !taken.includes(p));
    if (available.length === 0) return PARTS[Math.floor(Math.random() * 3)]; // fallback
    return available[Math.floor(Math.random() * available.length)];
  };

  // Creator taps "Start Drawing" — create the game code first, show invite screen
  const startCreatorGame = async () => {
    if (!myName.trim()) return;
    setMpError("");
    const code = makeCode();
    const part = PARTS[Math.floor(Math.random() * 3)];
    const anchors = makeAnchors(CANVAS_W);
    const game = {
      status: "drawing",
      anchors,
      // Reserve slot 0 for creator with a placeholder so joiners get slots 1 & 2
      slots: { 0: { name: myName, part, drawing: null, reserved: true } },
      createdAt: Date.now(),
    };
    try { await storeGame(code, game); }
    catch(e) { setMpError("Couldn't create game: " + e.message); return; }
    setGameCode(code);
    setMySlot(0);
    setMyPart(part);
    setGameSlots(game.slots);
    setAnchors(anchors);
    setMode("multiplayer");
    setCurrentSection(PART_SECTION[part]);
    saveActiveGame(code, myName, part);
    startSharePolling(code);
    setScreen("pre-draw-share");
  };

  // Called when creator finishes drawing (after sharing)
  const handleCreatorDone = async (drawing) => {
    setMpError("");
    let g;
    try { g = await loadGame(gameCode); }
    catch(e) { setMpError("Couldn't save: " + e.message); return; }
    if (!g) { setMpError("Game not found"); return; }
    if (!g.slots) g.slots = {};
    g.slots[0] = { name: myName, part: myPart, drawing };
    const drawingCount = Object.values(g.slots).filter(s => s.drawing).length;
    if (drawingCount >= 3) g.status = "complete";
    try { await storeGame(gameCode, g); }
    catch(e) { setMpError("Couldn't save: " + e.message); return; }
    setGameSlots(g.slots);
    if (g.status === "complete") {
      const byPart = {};
      Object.values(g.slots).forEach(s => { byPart[s.part] = s; });
      const ordered = ["head","body","legs"].map(p => byPart[p]?.drawing).filter(Boolean);
      const names   = ["head","body","legs"].map(p => byPart[p]?.name).filter(Boolean);
      removeActiveGame(gameCode);
      saveRecentGame(gameCode, ordered, names);
      setDrawings(ordered); setPlayers(names); setScreen("reveal");
    } else {
      startSharePolling(gameCode);
      setScreen("share");
    }
  };

  const handleJoinerDone = async (drawing) => {
    setMpError("");
    let g;
    try { g = await loadGame(gameCode); }
    catch(e) { setMpError("Couldn't save: " + e.message); return; }
    if (!g) { setMpError("Game not found"); return; }
    if (!g.slots) g.slots = {};
    g.slots[mySlot] = { name: myName, part: myPart, drawing };
    const drawingCount = Object.values(g.slots).filter(s => s.drawing).length;
    if (drawingCount >= 3) g.status = "complete";
    try { await storeGame(gameCode, g); }
    catch(e) { setMpError("Couldn't save: " + e.message); return; }
    setGameSlots(g.slots);
    if (g.status === "complete") {
      const byPart = {};
      Object.values(g.slots).forEach(s => { byPart[s.part] = s; });
      const ordered = ["head","body","legs"].map(p => byPart[p]?.drawing).filter(Boolean);
      const names   = ["head","body","legs"].map(p => byPart[p]?.name).filter(Boolean);
      removeActiveGame(gameCode);
      saveRecentGame(gameCode, ordered, names);
      setDrawings(ordered); setPlayers(names); setScreen("reveal");
    } else {
      saveActiveGame(gameCode, myName, myPart);
      startSharePolling(gameCode);
      setScreen("share");
    }
  };

  const joinAsyncGame = async () => {
    const code = joinCode.trim().toUpperCase();
    if (!code || !myName.trim()) { setJoinError("Enter your name and the room code"); return; }
    setJoinError(""); setMpError("");
    let g;
    try { g = await loadGame(code); }
    catch(e) { setJoinError("Couldn't reach the game: " + e.message); return; }
    if (!g) { setJoinError("Game not found — check the code"); return; }
    if (!g.slots) g.slots = {};
    if (g.status === "complete" || Object.values(g.slots).filter(s => s.drawing).length >= 3) {
      const byPart = {};
      Object.values(g.slots).forEach(s => { byPart[s.part] = s; });
      const ordered = ["head","body","legs"].map(p => byPart[p]?.drawing).filter(Boolean);
      const names   = ["head","body","legs"].map(p => byPart[p]?.name).filter(Boolean);
      setDrawings(ordered); setPlayers(names); setGameCode(code); setGameSlots(g.slots);
      setScreen("reveal"); return;
    }
    const takenNames = Object.values(g.slots).map(s => s.name);
    if (takenNames.includes(myName.trim())) { setJoinError("That name is taken — pick another"); return; }
    const part = pickRandomPart(g.slots);
    // Slot number = number of slots already in game (including reserved)
    const slot = Object.keys(g.slots).length;
    if (slot >= 3) { setJoinError("This game is already full"); return; }
    setGameCode(code); setMySlot(slot); setMyPart(part); setGameSlots(g.slots);
    if (g.anchors) setAnchors(g.anchors);
    setMode("multiplayer"); setCurrentSection(PART_SECTION[part]);
    setScreen("async-drawing");
  };

  const reset = () => {
    clearInterval(pollRef.current);
    if (gameCode) removeActiveGame(gameCode);
    setScreen("home"); setPlayers(["","",""]); setMyName(""); setMySlot(null);
    setMyPart(null); setGameCode(""); setJoinCode(""); setJoinError("");
    setCurrentSection(0); setDrawings([]); setGameSlots({}); setMpError(""); setAnchors(null);
  };

  useEffect(() => () => clearInterval(pollRef.current), []);

  // ── HOME ──────────────────────────────────────────────────────────────────────
  if (screen === "home") return (
    <div style={page}>
      <Fonts />
      <div style={{ width:"100%", maxWidth:420, display:"flex", flexDirection:"column", gap:0 }}>
        <div style={{ padding:"48px 24px 32px", textAlign:"center" }}>
          <div style={{ fontFamily:"'Playfair Display',serif", fontSize:42, fontWeight:900,
            color:"#3d1010", letterSpacing:-1, lineHeight:1.1 }}>
            Draw.<br/>Share.<br/>Surprise.
          </div>
          <p style={{ fontFamily:"'Nunito',sans-serif", color:"#b07070", fontSize:14, marginTop:12 }}>
            A Folded Creature creation
          </p>
        </div>
        <div style={{ padding:"0 16px", display:"flex", flexDirection:"column", gap:12 }}>
          <div style={{ background:"#fff", borderRadius:20, padding:"20px 20px 16px",
            boxShadow:"0 2px 12px rgba(192,57,43,0.10)", border:"1.5px solid #f5e8e8" }}>
            <div style={{ fontFamily:"'Playfair Display',serif", fontSize:20, fontWeight:700,
              color:"#3d1010", marginBottom:6 }}>Play with friends</div>
            <p style={{ fontFamily:"'Nunito',sans-serif", fontSize:13, color:"#b07070", margin:"0 0 14px" }}>
              Draw your part, share the link. Friends draw whenever — no need to be online at the same time.
            </p>
            <input placeholder="Your name..."
              value={myName} onChange={e => setMyName(e.target.value)}
              style={{ ...input, marginBottom:10 }} />
            <button
              onClick={startCreatorGame}
              disabled={!myName.trim()}
              style={bigBtn(!myName.trim() ? "#ddd" : "#C0392B", !myName.trim() ? "#aaa" : "#fff")}
            >
              Start Drawing
            </button>
          </div>

          <button onClick={() => setScreen("join")} style={bigBtn("#f2c4c4", "#3d1010")}>
            Join a Friend's Game
          </button>

          <div style={{ display:"flex", alignItems:"center", gap:10, margin:"4px 0" }}>
            <div style={{ flex:1, height:1, background:"#eee" }} />
            <span style={{ fontFamily:"'Nunito',sans-serif", fontSize:12, color:"#bbb" }}>or play on this phone</span>
            <div style={{ flex:1, height:1, background:"#eee" }} />
          </div>

          <button onClick={() => setScreen("lobby")} style={{ ...bigBtn("#f8f0f0", "#b07070"), fontSize:14 }}>
            Pass &amp; Play (one phone)
          </button>
        </div>
        <div style={{ fontFamily:"monospace", fontSize:10,
          color: storageStatus.startsWith("ready · Firebase") ? "#27ae60" : "#b07070",
          textAlign:"center", padding:"16px 16px 8px" }}>
          {storageStatus}
        </div>

        {/* Games in progress — shows live Firebase status */}
        {activeGames.length > 0 && (
          <div style={{ padding:"0 16px 8px" }}>
            <div style={{ fontFamily:"'Playfair Display',serif", fontSize:16, fontWeight:700,
              color:"#3d1010", marginBottom:8 }}>Games in progress</div>
            {activeGames.map(g => {
              const status = gameStatuses[g.code];
              const drawingCount = status?.drawingCount || 0;
              const isExpired = status?.expired;
              const isComplete = status?.status === "complete" || drawingCount >= 3;
              const slots = status?.slots || {};
              return (
                <button key={g.code} onClick={async () => {
                  try {
                    const game = await loadGame(g.code);
                    if (!game) { removeActiveGame(g.code); return; }
                    setGameCode(g.code);
                    setMyName(g.myName);
                    setMyPart(g.myPart);
                    setGameSlots(game.slots || {});
                    if (game.status === "complete" || Object.values(game.slots || {}).filter(s => s.drawing).length >= 3) {
                      const byPart = {};
                      Object.values(game.slots || {}).forEach(s => { byPart[s.part] = s; });
                      const ordered = ["head","body","legs"].map(p => byPart[p]?.drawing).filter(Boolean);
                      const names   = ["head","body","legs"].map(p => byPart[p]?.name).filter(Boolean);
                      removeActiveGame(g.code);
                      saveRecentGame(g.code, ordered, names);
                      setDrawings(ordered); setPlayers(names); setScreen("reveal");
                    } else {
                      startSharePolling(g.code);
                      setScreen("share");
                    }
                  } catch(e) { setMpError("Couldn't load: " + e.message); }
                }} style={{ width:"100%", background:"#fff",
                  border:`1.5px solid ${isComplete ? "#27ae60" : "#f2c4c4"}`,
                  borderRadius:14, padding:"12px 16px", marginBottom:8, cursor:"pointer",
                  display:"flex", alignItems:"center", gap:12,
                  boxSizing:"border-box", textAlign:"left" }}>
                  <div style={{ width:40, height:40, borderRadius:"50%", flexShrink:0,
                    background: isComplete ? "#e8f8f0" : "#fdf0f0",
                    display:"flex", alignItems:"center", justifyContent:"center", fontSize:18 }}>
                    {isComplete ? "🎨" : drawingCount === 0 ? "✏️" : "⏳"}
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontFamily:"'Nunito',sans-serif", fontSize:13, fontWeight:700,
                      color:"#3d1010" }}>
                      {isComplete ? "Ready to reveal! 🎉" :
                       isExpired ? "Game expired" :
                       `${drawingCount}/3 parts drawn`}
                    </div>
                    <div style={{ fontFamily:"'Nunito',sans-serif", fontSize:11, color:"#b07070", marginTop:2 }}>
                      You drew the {g.myPart} · Code: {g.code}
                    </div>
                    {!isComplete && !isExpired && (
                      <div style={{ display:"flex", gap:4, marginTop:4 }}>
                        {["head","body","legs"].map(part => {
                          const done = Object.values(slots).some(s => s.part === part && s.drawing);
                          return (
                            <div key={part} style={{ fontFamily:"'Nunito',sans-serif", fontSize:10,
                              padding:"2px 7px", borderRadius:10,
                              background: done ? "#e8f8f0" : "#f5e8e8",
                              color: done ? "#27ae60" : "#b07070", fontWeight: done ? 700 : 400 }}>
                              {done ? "✓" : "?"} {part}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <div style={{ fontFamily:"'Nunito',sans-serif", fontSize:12, flexShrink:0,
                    color: isComplete ? "#27ae60" : "#C0392B", fontWeight:700 }}>
                    {isComplete ? "Reveal →" : "Check →"}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* Recent completed games — re-save stickers any time */}
        {recentGames.length > 0 && (
          <div style={{ padding:"0 16px 16px" }}>
            <div style={{ fontFamily:"'Playfair Display',serif", fontSize:16, fontWeight:700,
              color:"#3d1010", marginBottom:8 }}>Recent creatures</div>
            {recentGames.map(g => (
              <button key={g.code} onClick={() => {
                setDrawings(g.drawings || []);
                setPlayers(g.players || []);
                setScreen("reveal");
              }} style={{ width:"100%", background:"#fff", border:"1.5px solid #e8f0e8",
                borderRadius:14, padding:"12px 16px", marginBottom:8, cursor:"pointer",
                display:"flex", alignItems:"center", gap:12,
                boxSizing:"border-box", textAlign:"left" }}>
                <div style={{ width:40, height:40, borderRadius:"50%", flexShrink:0,
                  background:"#f0f8f0", display:"flex", alignItems:"center",
                  justifyContent:"center", fontSize:20 }}>🐾</div>
                <div style={{ flex:1 }}>
                  <div style={{ fontFamily:"'Nunito',sans-serif", fontSize:13, fontWeight:700, color:"#3d1010" }}>
                    {(g.players || []).join(", ") || "A creature"}
                  </div>
                  <div style={{ fontFamily:"'Nunito',sans-serif", fontSize:11, color:"#b07070" }}>
                    {new Date(g.ts).toLocaleDateString()} · tap to re-save sticker
                  </div>
                </div>
                <div style={{ fontFamily:"'Nunito',sans-serif", fontSize:12,
                  color:"#27ae60", fontWeight:700, flexShrink:0 }}>View →</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  // ── LOBBY (pass-and-play name entry) ──────────────────────────────────────────
  if (screen === "lobby") return (
    <div style={page}>
      <Fonts />
      <div style={card}>
        <BackBtn onClick={() => setScreen("home")} />
        <h2 style={title}>Who's playing?</h2>
        <p style={sub}>Enter 3 names and pass the phone between turns.</p>
        <div style={{ width:"100%", display:"flex", flexDirection:"column", gap:10, marginBottom:16 }}>
          {["draws the HEAD","draws the BODY","draws the LEGS"].map((label, i) => (
            <div key={i}>
              <div style={{ fontFamily:"'Nunito',sans-serif", fontSize:11, color:"#b07070", marginBottom:3,
                fontWeight:700, textTransform:"uppercase", letterSpacing:1 }}>
                Player {i+1} — {label}
              </div>
              <input placeholder="Name..." value={players[i]}
                onChange={e => { const p=[...players]; p[i]=e.target.value; setPlayers(p); }}
                style={input} />
            </div>
          ))}
        </div>
        <button onClick={startPassPlay} disabled={players.some(p=>!p.trim())}
          style={bigBtn(players.some(p=>!p.trim()) ? "#ddd" : "#C0392B", players.some(p=>!p.trim()) ? "#aaa" : "#fff")}>
          Play on This Phone
        </button>
      </div>
    </div>
  );

  // ── JOIN ──────────────────────────────────────────────────────────────────────
  if (screen === "join") return (
    <div style={page}>
      <Fonts />
      <div style={card}>
        <BackBtn onClick={() => setScreen("home")} />
        <h2 style={title}>Join a Game</h2>
        <p style={sub}>Enter your name and the code your friend shared.</p>
        <div style={{ width:"100%", display:"flex", flexDirection:"column", gap:10 }}>
          <input placeholder="Your name..." value={myName} onChange={e=>setMyName(e.target.value)} style={input} />
          <input placeholder="Room code (e.g. XK72A)..." value={joinCode}
            onChange={e=>setJoinCode(e.target.value.toUpperCase())}
            style={{ ...input, fontFamily:"'Playfair Display',serif", fontSize:22, textAlign:"center", letterSpacing:4 }} />
          {joinError && <div style={{ color:"#C0392B", fontFamily:"'Nunito',sans-serif", fontSize:13, textAlign:"center" }}>{joinError}</div>}
          <button onClick={joinAsyncGame} disabled={!myName.trim() || !joinCode.trim()}
            style={bigBtn(!myName.trim() || !joinCode.trim() ? "#ddd" : "#C0392B", !myName.trim() || !joinCode.trim() ? "#aaa" : "#fff")}>
            Join &amp; Draw
          </button>
        </div>
      </div>
    </div>
  );

  // ── PRE-DRAW SHARE — creator shares invite before drawing their own part ──────
  if (screen === "pre-draw-share") {
    const shareInvite = async () => {
      let url = "";
      try {
        const u = new URL(window.location.href);
        u.searchParams.set("code", gameCode);
        url = u.toString();
      } catch(e) {}
      const text = url
        ? `Join my Folded Creature game! We each draw one secret part. Join here: ${url}`
        : `Join my Folded Creature game! Code: ${gameCode}`;
      if (navigator.share) {
        try { await navigator.share({ title:"Folded Creature", text }); return; }
        catch(e) { if (e.name === "AbortError") return; }
      }
      try {
        await navigator.clipboard.writeText(text);
        setCopyFeedback("✓ Invite copied!");
        setTimeout(() => setCopyFeedback(""), 3000);
      } catch(e) { window.prompt("Copy this invite:", text); }
    };

    return (
      <div style={page}>
        <Fonts />
        <div style={card}>
          <div style={{ textAlign:"center", marginBottom:16 }}>
            <div style={{ fontSize:48 }}>🎨</div>
            <h2 style={{ ...title, marginBottom:6 }}>Invite your friends first!</h2>
            <p style={{ ...sub, marginBottom:0 }}>
              Share the code with 2 friends. They can start drawing while you draw yours — everyone reveals together.
            </p>
          </div>

          {/* Room code */}
          <button onClick={async () => {
            try {
              await navigator.clipboard.writeText(gameCode);
              setCopyFeedback("✓ Code copied!");
              setTimeout(() => setCopyFeedback(""), 1800);
            } catch(e) {}
          }} style={{ background:"#fdf0f0", border:"2px dashed #e8b4b4", borderRadius:16,
            padding:"14px 24px", width:"100%", boxSizing:"border-box", cursor:"pointer", marginBottom:10 }}>
            <div style={{ fontFamily:"'Playfair Display',serif", fontSize:36, fontWeight:900,
              color:"#C0392B", letterSpacing:6 }}>{gameCode}</div>
            <div style={{ fontFamily:"'Nunito',sans-serif", fontSize:12, color:"#b07070", marginTop:2 }}>
              {copyFeedback && copyFeedback.includes("Code") ? copyFeedback : "Tap to copy code"}
            </div>
          </button>

          <button onClick={shareInvite} style={{ ...bigBtn("#8e44ad"), marginBottom:10 }}>
            Share Invite Link
          </button>
          {copyFeedback && copyFeedback.includes("Invite") && (
            <div style={{ fontFamily:"'Nunito',sans-serif", fontSize:12, color:"#27ae60",
              textAlign:"center", marginBottom:10, fontWeight:600 }}>{copyFeedback}</div>
          )}

          {/* Who's drawing what */}
          <div style={{ width:"100%", marginBottom:16 }}>
            <div style={{ fontFamily:"'Nunito',sans-serif", fontSize:12, color:"#b07070",
              textAlign:"center", marginBottom:8 }}>You'll be assigned a random part to draw</div>
            {["head","body","legs"].map(part => (
              <div key={part} style={{ display:"flex", alignItems:"center", gap:10,
                padding:"8px 0", borderBottom:"1px solid #f5e8e8" }}>
                <div style={{ width:32, height:32, borderRadius:"50%", background:"#f5e8e8",
                  display:"flex", alignItems:"center", justifyContent:"center",
                  fontFamily:"'Nunito',sans-serif", fontSize:13, color:"#ddd", fontWeight:700 }}>?</div>
                <div style={{ fontFamily:"'Nunito',sans-serif", fontSize:14, color:"#ccc" }}>
                  draws the {part}
                </div>
              </div>
            ))}
          </div>

          <button onClick={() => setScreen("async-drawing")} style={bigBtn("#C0392B")}>
            I'm ready — start drawing my part!
          </button>

          {mpError && (
            <div style={{ color:"#C0392B", fontFamily:"'Nunito',sans-serif",
              fontSize:13, textAlign:"center", marginTop:8 }}>{mpError}</div>
          )}
          <button onClick={reset} style={{ marginTop:12, background:"none", border:"none",
            fontFamily:"'Nunito',sans-serif", fontSize:13, color:"#b07070",
            cursor:"pointer", textDecoration:"underline" }}>
            Cancel
          </button>
        </div>
      </div>
    );
  }


  if (screen === "async-drawing") {
    const isCreator = mySlot === null || mySlot === undefined;
    const part = isCreator ? PARTS[currentSection] : myPart;
    const slotSection = PART_SECTION[part] ?? currentSection;
    const hint = PART_HINTS[part] || "";
    const otherSlots = Object.values(gameSlots || {});
    return (
      <div style={page}>
        <Fonts />
        <div style={{ ...card, maxWidth:460 }}>
          <div style={{ alignSelf:"flex-start", marginBottom:8 }}>
            <div style={{ fontFamily:"'Playfair Display',serif", fontSize:22, fontWeight:700, color:"#3d1010" }}>
              You're drawing the <span style={{ color:"#C0392B" }}>{part?.toUpperCase()}</span>
            </div>
            <div style={{ fontFamily:"'Nunito',sans-serif", fontSize:12, color:"#b07070", marginTop:2 }}>
              {hint}
            </div>
          </div>
          {otherSlots.length > 0 && (
            <div style={{ display:"flex", gap:8, marginBottom:10, flexWrap:"wrap", width:"100%" }}>
              {otherSlots.map((s, i) => (
                <div key={i} style={{ fontFamily:"'Nunito',sans-serif", fontSize:12,
                  background:"#f5e8e8", borderRadius:20, padding:"3px 10px", color:"#C0392B", fontWeight:600 }}>
                  ✓ {s.name} drew the {s.part}
                </div>
              ))}
            </div>
          )}
          <DrawingCanvas
            sectionIndex={slotSection}
            onDone={mySlot === 0 ? handleCreatorDone : handleJoinerDone}
            peekImageData={null}
            peekHeight={null}
            anchors={anchors}
            doneLabel="Done — wait for your surprise! 🎁"
          />
          {mpError && (
            <div style={{ color:"#C0392B", fontFamily:"'Nunito',sans-serif",
              fontSize:13, textAlign:"center", marginTop:8 }}>{mpError}</div>
          )}
        </div>
      </div>
    );
  }

  // ── SHARE ─────────────────────────────────────────────────────────────────────
  if (screen === "share") {
    const doneSlots = Object.values(gameSlots || {});
    const drawnParts = doneSlots.map(s => s.part);
    const remainingParts = ["head","body","legs"].filter(p => !drawnParts.includes(p));
    const remaining = remainingParts.length;

    const shareInvite = async () => {
      let url = "";
      try {
        const u = new URL(window.location.href);
        u.searchParams.set("code", gameCode);
        url = u.toString();
      } catch(e) {}
      const partList = doneSlots.map(s => `${s.name} drew the ${s.part}`).join(", ");
      const text = url
        ? `Help finish our Folded Creature! ${partList}. You draw: ${remainingParts.join(" or ")}. Join: ${url}`
        : `Help finish our Folded Creature! Code: ${gameCode}. You draw: ${remainingParts.join(" or ")}`;
      if (navigator.share) {
        try { await navigator.share({ title:"Folded Creature", text }); return; }
        catch(e) { if (e.name === "AbortError") return; }
      }
      try {
        await navigator.clipboard.writeText(text);
        setCopyFeedback("✓ Invite copied!");
        setTimeout(() => setCopyFeedback(""), 3000);
      } catch(e) { window.prompt("Copy this invite:", text); }
    };

    return (
      <div style={page}>
        <Fonts />
        <div style={card}>
          <div style={{ textAlign:"center", marginBottom:16 }}>
            <div style={{ fontSize:48 }}>✓</div>
            <h2 style={{ ...title, marginBottom:6 }}>Your part is saved!</h2>
            <p style={{ ...sub, marginBottom:0 }}>
              {remaining === 0 ? "All parts done — check the reveal!" :
                `${remaining} more player${remaining > 1 ? "s" : ""} still need${remaining === 1 ? "s" : ""} to draw.`}
            </p>
          </div>

          <div style={{ width:"100%", marginBottom:16 }}>
            {["head","body","legs"].map(part => {
              const slot = doneSlots.find(s => s.part === part);
              return (
                <div key={part} style={{ display:"flex", alignItems:"center", gap:10,
                  padding:"10px 0", borderBottom:"1px solid #f5e8e8" }}>
                  <div style={{ width:32, height:32, borderRadius:"50%",
                    background: slot ? "#C0392B" : "#f5e8e8",
                    display:"flex", alignItems:"center", justifyContent:"center",
                    fontFamily:"'Nunito',sans-serif", fontSize:13,
                    color: slot ? "#fff" : "#ddd", fontWeight:700 }}>
                    {slot ? "✓" : "?"}
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontFamily:"'Nunito',sans-serif", fontSize:14, fontWeight:700,
                      color: slot ? "#3d1010" : "#ccc" }}>
                      {slot ? slot.name : "Waiting..."}
                    </div>
                    <div style={{ fontFamily:"'Nunito',sans-serif", fontSize:11, color:"#b07070" }}>
                      draws the {part}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <button onClick={async () => {
            try {
              await navigator.clipboard.writeText(gameCode);
              setCopyFeedback("✓ Code copied!");
              setTimeout(() => setCopyFeedback(""), 1800);
            } catch(e) {}
          }} style={{ background:"#fdf0f0", border:"2px dashed #e8b4b4", borderRadius:16,
            padding:"14px 24px", width:"100%", boxSizing:"border-box", cursor:"pointer", marginBottom:10 }}>
            <div style={{ fontFamily:"'Playfair Display',serif", fontSize:36, fontWeight:900,
              color:"#C0392B", letterSpacing:6 }}>{gameCode}</div>
            <div style={{ fontFamily:"'Nunito',sans-serif", fontSize:12, color:"#b07070", marginTop:2 }}>
              {copyFeedback && copyFeedback.includes("Code") ? copyFeedback : "Tap to copy code"}
            </div>
          </button>

          {remaining > 0 && (
            <button onClick={shareInvite} style={bigBtn("#8e44ad")}>Share Invite Link</button>
          )}
          {copyFeedback && copyFeedback.includes("Invite") && (
            <div style={{ fontFamily:"'Nunito',sans-serif", fontSize:12, color:"#27ae60",
              textAlign:"center", marginTop:8, fontWeight:600 }}>{copyFeedback}</div>
          )}

          {remaining === 0 && (
            <button onClick={async () => {
              try {
                const g = await loadGame(gameCode);
                if (g?.slots) {
                  const byPart = {};
                  Object.values(g.slots).forEach(s => { byPart[s.part] = s; });
                  const ordered = ["head","body","legs"].map(p => byPart[p]?.drawing).filter(Boolean);
                  const names   = ["head","body","legs"].map(p => byPart[p]?.name).filter(Boolean);
                  removeActiveGame(gameCode);
                  setDrawings(ordered); setPlayers(names); setScreen("reveal");
                }
              } catch(e) { setMpError("Couldn't load: " + e.message); }
            }} style={bigBtn("#C0392B")}>
              See the Creature! 🎨
            </button>
          )}

          {mpError && (
            <div style={{ color:"#C0392B", fontFamily:"'Nunito',sans-serif",
              fontSize:13, textAlign:"center", marginTop:8 }}>{mpError}</div>
          )}
          <button onClick={reset} style={{ marginTop:12, background:"none", border:"none",
            fontFamily:"'Nunito',sans-serif", fontSize:13, color:"#b07070",
            cursor:"pointer", textDecoration:"underline" }}>
            Start a new game
          </button>
        </div>
      </div>
    );
  }

  // ── PLAYING (pass-and-play only) ──────────────────────────────────────────────
  if (screen === "playing") {
    const section     = SECTIONS[currentSection];
    const prevDrawing = drawings[currentSection - 1];
    const playerName  = players[currentSection];
    return (
      <div style={page}>
        <Fonts />
        <div style={{ ...card, maxWidth:460 }}>
          <div style={{ display:"flex", gap:6, marginBottom:12, width:"100%" }}>
            {SECTIONS.map((_,i) => (
              <div key={i} style={{ flex:1, height:6, borderRadius:99,
                background: i<=currentSection ? "#C0392B" : "#f5e8e8", transition:"background 0.3s" }} />
            ))}
          </div>
          <div style={{ alignSelf:"flex-start", marginBottom:10 }}>
            <div style={{ fontFamily:"'Playfair Display',serif", fontSize:24, fontWeight:700, color:"#3d1010" }}>
              {playerName}'s turn
            </div>
            <div style={{ fontFamily:"'Nunito',sans-serif", color:"#b07070", fontSize:13 }}>
              Draw the {section.part}
            </div>
          </div>
          <DrawingCanvas
            sectionIndex={currentSection}
            onDone={handleSectionDone}
            peekImageData={prevDrawing?.imageData || null}
            peekHeight={prevDrawing?.croppedHeight || null}
            anchors={null}
          />
        </div>
      </div>
    );
  }

  // ── HANDOFF ───────────────────────────────────────────────────────────────────
  if (screen === "handoff") {
    const next    = players[currentSection + 1];
    const section = SECTIONS[currentSection + 1];
    return (
      <div style={page}>
        <Fonts />
        <div style={card}>
          <div style={{ fontFamily:"'Playfair Display',serif", fontSize:32, fontWeight:900,
            color:"#3d1010", textAlign:"center", marginBottom:8 }}>
            Pass to<br/>{next}!
          </div>
          <p style={{ ...sub, marginBottom:20 }}>
            {next}, it's your turn to draw the <strong>{section.part}</strong>.<br/>
            Don't peek at the rest! 🙈
          </p>
          <div style={{ background:"#fdf0f0", border:"2px solid #f2c4c4", borderRadius:14,
            padding:"12px 20px", marginBottom:24, textAlign:"center",
            fontFamily:"'Nunito',sans-serif", fontSize:13, color:"#b07070" }}>
            You'll see a faint strip at the top of your canvas — connect your drawing from there.
          </div>
          <button onClick={handleHandoffContinue} style={bigBtn("#C0392B")}>
            I'm Ready — Let me Draw!
          </button>
        </div>
      </div>
    );
  }

  // ── REVEAL ────────────────────────────────────────────────────────────────────
  if (screen === "reveal") {
    return (
      <div style={{ ...page, alignItems:"center", padding:"12px" }}>
        <Fonts />
        <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:10, width:"100%", maxWidth:460 }}>
          <div style={{ fontFamily:"'Playfair Display',serif", fontSize:32, fontWeight:900, color:"#3d1010" }}>
            Ta-Daa!
          </div>
          <p style={{ fontFamily:"'Nunito',sans-serif", color:"#b07070", fontSize:13, margin:0, textAlign:"center" }}>
            {players.filter(Boolean).join(", ")} made a creature together
          </p>
          <RevealCanvas sections={drawings} players={players} />
          <button onClick={reset} style={bigBtn("#C0392B")}>Play Again</button>
        </div>
      </div>
    );
  }

  return null;
}

function ModeCard({ icon, label, sub }) {
  return (
    <div style={{ flex:1, background:"#fff", borderRadius:20, padding:"16px 12px", textAlign:"center",
      boxShadow:"0 2px 12px #C0392B11", border:"2px solid #f5e8e8" }}>
      <div style={{ fontSize:28, marginBottom:6 }}>{icon}</div>
      <div style={{ fontFamily:"'Nunito',sans-serif", fontWeight:700, fontSize:13, color:"#3d1010" }}>{label}</div>
      <div style={{ fontFamily:"'Nunito',sans-serif", fontSize:11, color:"#b07070" }}>{sub}</div>
    </div>
  );
}
function BackBtn({ onClick }) {
  return (
    <button onClick={onClick} style={{ alignSelf:"flex-start", background:"#fdf0f0", border:"none",
      borderRadius:50, padding:"6px 14px", fontFamily:"'Nunito',sans-serif", fontSize:13,
      color:"#b07070", cursor:"pointer", marginBottom:8 }}>← Back</button>
  );
}

const page = {
  minHeight:"100vh",
  background:"#fdf5f5",
  display:"flex", alignItems:"flex-start", justifyContent:"center",
  padding:"0 0 40px",
};
const card = {
  background:"#fff", borderRadius:28, padding:"24px 20px",
  display:"flex", flexDirection:"column", alignItems:"center",
  boxShadow:"0 8px 40px #C0392B11", width:"100%", maxWidth:420, margin:"20px 12px 0",
};
const bigBtn = (bg, color="#fff") => ({
  width:"100%", padding:"15px", borderRadius:50, border:"none",
  background:bg, color,
  fontFamily:"'Playfair Display',serif", fontSize:18, fontWeight:700,
  cursor:"pointer", boxShadow: bg==="#ddd" ? "none" : `0 4px 16px ${bg}55`,
  transition:"all 0.2s",
});
const title = {
  fontFamily:"'Playfair Display',serif", fontSize:26, fontWeight:900,
  color:"#3d1010", margin:"4px 0 6px", textAlign:"center",
};
const sub = {
  fontFamily:"'Nunito',sans-serif", color:"#b07070", fontSize:13,
  textAlign:"center", margin:"0 0 16px",
};
const input = {
  width:"100%", padding:"12px 16px", borderRadius:14, boxSizing:"border-box",
  border:"2px solid #f2c4c4", fontFamily:"'Nunito',sans-serif", fontSize:15,
  outline:"none", background:"#fff8f8", color:"#3d1010",
};
