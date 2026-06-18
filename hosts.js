// hosts.js — form layer over the Caddyfile.
// Pure client-side: parses sites/*.caddy into structured "host" objects,
// renders them as cards, edits them via forms, and writes plain Caddyfile
// blocks back through the existing /api/file endpoints. No database, no
// server-side config model — the .caddy files remain the source of truth.
//
// Loaded BEFORE the inline app script, so it only DEFINES functions here;
// helpers it uses ($$, esc, api, modal, setStatus, loadFiles, loadVersion,
// openFile) come from the inline script and are only touched at call time.

"use strict";

let hostsData = [];
let availableSnippets = [];

// ---- View switching (Hosts dashboard <-> raw Files editor) ----
function setView(v) {
    const app = document.querySelector("#app");
    if (!app) return;
    app.classList.toggle("mode-hosts", v === "hosts");
    app.classList.toggle("mode-files", v === "files");
    document.querySelectorAll(".nav-tab").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
    if (v === "hosts") loadHosts();
    else loadFiles();
}

document.querySelectorAll(".nav-tab").forEach((b) => {
    b.onclick = () => setView(b.dataset.view);
});

// ---- Self-update (GitHub releases) --------------------------------------
async function checkUpdate() {
    const btn = document.querySelector("#update-btn");
    if (!btn) return;
    const r = await api("/api/update/check");
    if (!r || !r.behind) { btn.style.display = "none"; return; }
    btn.style.display = "";
    btn.textContent = "⬆ Update to v" + r.latest;
    btn.dataset.latest = r.latest;
    btn.dataset.notes = r.notes || "";
    btn.onclick = openUpdateModal;
}

async function openUpdateModal() {
    const btn = document.querySelector("#update-btn");
    let msg = "Update easycaddy to <b>v" + esc(btn.dataset.latest) + "</b>?<br><br>" +
        "This downloads the release files and restarts the service. You will be logged out and need to sign in again.";
    if (btn.dataset.notes) {
        msg += "<br><br><span style='color:#888;white-space:pre-wrap'>" + esc(btn.dataset.notes.slice(0, 600)) + "</span>";
    }
    if (await modal.confirm(msg, "Update now")) applyUpdate();
}

async function applyUpdate() {
    setStatus("Downloading update…");
    const r = await api("/api/update/apply", { method: "POST" });
    if (!r) return;
    if (!r.ok) { setStatus(r.error || "Update failed", "error"); return; }
    if (r.restarting) {
        setStatus("Update v" + r.version + " downloaded — restarting easycaddy…");
        pollBackUp();
    } else {
        setStatus(r.note || "Files updated. Restart easycaddy manually to apply.", "warn");
    }
}

// After a restart the server comes back but in-memory sessions are gone, so we
// just wait for any HTTP response (even 401) and then reload to the login screen.
function pollBackUp() {
    let tries = 0;
    const iv = setInterval(async () => {
        tries++;
        try {
            await fetch("/favicon.png", { cache: "no-store" });
            clearInterval(iv);
            setStatus("Updated — reloading…");
            setTimeout(() => location.reload(), 800);
        } catch {
            if (tries > 40) { clearInterval(iv); setStatus("Restart is taking a while — reload the page manually.", "warn"); }
        }
    }, 1500);
}

// ---- Tiny Caddyfile parser ----------------------------------------------
// Quote- and comment-aware enough for round-tripping our own generated
// blocks and best-effort parsing of hand-written ones.

function stripComment(line) {
    let out = "";
    let inStr = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') inStr = !inStr;
        if (c === "#" && !inStr) break;
        out += c;
    }
    return out;
}

function countBraces(s) {
    let d = 0;
    let inStr = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === "{") d++;
        else if (c === "}") d--;
    }
    return d;
}

// Split a file into top-level site blocks. Global option blocks ({...} with
// no address) and bare top-level directives (import ...) are ignored.
function scanBlocks(text) {
    const blocks = [];
    const lines = text.split("\n");
    let depth = 0;
    let addr = null;
    let body = [];
    for (const raw of lines) {
        const nc = stripComment(raw);
        if (depth === 0) {
            const t = nc.trim();
            if (!t) continue;
            if (/\{\s*$/.test(t) && countBraces(nc) > 0) {
                addr = t.replace(/\s*\{\s*$/, "").split(/[\s,]+/).filter(Boolean);
                depth = countBraces(nc);
                body = [];
            }
            // otherwise: top-level directive / stray line -> skip
        } else {
            const delta = countBraces(nc);
            if (depth + delta <= 0) {
                blocks.push({ addresses: addr, body: body.join("\n") });
                depth = 0;
                addr = null;
                body = [];
            } else {
                body.push(raw);
                depth += delta;
            }
        }
    }
    return blocks;
}

// Split a block body into directive statements; a directive that opens its
// own { } sub-block is kept whole (possibly multi-line).
function bodyStatements(body) {
    const lines = body.split("\n");
    const out = [];
    let d = 0;
    let acc = [];
    for (const ln of lines) {
        const nc = stripComment(ln);
        if (d === 0 && !nc.trim()) continue;
        acc.push(ln);
        d += countBraces(nc);
        if (d <= 0) {
            out.push(acc.join("\n"));
            acc = [];
            d = 0;
        }
    }
    if (acc.length) out.push(acc.join("\n"));
    return out;
}

const ADV_PLACEHOLDER = "__advanced__";

function blockToHost(block) {
    const h = {
        domains: block.addresses || [],
        gzip: false,
        imports: [],
        hsts: false,
        tls: "",
        upstreams: [],
        redirTo: "",
        redirCode: "",
        root: "",
        fileServer: false,
        basicUser: "",
        basicHash: "",
        advanced: [],
        type: "custom",
    };
    for (const s of bodyStatements(block.body)) {
        const t = stripComment(s).trim();
        if (!t) continue;
        const tok = t.split(/\s+/);
        const name = tok[0];
        // A real sub-block opens with a trailing "{" or spans multiple lines;
        // a bare "{...}" inside a value (e.g. the {uri} placeholder) is not one.
        const multi = /\n/.test(s) || /\{\s*$/.test(t);
        if (name === "reverse_proxy" && !multi) {
            h.upstreams = tok.slice(1);
            h.type = "proxy";
        } else if (name === "redir" && !multi) {
            h.redirTo = tok[1] || "";
            h.redirCode = tok[2] || "";
            if (h.type === "custom") h.type = "redirect";
        } else if (name === "encode" && !multi) {
            h.gzip = true;
        } else if (name === "import" && !multi) {
            // `import <snippet>` with no args is form-managed; imports with args
            // or globs (import x a b / import sites/*.caddy) are kept verbatim.
            if (tok.length === 2) h.imports.push(tok[1]);
            else h.advanced.push(s);
        } else if (name === "root" && !multi) {
            h.root = tok[tok.length - 1];
            if (h.type === "custom") h.type = "static";
        } else if (name === "file_server" && !multi) {
            h.fileServer = true;
            if (h.type === "custom") h.type = "static";
        } else if (name === "tls" && !multi) {
            h.tls = tok.slice(1).join(" ");
        } else if (name === "header" && !multi && /Strict-Transport-Security/i.test(t)) {
            h.hsts = true;
        } else if ((name === "basic_auth" || name === "basicauth") && multi) {
            const m = s.match(/\{([^]*)\}/);
            if (m) {
                const parts = m[1].trim().split(/\s+/).filter(Boolean);
                h.basicUser = parts[0] || "";
                h.basicHash = parts.slice(1).join(" ") || "";
            }
        } else {
            h.advanced.push(s);
        }
    }
    return h;
}

// ---- Generate a Caddyfile block from a host object ----------------------
function hostToText(h) {
    const L = [];
    const ind = "\t";
    L.push(h.domains.join(" ").trim() + " {");
    if (h.tls) L.push(ind + "tls " + h.tls);
    for (const im of h.imports || []) L.push(ind + "import " + im);
    if (h.hsts) L.push(ind + 'header Strict-Transport-Security "max-age=31536000; includeSubDomains"');
    if (h.gzip) L.push(ind + "encode gzip zstd");
    if (h.basicUser && h.basicHash) {
        L.push(ind + "basic_auth {");
        L.push(ind + ind + h.basicUser + " " + h.basicHash);
        L.push(ind + "}");
    }
    if (h.type === "proxy" && h.upstreams.length) {
        L.push(ind + "reverse_proxy " + h.upstreams.join(" "));
    }
    if (h.type === "redirect" && h.redirTo) {
        L.push(ind + "redir " + h.redirTo + (h.redirCode ? " " + h.redirCode : ""));
    }
    if (h.type === "static") {
        if (h.root) L.push(ind + "root * " + h.root);
        if (h.fileServer) L.push(ind + "file_server");
    }
    for (const a of h.advanced) {
        for (const ln of a.split("\n")) L.push(ind + ln.replace(/^\t+/, ""));
    }
    L.push("}");
    return L.join("\n") + "\n";
}

// ---- Dashboard ----------------------------------------------------------
async function loadHosts() {
    const sr = await api("/api/snippets");
    availableSnippets = (sr && sr.snippets) || [];
    const r = await api("/api/sites");
    if (!r) return;
    hostsData = [];
    for (const f of r.sites || []) {
        const blocks = scanBlocks(f.content);
        const editable = blocks.length === 1;
        for (const b of blocks) {
            hostsData.push({ host: blockToHost(b), path: f.path, editable: editable });
        }
    }
    renderHosts();
}

const TYPE_LABELS = { proxy: "Reverse proxies", redirect: "Redirections", static: "Static / file server", custom: "Custom blocks" };
const TYPE_ORDER = ["proxy", "redirect", "static", "custom"];

function hostTarget(h) {
    if (h.type === "proxy") return "→ " + (h.upstreams.join(", ") || "(no upstream)");
    if (h.type === "redirect") return "→ " + (h.redirTo || "(no target)") + (h.redirCode ? " [" + h.redirCode + "]" : "");
    if (h.type === "static") return "root " + (h.root || "*") + (h.fileServer ? " · file_server" : "");
    return "custom config";
}

function renderHosts() {
    const view = document.querySelector("#hosts-view");
    let html = "";
    html += '<div class="hosts-head">';
    html += "<h2>Hosts</h2>";
    html += '<span id="hosts-status"></span>';
    html += '<span style="flex:1"></span>';
    html += '<button id="h-new">+ New host</button>';
    html += '<button id="h-validate" class="ghost">Validate</button>';
    html += '<button id="h-reload" class="danger">Reload Caddy</button>';
    html += "</div>";

    if (!hostsData.length) {
        html += '<div class="empty">No sites yet. Click <b>+ New host</b> to add your first reverse proxy.</div>';
    }

    const groups = {};
    hostsData.forEach((entry, i) => {
        const t = entry.host.type;
        (groups[t] = groups[t] || []).push(i);
    });

    for (const t of TYPE_ORDER) {
        const idxs = groups[t];
        if (!idxs || !idxs.length) continue;
        html += '<div class="host-group"><div class="host-group-title">' + TYPE_LABELS[t] + "</div><div class=\"cards\">";
        for (const i of idxs) {
            const e = hostsData[i];
            const h = e.host;
            html += '<div class="card">';
            html += '<div class="domain">' + esc(h.domains.join("  ") || "(no domain)") + "</div>";
            html += '<div class="target">' + esc(hostTarget(h)) + "</div>";
            html += '<div class="badges">';
            if (h.tls === "internal") html += '<span class="badge">tls internal</span>';
            else if (h.tls) html += '<span class="badge tls">custom cert</span>';
            else html += '<span class="badge tls">auto-HTTPS</span>';
            if (h.hsts) html += '<span class="badge">HSTS</span>';
            if (h.gzip) html += '<span class="badge">gzip</span>';
            for (const im of h.imports || []) html += '<span class="badge">import ' + esc(im.split(/\s+/)[0]) + "</span>";
            if (h.basicUser) html += '<span class="badge auth">auth</span>';
            if (!e.editable) html += '<span class="badge locked">multi-block · raw only</span>';
            html += "</div>";
            html += '<div class="card-actions">';
            html += '<button data-edit="' + i + '">' + (e.editable ? "Edit" : "Open raw") + "</button>";
            html += '<button class="danger" data-del="' + i + '">Delete</button>';
            html += "</div></div>";
        }
        html += "</div></div>";
    }

    view.innerHTML = html;

    document.querySelector("#h-new").onclick = () => openHostForm(null);
    document.querySelector("#h-validate").onclick = () => document.querySelector("#validate").click();
    document.querySelector("#h-reload").onclick = () => document.querySelector("#reload").click();
    view.querySelectorAll("[data-edit]").forEach((b) => {
        b.onclick = () => {
            const e = hostsData[+b.dataset.edit];
            if (e.editable) openHostForm(e);
            else { setView("files"); openFile(e.path); }
        };
    });
    view.querySelectorAll("[data-del]").forEach((b) => {
        b.onclick = () => deleteHost(hostsData[+b.dataset.del]);
    });
}

// ---- Host form ----------------------------------------------------------
function val(sel) { const el = document.querySelector(sel); return el ? el.value.trim() : ""; }
function checked(sel) { const el = document.querySelector(sel); return el ? el.checked : false; }

function openHostForm(entry) {
    const isNew = !entry;
    const h = entry ? entry.host : {
        domains: [], gzip: false,
        imports: availableSnippets.indexOf("default_headers") >= 0 ? ["default_headers"] : [],
        hsts: false, tls: "",
        upstreams: [], redirTo: "", redirCode: "302", root: "", fileServer: true,
        basicUser: "", basicHash: "", advanced: [], type: "proxy",
    };
    const wrap = document.querySelector("#modal-wrap");

    const tlsMode = h.tls === "internal" ? "internal" : h.tls ? "custom" : "auto";
    const tlsParts = h.tls && h.tls !== "internal" ? h.tls.split(/\s+/) : ["", ""];

    let html = "";
    html += '<div class="modal-bg"><div class="modal wide">';
    html += "<h3>" + (isNew ? "New host" : "Edit " + esc(h.domains.join(" "))) + "</h3>";

    // Type selector
    html += '<div class="hf-row"><label>Type</label><select id="hf-type">';
    [["proxy", "Reverse proxy"], ["redirect", "Redirection"], ["static", "Static / file server"]].forEach(([v, lbl]) => {
        html += '<option value="' + v + '"' + (h.type === v ? " selected" : "") + ">" + lbl + "</option>";
    });
    html += "</select></div>";

    // Tabs
    html += '<div class="hf-tabs">';
    html += '<button class="hf-tab active" data-pane="details">Details</button>';
    html += '<button class="hf-tab" data-pane="ssl">TLS &amp; Security</button>';
    html += '<button class="hf-tab" data-pane="advanced">Advanced</button>';
    html += "</div>";

    // --- Details pane ---
    html += '<div class="hf-pane active" data-pane="details">';
    html += '<div class="hf-row"><label>Domain(s) — space separated</label><input type="text" id="hf-domains" value="' + esc(h.domains.join(" ")) + '" placeholder="app.example.com www.example.com"></div>';
    // proxy
    html += '<div class="hf-type-proxy">';
    html += '<div class="hf-row"><label>Upstream(s) — space separated host:port</label><input type="text" id="hf-upstreams" value="' + esc(h.upstreams.join(" ")) + '" placeholder="192.168.1.100:3000"><div class="hf-hint">Use https:// prefix for TLS backends. Caddy handles websockets automatically.</div></div>';
    html += "</div>";
    // redirect
    html += '<div class="hf-type-redirect">';
    html += '<div class="hf-cols"><div class="hf-row"><label>Redirect to</label><input type="text" id="hf-redir" value="' + esc(h.redirTo) + '" placeholder="https://example.com{uri}"></div>';
    html += '<div class="hf-row" style="max-width:140px"><label>Status</label><select id="hf-redir-code">';
    ["301", "302", "307", "308"].forEach((c) => { html += '<option' + ((h.redirCode || "302") === c ? " selected" : "") + ">" + c + "</option>"; });
    html += "</select></div></div></div>";
    // static
    html += '<div class="hf-type-static">';
    html += '<div class="hf-row"><label>Root directory</label><input type="text" id="hf-root" value="' + esc(h.root) + '" placeholder="/var/www/site"></div>';
    html += '<label class="hf-check"><input type="checkbox" id="hf-fileserver"' + (h.fileServer ? " checked" : "") + "> Enable file_server</label>";
    html += "</div>";
    // shared
    html += '<label class="hf-check"><input type="checkbox" id="hf-gzip"' + (h.gzip ? " checked" : "") + "> Compress responses (encode gzip zstd)</label>";
    const importedNames = (h.imports || []).map((im) => im.split(/\s+/)[0]);
    const allSnips = Array.from(new Set(availableSnippets.concat(importedNames)));
    html += '<div class="hf-row" style="margin-top:6px"><label>Import snippets</label><div id="hf-imports">';
    if (allSnips.length) {
        for (const s of allSnips) {
            html += '<label class="hf-check"><input type="checkbox" data-snippet="' + esc(s) + '"' + (importedNames.indexOf(s) >= 0 ? " checked" : "") + "> " + esc(s) + "</label>";
        }
    } else {
        html += '<div class="hf-hint">No snippets defined in snippets/. Create one to reuse common config.</div>';
    }
    html += "</div></div>";
    html += "</div>";

    // --- TLS pane ---
    html += '<div class="hf-pane" data-pane="ssl">';
    html += '<div class="hf-row"><label>Certificate</label>';
    [["auto", "Automatic HTTPS (Let&#39;s Encrypt) — recommended"], ["internal", "Internal CA (tls internal) — for LAN / dev"], ["custom", "Custom certificate files"]].forEach(([v, lbl]) => {
        html += '<label class="hf-check"><input type="radio" name="hf-tls" value="' + v + '"' + (tlsMode === v ? " checked" : "") + "> " + lbl + "</label>";
    });
    html += "</div>";
    html += '<div class="hf-cols hf-tls-custom"><div class="hf-row"><label>Cert file</label><input type="text" id="hf-cert" value="' + esc(tlsParts[0] || "") + '" placeholder="/path/cert.pem"></div>';
    html += '<div class="hf-row"><label>Key file</label><input type="text" id="hf-key" value="' + esc(tlsParts[1] || "") + '" placeholder="/path/key.pem"></div></div>';
    html += '<label class="hf-check"><input type="checkbox" id="hf-hsts"' + (h.hsts ? " checked" : "") + "> Add HSTS header (force HTTPS in browsers)</label>";
    html += '<div class="hf-row" style="margin-top:14px"><label>Basic auth (optional)</label>';
    html += '<div class="hf-cols"><input type="text" id="hf-bauser" value="' + esc(h.basicUser) + '" placeholder="username"><input type="password" id="hf-bapass" placeholder="' + (h.basicHash ? "•••••• (unchanged)" : "password") + '"></div>';
    html += '<div class="hf-hint">Leave password blank to keep the existing one. Hashed via caddy hash-password on save.</div></div>';
    html += "</div>";

    // --- Advanced pane ---
    html += '<div class="hf-pane" data-pane="advanced">';
    html += '<div class="hf-row"><label>Extra directives (placed verbatim inside the block)</label><textarea id="hf-advanced" spellcheck="false" placeholder="header /api/* X-Foo bar">' + esc(h.advanced.join("\n")) + "</textarea></div>";
    html += "</div>";

    html += '<div class="modal-actions"><button class="ghost" data-cancel>Cancel</button><button data-ok>Save</button></div>';
    html += "</div></div>";

    wrap.innerHTML = html;

    const close = () => { wrap.innerHTML = ""; };

    // tab switching
    wrap.querySelectorAll(".hf-tab").forEach((t) => {
        t.onclick = () => {
            wrap.querySelectorAll(".hf-tab").forEach((x) => x.classList.toggle("active", x === t));
            wrap.querySelectorAll(".hf-pane").forEach((p) => p.classList.toggle("active", p.dataset.pane === t.dataset.pane));
        };
    });

    // show/hide type-specific rows
    const syncType = () => {
        const ty = val("#hf-type") || document.querySelector("#hf-type").value;
        wrap.querySelectorAll(".hf-type-proxy").forEach((el) => (el.style.display = ty === "proxy" ? "" : "none"));
        wrap.querySelectorAll(".hf-type-redirect").forEach((el) => (el.style.display = ty === "redirect" ? "" : "none"));
        wrap.querySelectorAll(".hf-type-static").forEach((el) => (el.style.display = ty === "static" ? "" : "none"));
    };
    document.querySelector("#hf-type").onchange = syncType;
    syncType();

    // show/hide custom cert inputs
    const syncTls = () => {
        const mode = (wrap.querySelector('input[name="hf-tls"]:checked') || {}).value;
        wrap.querySelectorAll(".hf-tls-custom").forEach((el) => (el.style.display = mode === "custom" ? "" : "none"));
    };
    wrap.querySelectorAll('input[name="hf-tls"]').forEach((r) => (r.onchange = syncTls));
    syncTls();

    wrap.querySelector("[data-cancel]").onclick = close;
    wrap.querySelector("[data-ok]").onclick = () => submitHostForm(entry, close);
}

async function submitHostForm(entry, close) {
    const type = document.querySelector("#hf-type").value;
    const domains = val("#hf-domains").split(/\s+/).filter(Boolean);
    if (!domains.length) { setStatus("Domain is required", "error"); return; }

    const h = {
        domains,
        type,
        gzip: checked("#hf-gzip"),
        imports: Array.from(document.querySelectorAll("#hf-imports input[data-snippet]:checked")).map((c) => c.dataset.snippet),
        hsts: checked("#hf-hsts"),
        tls: "",
        upstreams: [],
        redirTo: "",
        redirCode: "",
        root: "",
        fileServer: false,
        basicUser: "",
        basicHash: "",
        advanced: val("#hf-advanced") ? val("#hf-advanced").split("\n") : [],
    };

    if (type === "proxy") {
        h.upstreams = val("#hf-upstreams").split(/\s+/).filter(Boolean);
        if (!h.upstreams.length) { setStatus("Upstream is required for a reverse proxy", "error"); return; }
    } else if (type === "redirect") {
        h.redirTo = val("#hf-redir");
        h.redirCode = document.querySelector("#hf-redir-code").value;
        if (!h.redirTo) { setStatus("Redirect target is required", "error"); return; }
    } else if (type === "static") {
        h.root = val("#hf-root");
        h.fileServer = checked("#hf-fileserver");
    }

    // TLS
    const tlsMode = (document.querySelector('input[name="hf-tls"]:checked') || {}).value;
    if (tlsMode === "internal") h.tls = "internal";
    else if (tlsMode === "custom") {
        const cert = val("#hf-cert");
        const key = val("#hf-key");
        if (cert && key) h.tls = cert + " " + key;
    }

    // Basic auth
    const bauser = val("#hf-bauser");
    const bapass = document.querySelector("#hf-bapass").value;
    if (bauser) {
        h.basicUser = bauser;
        if (bapass) {
            setStatus("Hashing password…");
            const hr = await api("/api/hash", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ password: bapass }),
            });
            if (!hr || !hr.ok) { setStatus((hr && hr.error) || "Password hashing failed", "error"); return; }
            h.basicHash = hr.hash;
        } else if (entry && entry.host.basicUser === bauser) {
            h.basicHash = entry.host.basicHash; // keep existing
        } else {
            setStatus("Password is required for new basic auth", "error");
            return;
        }
    }

    const text = hostToText(h);
    let path = entry ? entry.path : null;

    if (!path) {
        const existing = new Set(hostsData.map((e) => e.path));
        let stem = (domains[0] || "site").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "site";
        let candidate = "sites/" + stem + ".caddy";
        let n = 2;
        while (existing.has(candidate)) { candidate = "sites/" + stem + "-" + n + ".caddy"; n++; }
        path = candidate;
        const cr = await api("/api/create", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ dir: "sites", name: path.slice("sites/".length, -".caddy".length) }),
        });
        if (!cr || !cr.ok) { setStatus((cr && cr.error) || "Could not create file", "error"); return; }
    }

    const sr = await api("/api/file", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, content: text }),
    });
    if (!sr) return;
    if (sr.ok) {
        close();
        await loadHosts();
        setStatus("Saved " + path + " — click Reload Caddy to apply");
    } else {
        setStatus(sr.error || "Save failed", "error");
    }
}

async function deleteHost(entry) {
    if (!(await modal.confirm("Delete <b>" + esc(entry.host.domains.join(" ")) + "</b> (" + esc(entry.path) + ")?", "Delete", "danger"))) return;
    const r = await api("/api/file?path=" + encodeURIComponent(entry.path), { method: "DELETE" });
    if (!r) return;
    if (r.ok) { await loadHosts(); setStatus("Deleted " + entry.path); }
    else setStatus(r.error || "Delete failed", "error");
}
