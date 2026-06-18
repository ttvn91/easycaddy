import { $ } from "bun";
import { readdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const CADDY_DIR = process.env.CADDY_DIR || "/etc/caddy";
const PORT = parseInt(process.env.PORT || "", 10) || 8091;
const HERE = dirname(fileURLToPath(import.meta.url));
const FAVICON = await Bun.file(join(HERE, "favicon.png")).bytes().catch(() => null);
const HOSTS_JS = await Bun.file(join(HERE, "hosts.js")).text().catch(() => "");
const VERSION = "1.0.0";
const REPO = "ttvn91/easycaddy";
const GH_HEADERS = { "user-agent": "easycaddy", accept: "application/vnd.github+json" };
const USER = process.env.USER_NAME;
const PASS = process.env.PASS;
if (!USER || !PASS) {
    console.error(
        "easycaddy: refusing to start — set the USER_NAME and PASS environment variables.\n" +
        "  e.g.  USER_NAME=admin PASS='your-strong-secret' bun run server.ts\n" +
        "  (the installer writes these into the systemd unit automatically)",
    );
    process.exit(1);
}
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const sessions = new Map<string, { user: string; expires: number }>();

const json = (d: any, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(d), {
        status,
        headers: { "content-type": "application/json", ...headers },
    });

function isHttps(req: Request): boolean {
    const proto = req.headers.get("x-forwarded-proto");
    if (proto) return proto.split(",")[0].trim() === "https";
    return new URL(req.url).protocol === "https:";
}

function sessionCookie(sid: string, https: boolean): string {
    const secure = https ? "; Secure" : "";
    return `sid=${sid}; HttpOnly${secure}; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
}

function clearCookie(https: boolean): string {
    const secure = https ? "; Secure" : "";
    return `sid=; HttpOnly${secure}; SameSite=Strict; Path=/; Max-Age=0`;
}

function getSession(req: Request): { sid: string; user: string } | null {
    const cookie = req.headers.get("cookie") || "";
    const m = cookie.match(/sid=([^;]+)/);
    if (!m) return null;
    const sid = m[1];
    const sess = sessions.get(sid);
    if (!sess || sess.expires < Date.now()) {
        sessions.delete(sid);
        return null;
    }
    return { sid, user: sess.user };
}

const NAME_RE = /^[a-zA-Z0-9_-]+$/;

// Compare dotted versions: returns >0 if a newer than b, <0 if older, 0 if equal.
function cmpVer(a: string, b: string): number {
    const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
    const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return d > 0 ? 1 : -1;
    }
    return 0;
}

async function latestRelease(): Promise<{ tag: string; url: string; notes: string } | null> {
    try {
        const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: GH_HEADERS });
        if (!r.ok) return null;
        const rel: any = await r.json();
        if (!rel.tag_name) return null;
        return { tag: String(rel.tag_name), url: String(rel.html_url || ""), notes: String(rel.body || "") };
    } catch {
        return null;
    }
}

function listFiles(): string[] {
    const files = ["Caddyfile"];
    for (const dir of ["snippets", "sites"]) {
        try {
            for (const e of readdirSync(join(CADDY_DIR, dir)).sort()) {
                if (!e.endsWith(".caddy")) continue;
                const stem = e.slice(0, -".caddy".length);
                if (!NAME_RE.test(stem)) continue;
                files.push(`${dir}/${e}`);
            }
        } catch {}
    }
    return files;
}

function safePath(rel: string): string | null {
    if (!rel || rel.includes("..") || rel.startsWith("/")) return null;
    if (rel === "Caddyfile") return join(CADDY_DIR, rel);
    const parts = rel.split("/");
    if (parts.length !== 2) return null;
    const [dir, file] = parts;
    if (dir !== "snippets" && dir !== "sites") return null;
    if (!file.endsWith(".caddy")) return null;
    const stem = file.slice(0, -".caddy".length);
    if (!NAME_RE.test(stem)) return null;
    return join(CADDY_DIR, rel);
}

const HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><title>easycaddy</title>
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/favicon.png">
<style>
  *{box-sizing:border-box}
  body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;background:#1e1e1e;color:#d4d4d4;height:100vh;overflow:hidden}
  #login{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#1e1e1e}
  #login-box{background:#252526;padding:32px;border-radius:8px;width:320px;box-shadow:0 4px 16px rgba(0,0,0,.5)}
  #login h2{margin:0 0 20px;font-size:18px}
  #login label{display:block;font-size:12px;color:#888;margin-bottom:4px;margin-top:12px}
  #login input{width:100%;padding:8px 10px;background:#3c3c3c;color:#d4d4d4;border:1px solid #555;border-radius:3px;font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
  #login input:focus{outline:none;border-color:#0e639c}
  #login button{width:100%;margin-top:16px;background:#0e639c;color:#fff;border:0;padding:9px;font-size:13px;border-radius:3px;cursor:pointer;font-family:inherit}
  #login button:hover{background:#1177bb}
  #login-error{color:#f48771;font-size:12px;margin-top:8px;min-height:14px}
  #app{display:none;height:100vh}
  #app.show{display:flex;flex-direction:column}
  #sidebar{width:260px;background:#252526;padding:12px;overflow-y:auto;border-right:1px solid #333}
  .sidebar-h{margin:0 0 8px;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.5px}
  .group{margin-top:12px}
  .group-header{display:flex;align-items:center;gap:6px;font-size:12px;color:#888;padding:4px 0 4px 6px;text-transform:lowercase}
  .group-header-name{flex:1;font-weight:600}
  .icon-btn{background:transparent;color:#888;border:0;padding:2px 6px;font-size:14px;line-height:1;cursor:pointer;border-radius:3px;font-family:inherit}
  .icon-btn:hover{background:#3c3c3c;color:#d4d4d4}
  .icon-btn.danger:hover{background:#a1260d;color:#fff}
  .file{display:flex;align-items:center;padding:5px 8px;cursor:pointer;border-radius:3px;font-size:13px;margin-left:8px;gap:4px}
  .file:hover{background:#2a2d2e}
  .file:hover .file-actions{visibility:visible}
  .file-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .file-actions{visibility:hidden;display:flex}
  .file.active{background:#094771;color:#fff}
  .file.active .file-actions{visibility:visible}
  .file.dirty .file-name::after{content:" ●";color:#f0c674}
  .file.root{margin-left:0;background:transparent;border:1px solid transparent}
  .file.root.active{background:#094771}
  #main{flex:1;display:flex;flex-direction:column;min-width:0}
  #toolbar{padding:8px 12px;background:#2d2d30;border-bottom:1px solid #333;display:flex;align-items:center;gap:8px}
  #current{flex:1;font-size:13px;color:#9cdcfe}
  #user-badge{font-size:11px;color:#888;padding:0 8px}
  button{background:#0e639c;color:#fff;border:0;padding:6px 14px;font-size:13px;border-radius:3px;cursor:pointer;font-family:inherit}
  button:hover{background:#1177bb}
  button.danger{background:#a1260d}
  button.danger:hover{background:#c42b1c}
  button.ghost{background:transparent;color:#888}
  button.ghost:hover{background:#3c3c3c;color:#d4d4d4}
  button:disabled{opacity:.5;cursor:not-allowed}
  textarea{flex:1;background:#1e1e1e;color:#d4d4d4;border:0;padding:12px;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;resize:none;outline:none;tab-size:2}
  #status{padding:8px 12px;background:#007acc;color:#fff;font-size:12px;min-height:28px;white-space:pre-wrap}
  #status.error{background:#a1260d}
  #status.warn{background:#cc6633}

  #modal-wrap{position:fixed;inset:0;z-index:100;pointer-events:none}
  .modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;pointer-events:auto}
  .modal{background:#252526;padding:24px;border-radius:6px;min-width:360px;max-width:90vw;box-shadow:0 4px 24px rgba(0,0,0,.6)}
  .modal h3{margin:0 0 16px;font-size:14px;font-weight:600}
  .modal p{margin:0 0 16px;font-size:13px;line-height:1.5;word-break:break-all}
  .modal input{width:100%;padding:8px 10px;background:#3c3c3c;color:#d4d4d4;border:1px solid #555;border-radius:3px;font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
  .modal input:focus{outline:none;border-color:#0e639c}
  .modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
  #version-badge{font-size:11px;color:#888;padding:0 8px;cursor:help}
  #version-badge:hover{color:#d4d4d4}
  #bottom-panel{background:#1a1a1a;border-top:1px solid #333;display:flex;flex-direction:column}
  #bottom-tabs{display:flex;background:#252526;border-bottom:1px solid #333}
  .bp-tab{background:transparent;color:#888;border:0;padding:8px 16px;cursor:pointer;font-size:12px;font-family:inherit;border-top:2px solid transparent;border-radius:0}
  .bp-tab:hover{color:#d4d4d4;background:#2a2d2e}
  .bp-tab.active{color:#fff;border-top-color:#0e639c;background:#1e1e1e}
  #bp-close{margin-left:auto;padding:8px 14px}
  #bp-content{padding:12px;max-height:240px;overflow:auto;font-size:12px;display:none}
  #bp-content.show{display:block}
  #bp-content table{width:100%;border-collapse:collapse;font-family:inherit}
  #bp-content th,#bp-content td{text-align:left;padding:4px 10px}
  #bp-content th{color:#888;font-weight:normal;border-bottom:1px solid #333;text-transform:uppercase;font-size:10px}
  #bp-content tr:hover td{background:#2a2d2e}
  .cert-warn{color:#f0c674}
  .cert-danger{color:#f48771}
  .cert-ok{color:#4ec9b0}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
  .dot.up{background:#4ec9b0}
  .dot.down{background:#f48771}
  .dot.unknown{background:#888}
  #log-pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-all;line-height:1.5;color:#ccc;margin:0}

  /* === Top nav + Hosts view (form layer) === */
  #topbar{display:flex;align-items:center;gap:4px;padding:6px 12px;background:#333;border-bottom:1px solid #222}
  #brand{font-weight:600;color:#9cdcfe;margin-right:14px;font-size:14px}
  .nav-tab{background:transparent;color:#9aa0a6;border:0;padding:6px 16px;font-size:13px;border-radius:4px;cursor:pointer;font-family:inherit}
  .nav-tab:hover{background:#3c3c3c;color:#fff}
  .nav-tab.active{background:#0e639c;color:#fff}
  #update-btn{background:#2d6a2d;color:#fff}
  #update-btn:hover{background:#388038}
  #workspace{flex:1;display:flex;min-height:0}
  #hosts-view{flex:1;overflow:auto;padding:18px 22px;min-width:0;display:none}
  #app.mode-hosts #hosts-view{display:block}
  #app.mode-hosts #sidebar,#app.mode-hosts #main{display:none}
  #app.mode-files #hosts-view{display:none}
  .hosts-head{display:flex;align-items:center;gap:10px;margin-bottom:18px}
  .hosts-head h2{margin:0;font-size:16px;font-weight:600}
  #hosts-status{font-size:12px;color:#9cdcfe}
  .host-group{margin-bottom:22px}
  .host-group-title{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.5px;margin:0 0 10px}
  .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
  .card{background:#252526;border:1px solid #333;border-radius:8px;padding:14px 16px;display:flex;flex-direction:column;gap:6px}
  .card:hover{border-color:#0e639c}
  .card .domain{font-size:14px;color:#9cdcfe;font-weight:600;word-break:break-all}
  .card .target{font-size:12px;color:#bbb;word-break:break-all}
  .card .badges{display:flex;flex-wrap:wrap;gap:5px;margin-top:2px}
  .badge{font-size:10px;padding:2px 8px;border-radius:10px;background:#3c3c3c;color:#bbb}
  .badge.tls{background:#16432f;color:#4ec9b0}
  .badge.auth{background:#4a3a12;color:#f0c674}
  .badge.locked{background:#3a2a2a;color:#f48771}
  .card .card-actions{display:flex;gap:6px;margin-top:8px}
  .card .card-actions button{padding:4px 10px;font-size:12px}
  .empty{color:#888;font-size:13px;padding:24px;text-align:center;border:1px dashed #333;border-radius:8px}
  .hf-row{margin-bottom:14px}
  .hf-row label{display:block;font-size:11px;color:#888;margin-bottom:5px;text-transform:uppercase;letter-spacing:.4px}
  .hf-row input[type=text],.hf-row input[type=password],.hf-row textarea,.hf-row select,.hf-cols input{width:100%;padding:8px 10px;background:#3c3c3c;color:#d4d4d4;border:1px solid #555;border-radius:4px;font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
  .hf-row textarea{resize:vertical;min-height:90px;tab-size:2}
  .hf-row input:focus,.hf-row textarea:focus,.hf-row select:focus,.hf-cols input:focus{outline:none;border-color:#0e639c}
  .hf-check{display:flex;align-items:center;gap:8px;font-size:13px;color:#d4d4d4;margin-bottom:8px}
  .hf-check input{width:auto}
  .hf-hint{font-size:11px;color:#777;margin-top:4px}
  .hf-tabs{display:flex;gap:4px;margin-bottom:16px;border-bottom:1px solid #333}
  .hf-tab{background:transparent;color:#888;border:0;border-bottom:2px solid transparent;padding:7px 14px;font-size:12px;cursor:pointer;font-family:inherit;border-radius:0}
  .hf-tab.active{color:#fff;border-bottom-color:#0e639c}
  .hf-pane{display:none}
  .hf-pane.active{display:block}
  .modal.wide{min-width:520px;max-width:620px;max-height:86vh;overflow:auto}
  .hf-cols{display:flex;gap:10px;align-items:flex-end}
  .hf-cols>*{flex:1;margin-bottom:0}
</style></head>
<body>

<div id="login">
  <div id="login-box">
    <h2>easycaddy</h2>
    <form id="login-form">
      <label>User</label>
      <input id="username" autocomplete="username" autofocus>
      <label>Password</label>
      <input type="password" id="password" autocomplete="current-password">
      <button type="submit">Sign in</button>
      <div id="login-error"></div>
    </form>
  </div>
</div>

<div id="app">
  <div id="topbar">
    <span id="brand">easycaddy</span>
    <button class="nav-tab" data-view="hosts">Hosts</button>
    <button class="nav-tab" data-view="files">Files</button>
    <span style="flex:1"></span>
    <span id="user-badge"></span>
    <span id="version-badge" title="Caddy version">…</span>
    <button id="update-btn" class="ghost" style="display:none"></button>
    <button id="logout" class="ghost">Logout</button>
  </div>
  <div id="workspace">
  <div id="hosts-view"></div>
  <div id="sidebar">
    <h4 class="sidebar-h">/etc/caddy</h4>
    <div id="tree">…</div>
  </div>
  <div id="main">
    <div id="toolbar">
      <span id="current">— select file —</span>
      <button id="save" disabled>Save (Ctrl+S)</button>
      <button id="validate">Validate</button>
      <button id="reload" class="danger">Reload Caddy</button>
    </div>
    <textarea id="content" placeholder="Pick a file from sidebar" disabled spellcheck="false"></textarea>
    <div id="bottom-panel">
      <div id="bottom-tabs">
        <button class="bp-tab" data-tab="certs">Certs</button>
        <button class="bp-tab" data-tab="upstreams">Upstreams</button>
        <button class="bp-tab" data-tab="logs">Logs</button>
        <button class="bp-tab" id="bp-close">×</button>
      </div>
      <div id="bp-content"></div>
    </div>
    <div id="status">Ready</div>
  </div>
  </div>
</div>

<div id="modal-wrap"></div>

<script src="/hosts.js"></script>
<script>
let current = null, dirty = false;
const $$ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const modal = {
    _show(html, setupFn) {
        return new Promise((resolve) => {
            const wrap = $$("#modal-wrap");
            wrap.innerHTML = '<div class="modal-bg"><div class="modal">' + html + '</div></div>';
            const close = (v) => { wrap.innerHTML = ''; document.removeEventListener('keydown', onKey); resolve(v); };
            const onKey = (e) => {
                if (e.key === 'Escape') close(modal._cancelValue);
                if (e.key === 'Enter' && wrap.querySelector('[data-ok]') && document.activeElement?.tagName !== 'TEXTAREA') {
                    e.preventDefault();
                    wrap.querySelector('[data-ok]').click();
                }
            };
            document.addEventListener('keydown', onKey);
            setupFn(close, wrap);
        });
    },
    prompt(title, defaultValue = '') {
        const safeDef = defaultValue.replace(/"/g, '&quot;');
        this._cancelValue = null;
        return this._show(
            '<h3>' + title + '</h3><input id="m-input" value="' + safeDef + '"><div class="modal-actions"><button class="ghost" data-cancel>Cancel</button><button data-ok>OK</button></div>',
            (close, wrap) => {
                const inp = wrap.querySelector('#m-input');
                inp.focus(); inp.select();
                wrap.querySelector('[data-cancel]').onclick = () => close(null);
                wrap.querySelector('[data-ok]').onclick = () => close(inp.value);
            }
        );
    },
    confirm(msg, okLabel = 'OK', okClass = '') {
        this._cancelValue = false;
        return this._show(
            '<p>' + msg + '</p><div class="modal-actions"><button class="ghost" data-cancel>Cancel</button><button class="' + okClass + '" data-ok>' + okLabel + '</button></div>',
            (close, wrap) => {
                wrap.querySelector('[data-cancel]').onclick = () => close(false);
                wrap.querySelector('[data-ok]').onclick = () => close(true);
                wrap.querySelector('[data-ok]').focus();
            }
        );
    }
};


async function api(path, opts = {}) {
    const r = await fetch(path, { credentials: "same-origin", ...opts });
    if (r.status === 401) { showLogin(); return null; }
    return r.json();
}

function showLogin() {
    $$("#login").style.display = "flex";
    $$("#app").classList.remove("show");
    setTimeout(() => $$("#username").focus(), 50);
}

function showApp(user) {
    $$("#login").style.display = "none";
    $$("#app").classList.add("show");
    $$("#user-badge").textContent = user;
    setView("hosts");
    loadVersion();
    if (typeof checkUpdate === "function") checkUpdate();
}

function setStatus(msg, level = "info") {
    const el = $$("#status");
    el.textContent = msg;
    el.className = level === "error" ? "error" : level === "warn" ? "warn" : "";
    const hs = $$("#hosts-status");
    if (hs) hs.textContent = msg;
}

function setDirty(d) {
    dirty = d;
    $$("#save").disabled = !d;
    document.querySelectorAll(".file").forEach((el) => {
        if (el.dataset.path === current) el.classList.toggle("dirty", d);
    });
}

function renderTree(files) {
    const groups = { snippets: [], sites: [] };
    let caddyfile = null;
    for (const f of files) {
        if (f === "Caddyfile") caddyfile = f;
        else if (f.startsWith("snippets/")) groups.snippets.push(f);
        else if (f.startsWith("sites/")) groups.sites.push(f);
    }
    let html = '';
    if (caddyfile) {
        html += '<div class="file root" data-path="Caddyfile"><span class="file-name">Caddyfile</span></div>';
    }
    for (const [dir, items] of Object.entries(groups)) {
        html += '<div class="group">';
        html += '<div class="group-header"><span class="group-header-name">' + esc(dir) + '/</span><button class="icon-btn" data-add="' + esc(dir) + '" title="New file">+</button></div>';
        for (const f of items) {
            const name = f.split('/')[1];
            html += '<div class="file" data-path="' + esc(f) + '"><span class="file-name">' + esc(name) + '</span><span class="file-actions"><button class="icon-btn" data-ren="' + esc(f) + '" title="Rename">✎</button><button class="icon-btn danger" data-del="' + esc(f) + '" title="Delete">×</button></span></div>';
        }
        html += '</div>';
    }
    $$("#tree").innerHTML = html;
    document.querySelectorAll(".file").forEach((el) => {
        el.onclick = (e) => {
            if (e.target.dataset.del || e.target.dataset.ren) return;
            openFile(el.dataset.path);
        };
    });
    document.querySelectorAll("[data-add]").forEach((el) => {
        el.onclick = (e) => { e.stopPropagation(); createFile(el.dataset.add); };
    });
    document.querySelectorAll("[data-del]").forEach((el) => {
        el.onclick = (e) => { e.stopPropagation(); deleteFile(el.dataset.del); };
    });
    document.querySelectorAll("[data-ren]").forEach((el) => {
        el.onclick = (e) => { e.stopPropagation(); renameFile(el.dataset.ren); };
    });
}

async function loadFiles() {
    const r = await api("/api/files");
    if (!r) return;
    renderTree(r.files);
    if (current) {
        document.querySelectorAll(".file").forEach((el) => el.classList.toggle("active", el.dataset.path === current));
    }
}

async function openFile(path) {
    if (dirty && !(await modal.confirm("Unsaved changes — discard?", "Discard", "danger"))) return;
    current = path;
    document.querySelectorAll(".file").forEach((el) => el.classList.toggle("active", el.dataset.path === path));
    const r = await api("/api/file?path=" + encodeURIComponent(path));
    if (!r) return;
    if (r.error) return setStatus(r.error, "error");
    $$("#content").value = r.content;
    $$("#content").disabled = false;
    $$("#current").textContent = path;
    setStatus("Loaded " + path);
    setDirty(false);
}

async function createFile(dir) {
    const name = await modal.prompt('New file in ' + dir + '/ (without .caddy ext)');
    if (!name) return;
    const r = await api("/api/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dir, name }),
    });
    if (!r) return;
    if (r.ok) {
        await loadFiles();
        await openFile(dir + '/' + name + '.caddy');
        setStatus("Created " + dir + '/' + name + '.caddy');
    } else setStatus(r.error || "Create failed", "error");
}

async function deleteFile(path) {
    if (!(await modal.confirm('Delete <b>' + esc(path) + '</b> permanently?', 'Delete', 'danger'))) return;
    const r = await api("/api/file?path=" + encodeURIComponent(path), { method: "DELETE" });
    if (!r) return;
    if (r.ok) {
        if (current === path) {
            current = null;
            $$("#content").value = "";
            $$("#content").disabled = true;
            $$("#current").textContent = "— select file —";
            setDirty(false);
        }
        await loadFiles();
        setStatus("Deleted " + path);
    } else setStatus(r.error || "Delete failed", "error");
}

async function renameFile(oldPath) {
    const oldName = oldPath.split('/')[1].replace(/\.caddy$/, '');
    const newName = await modal.prompt('Rename ' + esc(oldPath) + ' to:', oldName);
    if (!newName || newName === oldName) return;
    const r = await api("/api/rename", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ oldPath, newName }),
    });
    if (!r) return;
    if (r.ok) {
        if (current === oldPath) current = r.path;
        await loadFiles();
        if (current === r.path) {
            $$("#current").textContent = current;
            document.querySelectorAll(".file").forEach((el) => el.classList.toggle("active", el.dataset.path === current));
        }
        setStatus("Renamed to " + r.path);
    } else setStatus(r.error || "Rename failed", "error");
}

$$("#login-form").onsubmit = async (e) => {
    e.preventDefault();
    $$("#login-error").textContent = "";
    const r = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ user: $$("#username").value, password: $$("#password").value }),
    });
    const data = await r.json();
    if (data.ok) { $$("#password").value = ""; showApp(data.user); }
    else $$("#login-error").textContent = data.error || "Login failed";
};

$$("#content").addEventListener("input", () => setDirty(true));

$$("#save").onclick = async () => {
    if (!current) return;
    const r = await api("/api/file", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: current, content: $$("#content").value }),
    });
    if (!r) return;
    if (r.ok) {
        if (r.content !== undefined && r.content !== $$("#content").value) {
            $$("#content").value = r.content;
            setStatus("Saved + formatted " + current);
        } else {
            setStatus("Saved " + current);
        }
        setDirty(false);
    } else setStatus(r.error || "Save failed", "error");
};

$$("#validate").onclick = async () => {
    setStatus("Validating…");
    const r = await api("/api/validate", { method: "POST" });
    if (!r) return;
    setStatus(r.output || (r.ok ? "Valid configuration" : "Invalid"), r.ok ? "info" : "error");
};

$$("#reload").onclick = async () => {
    if (!(await modal.confirm("Reload Caddy service? Existing connections may be affected briefly.", "Reload", "danger"))) return;
    setStatus("Reloading…");
    const r = await api("/api/reload", { method: "POST" });
    if (!r) return;
    setStatus(r.output || (r.ok ? "Caddy reloaded" : "Reload failed"), r.ok ? "info" : "error");
};

$$("#logout").onclick = async () => {
    await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
    showLogin();
};

document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (!$$("#save").disabled) $$("#save").click();
    }
});


// === Bottom panel: Certs / Upstreams / Logs ===
let activeTab = null;
let logRefreshTimer = null;

function fmtCert(c) {
    const cls = c.daysLeft < 14 ? "cert-danger" : c.daysLeft < 30 ? "cert-warn" : "cert-ok";
    return '<tr><td>' + esc(c.domain) + '</td><td class="' + cls + '">' + (c.daysLeft | 0) + 'd</td><td style="color:#888">' + esc(new Date(c.expires).toLocaleDateString()) + '</td></tr>';
}

function fmtUpstream(u) {
    const dotCls = (u.num_requests > 0 || u.fails === 0) ? "up" : "down";
    return '<tr><td><span class="dot ' + dotCls + '"></span>' + esc(u.address) + '</td><td style="color:#888">req: ' + (u.num_requests | 0) + '</td><td class="' + (u.fails > 0 ? "cert-danger" : "") + '">fails: ' + (u.fails | 0) + '</td></tr>';
}

async function renderTab(tab) {
    const content = $$("#bp-content");
    if (tab === "certs") {
        const r = await api("/api/certs");
        if (!r) return;
        if (!r.certs.length) { content.innerHTML = '<p style="color:#888">No certs found</p>'; return; }
        content.innerHTML = '<table><thead><tr><th>Domain</th><th>Days left</th><th>Expires</th></tr></thead><tbody>' + r.certs.map(fmtCert).join("") + '</tbody></table>';
    } else if (tab === "upstreams") {
        const r = await api("/api/upstreams");
        if (!r) return;
        const ups = Array.isArray(r.upstreams) ? r.upstreams : [];
        if (!ups.length) { content.innerHTML = '<p style="color:#888">No upstreams (Caddy admin API)</p>'; return; }
        content.innerHTML = '<table><thead><tr><th>Upstream</th><th>Requests</th><th>Fails</th></tr></thead><tbody>' + ups.map(fmtUpstream).join("") + '</tbody></table>';
    } else if (tab === "logs") {
        const r = await api("/api/log?lines=100");
        if (!r) return;
        content.innerHTML = '<pre id="log-pre">' + (r.log || "(empty)").replace(/</g, "&lt;") + '</pre>';
        const pre = content.querySelector("#log-pre");
        if (pre) pre.scrollTop = pre.scrollHeight;
        content.scrollTop = content.scrollHeight;
    }
}

function setActiveTab(tab) {
    activeTab = tab;
    document.querySelectorAll(".bp-tab").forEach((el) => el.classList.toggle("active", el.dataset.tab === tab));
    const content = $$("#bp-content");
    if (logRefreshTimer) { clearInterval(logRefreshTimer); logRefreshTimer = null; }
    if (!tab) {
        content.classList.remove("show");
        return;
    }
    content.classList.add("show");
    renderTab(tab);
    if (tab === "logs") {
        logRefreshTimer = setInterval(() => renderTab("logs"), 5000);
    }
}

document.querySelectorAll(".bp-tab").forEach((el) => {
    if (el.id === "bp-close") {
        el.onclick = () => setActiveTab(null);
    } else {
        el.onclick = () => setActiveTab(activeTab === el.dataset.tab ? null : el.dataset.tab);
    }
});

async function loadVersion() {
    const r = await api("/api/info");
    if (r && r.version) $$("#version-badge").textContent = r.version;
}

(async () => {
    const r = await fetch("/api/whoami", { credentials: "same-origin" });
    if (r.ok) { const data = await r.json(); showApp(data.user); }
    else showLogin();
})();
</script>
</body></html>`;

Bun.serve({
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === "/") {
            return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
        }

        if (url.pathname === "/hosts.js") {
            return new Response(HOSTS_JS, {
                headers: { "content-type": "text/javascript; charset=utf-8" },
            });
        }

        if (url.pathname === "/favicon.png" || url.pathname === "/favicon.ico") {
            if (!FAVICON) return new Response("Not found", { status: 404 });
            return new Response(FAVICON, {
                headers: {
                    "content-type": "image/png",
                    "cache-control": "public, max-age=86400",
                },
            });
        }

        if (url.pathname === "/api/login" && req.method === "POST") {
            let body: { user?: string; password?: string };
            try {
                body = await req.json();
            } catch {
                return json({ ok: false, error: "Invalid request" }, 400);
            }
            const { user, password } = body;
            if (user !== USER || password !== PASS) {
                await new Promise((r) => setTimeout(r, 500));
                return json({ ok: false, error: "Invalid credentials" }, 401);
            }
            const sid = randomUUID();
            sessions.set(sid, { user, expires: Date.now() + SESSION_TTL_MS });
            return json({ ok: true, user }, 200, { "set-cookie": sessionCookie(sid, isHttps(req)) });
        }

        const sess = getSession(req);

        if (url.pathname === "/api/whoami") {
            return sess ? json({ user: sess.user }) : json({ error: "unauthorized" }, 401);
        }

        if (url.pathname === "/api/logout" && req.method === "POST") {
            if (sess) sessions.delete(sess.sid);
            return json({ ok: true }, 200, { "set-cookie": clearCookie(isHttps(req)) });
        }

        if (!sess) return json({ error: "unauthorized" }, 401);

        if (url.pathname === "/api/files") return json({ files: listFiles() });

        if (url.pathname === "/api/sites") {
            const out: { path: string; content: string }[] = [];
            try {
                for (const e of readdirSync(join(CADDY_DIR, "sites")).sort()) {
                    if (!e.endsWith(".caddy")) continue;
                    const stem = e.slice(0, -".caddy".length);
                    if (!NAME_RE.test(stem)) continue;
                    const rel = `sites/${e}`;
                    try {
                        out.push({ path: rel, content: await Bun.file(join(CADDY_DIR, rel)).text() });
                    } catch {}
                }
            } catch {}
            return json({ sites: out });
        }

        if (url.pathname === "/api/snippets") {
            const names: string[] = [];
            try {
                for (const e of readdirSync(join(CADDY_DIR, "snippets")).sort()) {
                    if (!e.endsWith(".caddy")) continue;
                    const stem = e.slice(0, -".caddy".length);
                    if (!NAME_RE.test(stem)) continue;
                    const content = await Bun.file(join(CADDY_DIR, "snippets", e)).text().catch(() => "");
                    // Snippet definitions look like `(name) {` at the start of a line.
                    for (const m of content.matchAll(/^\s*\(([^)]+)\)\s*\{/gm)) {
                        names.push(m[1].trim());
                    }
                }
            } catch {}
            return json({ snippets: [...new Set(names)] });
        }

        if (url.pathname === "/api/hash" && req.method === "POST") {
            let body: { password?: string };
            try {
                body = await req.json();
            } catch {
                return json({ error: "invalid request" }, 400);
            }
            if (!body.password || typeof body.password !== "string") {
                return json({ error: "no password" }, 400);
            }
            const proc = await $`caddy hash-password --plaintext ${body.password}`.nothrow().quiet();
            const hash = proc.stdout.toString().trim();
            if (proc.exitCode !== 0 || !hash) return json({ error: "hashing failed" }, 500);
            return json({ ok: true, hash });
        }

        if (url.pathname === "/api/file" && req.method === "GET") {
            const p = safePath(url.searchParams.get("path") || "");
            if (!p) return json({ error: "invalid path" }, 400);
            try {
                const content = await Bun.file(p).text();
                return json({ content });
            } catch (e) {
                return json({ error: String(e) }, 500);
            }
        }

        if (url.pathname === "/api/file" && req.method === "POST") {
            const { path, content } = await req.json();
            const p = safePath(path);
            if (!p) return json({ error: "invalid path" }, 400);
            await Bun.write(p, content);
            // Auto-format with caddy fmt; ignore errors so save never blocks.
            await $`caddy fmt --overwrite ${p}`.nothrow().quiet();
            const formatted = await Bun.file(p).text();
            return json({ ok: true, content: formatted });
        }

        if (url.pathname === "/api/file" && req.method === "DELETE") {
            const rel = url.searchParams.get("path") || "";
            if (rel === "Caddyfile") return json({ error: "Cannot delete Caddyfile" }, 400);
            const p = safePath(rel);
            if (!p) return json({ error: "invalid path" }, 400);
            try {
                unlinkSync(p);
                return json({ ok: true });
            } catch (e) {
                return json({ error: String(e) }, 500);
            }
        }

        if (url.pathname === "/api/create" && req.method === "POST") {
            const { dir, name } = await req.json();
            if (!["snippets", "sites"].includes(dir)) return json({ error: "invalid dir" }, 400);
            if (!NAME_RE.test(name)) return json({ error: "invalid name (a-z, 0-9, _, - only)" }, 400);
            const rel = `${dir}/${name}.caddy`;
            const p = safePath(rel)!;
            if (await Bun.file(p).exists()) return json({ error: "file exists" }, 409);
            await Bun.write(p, "");
            return json({ ok: true, path: rel });
        }

        if (url.pathname === "/api/rename" && req.method === "POST") {
            const { oldPath, newName } = await req.json();
            if (oldPath === "Caddyfile") return json({ error: "Cannot rename Caddyfile" }, 400);
            if (!NAME_RE.test(newName)) return json({ error: "invalid name (a-z, 0-9, _, - only)" }, 400);
            const oldP = safePath(oldPath);
            if (!oldP) return json({ error: "invalid path" }, 400);
            const dir = oldPath.split("/")[0];
            const newRel = `${dir}/${newName}.caddy`;
            const newP = safePath(newRel)!;
            if (await Bun.file(newP).exists()) return json({ error: "target exists" }, 409);
            const { renameSync } = await import("node:fs");
            renameSync(oldP, newP);
            return json({ ok: true, path: newRel });
        }

        if (url.pathname === "/api/info") {
            const proc = await $`caddy version`.nothrow().quiet();
            const version = proc.stdout.toString().trim().split(/\s+/)[0] || "?";
            return json({ version, appVersion: VERSION });
        }

        if (url.pathname === "/api/update/check") {
            const rel = await latestRelease();
            if (!rel) return json({ current: VERSION, latest: null, behind: false });
            const latest = rel.tag.replace(/^v/, "");
            return json({
                current: VERSION,
                latest,
                behind: cmpVer(latest, VERSION) > 0,
                url: rel.url,
                notes: rel.notes,
            });
        }

        if (url.pathname === "/api/update/apply" && req.method === "POST") {
            const rel = await latestRelease();
            if (!rel) return json({ ok: false, error: "cannot resolve latest release" }, 502);
            const base = `https://raw.githubusercontent.com/${REPO}/${rel.tag}`;
            const files = ["server.ts", "hosts.js", "favicon.png"];
            const downloaded: Record<string, ArrayBuffer> = {};
            for (const f of files) {
                const r = await fetch(`${base}/${f}`, { headers: { "user-agent": "easycaddy" } });
                if (!r.ok) return json({ ok: false, error: `download ${f} failed (HTTP ${r.status})` }, 502);
                downloaded[f] = await r.arrayBuffer();
            }
            // Sanity-check the main file before overwriting anything.
            const serverText = new TextDecoder().decode(downloaded["server.ts"]);
            if (!serverText.includes("Bun.serve")) {
                return json({ ok: false, error: "downloaded server.ts looks invalid — aborted" }, 502);
            }
            for (const f of files) {
                await Bun.write(join(HERE, f), downloaded[f]);
            }
            // Restart in a detached transient unit so this process can reply first
            // and the restart isn't killed as part of our own cgroup.
            const restart = await $`systemd-run --on-active=2 systemctl restart easycaddy`.nothrow().quiet();
            return json({
                ok: true,
                version: rel.tag.replace(/^v/, ""),
                restarting: restart.exitCode === 0,
                note: restart.exitCode === 0 ? undefined : "files updated; run 'systemctl restart easycaddy' to apply",
            });
        }

        if (url.pathname === "/api/certs") {
            const certsDir = "/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory";
            const certs = [];
            try {
                for (const name of readdirSync(certsDir)) {
                    const crt = `${certsDir}/${name}/${name}.crt`;
                    if (!(await Bun.file(crt).exists())) continue;
                    const proc = await $`openssl x509 -in ${crt} -noout -enddate`.nothrow().quiet();
                    const m = proc.stdout.toString().match(/notAfter=(.+)/);
                    if (m) {
                        const exp = new Date(m[1].trim());
                        const daysLeft = Math.floor((exp.getTime() - Date.now()) / 86400000);
                        certs.push({ domain: name, expires: exp.toISOString(), daysLeft });
                    }
                }
                certs.sort((a, b) => a.daysLeft - b.daysLeft);
                return json({ certs });
            } catch (e) {
                return json({ certs: [], error: String(e) });
            }
        }

        if (url.pathname === "/api/upstreams") {
            try {
                const r = await fetch("http://127.0.0.1:2019/reverse_proxy/upstreams");
                return json({ upstreams: await r.json() });
            } catch (e) {
                return json({ upstreams: [], error: String(e) });
            }
        }

        if (url.pathname === "/api/log") {
            const raw = parseInt(url.searchParams.get("lines") || "100", 10);
            const lines = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 1000) : 100;
            const proc = await $`tail -n ${lines} /var/log/caddy/access.log`.nothrow().quiet();
            return json({ log: proc.stdout.toString() });
        }

        if (url.pathname === "/api/validate" && req.method === "POST") {
            const proc = await $`caddy validate --config /etc/caddy/Caddyfile`.nothrow().quiet();
            const out = proc.stderr.toString() || proc.stdout.toString();
            return json({ ok: proc.exitCode === 0, output: out.trim() });
        }

        if (url.pathname === "/api/reload" && req.method === "POST") {
            const proc = await $`systemctl reload caddy`.nothrow().quiet();
            const out = proc.stderr.toString() || proc.stdout.toString() || "Reloaded";
            return json({ ok: proc.exitCode === 0, output: out.trim() });
        }

        return new Response("Not found", { status: 404 });
    },
});

console.log(`easycaddy listening on :${PORT}`);
