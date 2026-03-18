// web-adapter.js
// Overrides Electron-specific behavior for web deployment
// All file processing remains 100% local in the browser

// ── Override loadFiles for web (no Electron file dialog)
window.loadFiles = function() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.sqx';
  inp.multiple = true;
  inp.onchange = async () => {
    for (const f of inp.files) {
      const buf = await f.arrayBuffer();
      await addStrategy(buf, f.name);
    }
  };
  inp.click();
};

// ── Override PDF export for web
window.exportPDF = function() {
  window.print();
};

// ── Global drag & drop on the whole page
const overlay = document.getElementById('drop-overlay');

document.addEventListener('dragenter', (e) => {
  if ([...e.dataTransfer.types].includes('Files')) {
    overlay.classList.add('active');
  }
});
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget || e.relatedTarget === document.documentElement) {
    overlay.classList.remove('active');
  }
});
document.addEventListener('dragover', (e) => {
  e.preventDefault();
});
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  overlay.classList.remove('active');
  const files = [...e.dataTransfer.files].filter(f => f.name.endsWith('.sqx'));
  if (!files.length) return;
  for (const f of files) {
    const buf = await f.arrayBuffer();
    await addStrategy(buf, f.name);
  }
});

// ── Privacy notice on first load
if (!localStorage.getItem('sqx-privacy-shown')) {
  setTimeout(() => {
    const notice = document.createElement('div');
    notice.style.cssText = `
      position:fixed;bottom:20px;right:20px;max-width:320px;
      background:#111820;border:1px solid rgba(0,217,126,.25);
      border-radius:10px;padding:14px 16px;z-index:998;
      font-family:monospace;font-size:11px;color:#94a3b8;line-height:1.6
    `;
    notice.innerHTML = `
      <div style="color:#00d97e;font-weight:600;margin-bottom:6px">🔒 Privacidad garantizada</div>
      Los archivos .sqx se procesan <strong style="color:#e2e8f0">100% en tu navegador</strong>.
      Ningún dato sale de tu ordenador.<br><br>
      <button onclick="this.parentElement.remove();localStorage.setItem('sqx-privacy-shown','1')"
        style="background:rgba(0,217,126,.15);border:1px solid rgba(0,217,126,.3);
        color:#00d97e;border-radius:4px;padding:4px 12px;cursor:pointer;font-family:monospace;font-size:11px">
        Entendido
      </button>
    `;
    document.body.appendChild(notice);
  }, 800);
}

// ── Update header button text for web
document.getElementById('btn-load').textContent = '+ Cargar .sqx';
