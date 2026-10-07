// Procedurally drawn eye, rendered as a halftone dot screen (the look of the
// theme reference's banner). The iris follows the pointer and the eye blinks
// now and then; both are skipped when the user prefers reduced motion.

const CELL = 6;
const DOT = '#f1faa0';
const PAPER = '#2c422c';

export function mountHalftone(canvas) {
  const ctx = canvas.getContext('2d');
  const src = document.createElement('canvas');
  const sctx = src.getContext('2d', { willReadFrequently: true });
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let cols = 0;
  let rows = 0;
  let dpr = 1;
  const gaze = { x: 0.15, y: 0.05 };
  const target = { x: 0.15, y: 0.05 };
  let lid = 1; // 1 open, 0 closed
  let blinkAt = performance.now() + 2500 + Math.random() * 3000;
  let frame = 0;
  let idleTimer = 0;
  let needsDraw = true;
  const fibres = Array.from({ length: 56 }, (_, i) => ({ a: (i / 56) * Math.PI * 2 + Math.random() * 0.08, l: 0.15 + Math.random() * 0.35, w: 0.6 + Math.random() * 1.2 }));

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    cols = Math.ceil(rect.width / CELL);
    rows = Math.ceil(rect.height / CELL);
    src.width = cols;
    src.height = rows;
    needsDraw = true;
    schedule();
  }

  const shade = (l) => `rgb(${Math.round(l * 255)},${Math.round(l * 255)},${Math.round(l * 255)})`;

  function drawSource() {
    const w = cols;
    const hgt = rows;
    const cx = w * 0.56;
    const cy = hgt * 0.66;
    const ew = Math.min(w * 0.34, hgt * 2.6); // half-width of the eye
    const eh = hgt * 0.5 * lid;               // half-height of the opening
    const ir = hgt * 0.4;                     // iris radius

    // Skin, with a soft lit area around the eye and a shadowed brow.
    const skin = sctx.createRadialGradient(cx, cy, ew * 0.2, cx, cy, w * 0.6);
    skin.addColorStop(0, shade(0.62));
    skin.addColorStop(0.5, shade(0.42));
    skin.addColorStop(1, shade(0.16));
    sctx.fillStyle = skin;
    sctx.fillRect(0, 0, w, hgt);
    const brow = sctx.createLinearGradient(0, 0, 0, hgt * 0.45);
    brow.addColorStop(0, 'rgba(0,0,0,0.75)');
    brow.addColorStop(1, 'rgba(0,0,0,0)');
    sctx.fillStyle = brow;
    sctx.fillRect(0, 0, w, hgt * 0.45);

    // Crease above the lid.
    sctx.strokeStyle = shade(0.2);
    sctx.lineWidth = Math.max(1, hgt * 0.05);
    sctx.beginPath();
    sctx.moveTo(cx - ew * 1.15, cy - hgt * 0.08);
    sctx.quadraticCurveTo(cx, cy - eh * 2.15 - hgt * 0.25, cx + ew * 1.2, cy - hgt * 0.02);
    sctx.stroke();

    const almond = () => {
      sctx.beginPath();
      sctx.moveTo(cx - ew, cy);
      sctx.quadraticCurveTo(cx - ew * 0.1, cy - eh * 2.1, cx + ew, cy - eh * 0.1);
      sctx.quadraticCurveTo(cx + ew * 0.05, cy + eh * 1.9, cx - ew, cy);
      sctx.closePath();
    };

    if (lid > 0.04) {
      sctx.save();
      almond();
      const sclera = sctx.createRadialGradient(cx, cy, ir * 0.5, cx, cy, ew);
      sclera.addColorStop(0, shade(0.97));
      sclera.addColorStop(0.7, shade(0.82));
      sclera.addColorStop(1, shade(0.45));
      sctx.fillStyle = sclera;
      sctx.fill();
      sctx.clip();

      const ix = cx + gaze.x * ew * 0.42;
      const iy = cy - hgt * 0.04 + gaze.y * hgt * 0.16;
      const iris = sctx.createRadialGradient(ix, iy, ir * 0.3, ix, iy, ir);
      iris.addColorStop(0, shade(0.62));
      iris.addColorStop(0.55, shade(0.44));
      iris.addColorStop(0.85, shade(0.3));
      iris.addColorStop(1, shade(0.08));
      sctx.fillStyle = iris;
      sctx.beginPath();
      sctx.arc(ix, iy, ir, 0, Math.PI * 2);
      sctx.fill();

      for (const f of fibres) {
        sctx.strokeStyle = `rgba(255,255,255,${f.l})`;
        sctx.lineWidth = f.w * 0.35;
        sctx.beginPath();
        sctx.moveTo(ix + Math.cos(f.a) * ir * 0.42, iy + Math.sin(f.a) * ir * 0.42);
        sctx.lineTo(ix + Math.cos(f.a) * ir * 0.9, iy + Math.sin(f.a) * ir * 0.9);
        sctx.stroke();
      }

      sctx.fillStyle = shade(0.02);
      sctx.beginPath();
      sctx.arc(ix, iy, ir * 0.36, 0, Math.PI * 2);
      sctx.fill();

      sctx.fillStyle = shade(1);
      sctx.beginPath();
      sctx.arc(ix + ir * 0.28, iy - ir * 0.3, ir * 0.13, 0, Math.PI * 2);
      sctx.fill();

      // Shadow cast by the upper lid.
      const lidShadow = sctx.createLinearGradient(0, cy - eh * 1.1, 0, cy - eh * 0.2);
      lidShadow.addColorStop(0, 'rgba(0,0,0,0.65)');
      lidShadow.addColorStop(1, 'rgba(0,0,0,0)');
      sctx.fillStyle = lidShadow;
      sctx.fillRect(0, 0, w, hgt);
      sctx.restore();
    }

    // Upper lid line and lashes.
    sctx.strokeStyle = shade(0.03);
    sctx.lineWidth = Math.max(1.5, hgt * 0.07);
    sctx.beginPath();
    sctx.moveTo(cx - ew, cy);
    sctx.quadraticCurveTo(cx - ew * 0.1, cy - eh * 2.1, cx + ew, cy - eh * 0.1);
    sctx.stroke();
    sctx.lineWidth = Math.max(1, hgt * 0.035);
    for (let i = 1; i < 14; i++) {
      const t = i / 14;
      const x = (1 - t) * (1 - t) * (cx - ew) + 2 * (1 - t) * t * (cx - ew * 0.1) + t * t * (cx + ew);
      const y = (1 - t) * (1 - t) * cy + 2 * (1 - t) * t * (cy - eh * 2.1) + t * t * (cy - eh * 0.1);
      sctx.beginPath();
      sctx.moveTo(x, y);
      sctx.lineTo(x + (t - 0.35) * hgt * 0.35, y - hgt * 0.14);
      sctx.stroke();
    }
  }

  function draw() {
    if (cols < 1 || rows < 1) return; // not laid out yet (or hidden)
    drawSource();
    const data = sctx.getImageData(0, 0, cols, rows).data;
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = DOT;
    const cell = CELL * dpr;
    const max = cell * 0.74;
    ctx.beginPath();
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const lum = data[(y * cols + x) * 4] / 255;
        if (lum < 0.06) continue;
        const r = Math.sqrt(lum) * max;
        const px = (x + 0.5) * cell;
        const py = (y + 0.5) * cell;
        ctx.moveTo(px + r, py);
        ctx.arc(px, py, r, 0, Math.PI * 2);
      }
    }
    ctx.fill();
  }

  function tick(now) {
    frame = 0;
    if (!reduced) {
      const dx = target.x - gaze.x;
      const dy = target.y - gaze.y;
      if (Math.abs(dx) > 0.002 || Math.abs(dy) > 0.002) {
        gaze.x += dx * 0.12;
        gaze.y += dy * 0.12;
        needsDraw = true;
      }
      if (now >= blinkAt) {
        const t = (now - blinkAt) / 260; // 0..1 over the blink
        lid = t >= 1 ? 1 : Math.abs(1 - 2 * t);
        needsDraw = true;
        if (t >= 1) blinkAt = now + 3500 + Math.random() * 5000;
      }
    }
    if (needsDraw) {
      needsDraw = false;
      draw();
    }
    if (!reduced && (Math.abs(target.x - gaze.x) > 0.002 || Math.abs(target.y - gaze.y) > 0.002 || now >= blinkAt - 16 || lid < 1)) schedule();
    else if (!reduced) idleTimer = setTimeout(schedule, Math.max(0, blinkAt - performance.now()));
  }

  function schedule() {
    clearTimeout(idleTimer);
    if (!frame) frame = requestAnimationFrame(tick);
  }

  const onPointer = (e) => {
    const rect = canvas.getBoundingClientRect();
    const ex = rect.left + rect.width * 0.56;
    const ey = rect.top + rect.height * 0.66;
    target.x = Math.max(-1, Math.min(1, (e.clientX - ex) / (window.innerWidth * 0.45)));
    target.y = Math.max(-1, Math.min(1, (e.clientY - ey) / (window.innerHeight * 0.45)));
    schedule();
  };

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  if (!reduced) window.addEventListener('pointermove', onPointer, { passive: true });
  resize();

  return () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
    clearTimeout(idleTimer);
    window.removeEventListener('pointermove', onPointer);
  };
}
