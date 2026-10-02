// Визуальные эффекты: нейро-сфера, «латентный шум» генерации, печатная машинка
(() => {
  const DPR = Math.min(window.devicePixelRatio || 1, 2);

  /* ---- Нейро-сфера из частиц ---- */
  function Sphere(canvas) {
    const ctx = canvas.getContext('2d');
    const N = 520, pts = [];
    const ga = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2, r = Math.sqrt(1 - y * y), th = ga * i;
      pts.push([Math.cos(th) * r, y, Math.sin(th) * r, Math.random()]);
    }
    let w = 0, h = 0, rotY = 0, rotX = -0.35, vx = 0.0035, energy = 0, target = 0, drag = null, raf = 0, t = 0, visible = true;
    const resize = () => { const b = canvas.getBoundingClientRect(); w = b.width; h = b.height; canvas.width = w * DPR; canvas.height = h * DPR; };
    const pal = (k, a) => { // фиолетовый -> синий -> бирюзовый -> розовый
      const c = [[168, 85, 247], [99, 102, 241], [34, 211, 238], [236, 72, 153]];
      const x = (k % 1) * 3, i = Math.floor(x), f = x - i, A = c[i], B = c[i + 1];
      return `rgba(${A[0] + (B[0] - A[0]) * f | 0},${A[1] + (B[1] - A[1]) * f | 0},${A[2] + (B[2] - A[2]) * f | 0},${a})`;
    };
    function frame() {
      raf = 0; if (!visible || !w) return;
      t += 1 / 60; energy += (target - energy) * 0.05;
      if (!drag) rotY += vx * (1 + energy * 4);
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.clearRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.34 * (1 + Math.sin(t * 1.4) * 0.015 + energy * 0.05);
      // свечение ядра
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.6);
      g.addColorStop(0, `rgba(139,92,246,${0.32 + energy * 0.25})`); g.addColorStop(0.45, `rgba(59,130,246,${0.12 + energy * 0.1})`); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      const sy = Math.sin(rotY), cyy = Math.cos(rotY), sx = Math.sin(rotX), cxx = Math.cos(rotX);
      const proj = [];
      for (const [x0, y0, z0, s] of pts) {
        const wob = 1 + (Math.sin(t * 2.2 + y0 * 6 + s * 6) * 0.03) * (0.4 + energy * 2.2);
        let x = x0 * cyy - z0 * sy, z = x0 * sy + z0 * cyy, y = y0;
        const y2 = y * cxx - z * sx, z2 = y * sx + z * cxx;
        const p = 2.6 / (2.6 + z2), px = cx + x * R * wob * p, py = cy + y2 * R * wob * p;
        proj.push([px, py, z2, s, y0]);
      }
      proj.sort((a, b) => b[2] - a[2]);
      ctx.globalCompositeOperation = 'lighter';
      for (const [px, py, z, s, y0] of proj) {
        const depth = (1 - z) / 2; // 0 сзади .. 1 спереди
        const tw = 0.6 + 0.4 * Math.sin(t * 3 + s * 20);
        const a = (0.15 + depth * 0.85) * tw, size = (0.6 + depth * 1.9) * (1 + energy * 0.4);
        ctx.fillStyle = pal((y0 + 1) / 2 * 0.98 + t * 0.02 * (1 + energy), a);
        ctx.beginPath(); ctx.arc(px, py, size, 0, 6.283); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      raf = requestAnimationFrame(frame);
    }
    const start = () => { if (!raf) raf = requestAnimationFrame(frame); };
    new ResizeObserver(() => { resize(); start(); }).observe(canvas);
    new IntersectionObserver(e => { visible = e[0].isIntersecting; if (visible) start(); }).observe(canvas);
    document.addEventListener('visibilitychange', () => { visible = !document.hidden; if (visible) start(); });
    canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, ry: rotY, rx: rotX }; canvas.setPointerCapture(e.pointerId); target = 0.6; });
    canvas.addEventListener('pointermove', e => { if (!drag) return; rotY = drag.ry + (e.clientX - drag.x) * 0.01; rotX = Math.max(-1.2, Math.min(1.2, drag.rx + (e.clientY - drag.y) * 0.01)); });
    const up = () => { drag = null; target = api.active ? 1 : 0; };
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
    const api = { active: false, setActive(v) { api.active = v; target = v ? 1 : 0; start(); }, pulse() { energy = 1.2; start(); } };
    return api;
  }

  /* ---- «Латентный шум» для генерации изображений ---- */
  function latent(canvas) {
    const S = 36, ctx = canvas.getContext('2d'); canvas.width = S; canvas.height = S;
    const img = ctx.createImageData(S, S); let t = Math.random() * 100, raf;
    const seeds = Array.from({ length: 5 }, () => [Math.random() * S, Math.random() * S, Math.random() * 2 + 1, Math.random() * 6]);
    let seen = false, waits = 0;
    function frame() {
      if (!canvas.isConnected) { if (seen || ++waits > 120) return; raf = requestAnimationFrame(frame); return; }
      seen = true; t += 0.025;
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        let v = 0, hue = 0;
        for (const [sx, sy, k, ph] of seeds) {
          const dx = x - sx - Math.sin(t * k + ph) * 6, dy = y - sy - Math.cos(t * k * 0.8 + ph) * 6;
          const f = Math.exp(-(dx * dx + dy * dy) / 120); v += f; hue += f * ph;
        }
        const n = Math.random() * 0.35, i = (y * S + x) * 4, m = Math.min(1, v);
        const h = hue / (v || 1);
        img.data[i] = 25 + m * (110 + 90 * Math.sin(h)) + n * 70;
        img.data[i + 1] = 12 + m * (40 + 70 * Math.sin(h + 2)) + n * 50;
        img.data[i + 2] = 45 + m * (120 + 70 * Math.sin(h + 4)) + n * 80;
        img.data[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0); raf = requestAnimationFrame(frame);
    }
    frame();
  }

  /* ---- Печатная машинка ---- */
  function typer(el, phrases) {
    let i = 0, j = 0, del = false, timer;
    const tick = () => {
      if (!el.isConnected) return;
      const p = phrases[i % phrases.length];
      j += del ? -1 : 1; el.textContent = p.slice(0, j);
      let d = del ? 22 : 48;
      if (!del && j === p.length) { del = true; d = 1700; }
      else if (del && j === 0) { del = false; i++; d = 350; }
      timer = setTimeout(tick, d);
    };
    clearTimeout(el._typer); el._typer = setTimeout(tick, 300);
  }

  window.FX = { Sphere, latent, typer };
})();
