const MODULES = [
  { job: "wealth-gateway", module: "gateway", title: "网关", repo: "wealth-freedom", image: "wealth-gateway", java: true },
  { job: "wealth-auth", module: "auth", title: "认证", repo: "wealth-freedom", image: "wealth-auth", java: true },
  { job: "wealth-system-server", module: "system-server", title: "系统服务", repo: "wealth-freedom", image: "wealth-system-server", java: true },
  { job: "wealth-admin-server", module: "admin-server", title: "管理后端", repo: "wealth-freedom", image: "wealth-admin-server", java: true },
  { job: "wealth-ecommerce-server", module: "ecommerce-server", title: "电商后端", repo: "wealth-freedom", image: "wealth-ecommerce-server", java: true },
  { job: "wealth-freedom-web", module: "freedom-web", title: "管理前端", repo: "wealth-freedom-web", image: "wealth-freedom-web", java: false },
  { job: "wealth-ecommerce-web", module: "ecommerce-web", title: "电商前端", repo: "wealth-ecommerce-web", image: "wealth-ecommerce-web", java: false },
  { job: "wealth-all", module: "all", title: "全量 7 模块", repo: "wealth-all", image: "", java: true },
];

const state = {
  module: MODULES[0],
  mode: "build-deploy",
  meta: { branches: {}, tags: {} },
  selectedTag: "auto",
  crumb: null,
  crumbField: "Jenkins-Crumb",
};

const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const headers = Object.assign({ Accept: "application/json" }, opts.headers || {});
  if (opts.method && opts.method !== "GET" && state.crumb) {
    headers[state.crumbField] = state.crumb;
  }
  const res = await fetch(path, Object.assign({ credentials: "same-origin" }, opts, { headers }));
  return res;
}

function showLogin() {
  $("login-banner").classList.remove("hidden");
  $("user-chip").textContent = "未登录";
}

function hideLogin() {
  $("login-banner").classList.add("hidden");
}

async function loadSession() {
  const who = await api("/whoAmI/api/json");
  if (who.status === 401 || who.status === 403) {
    showLogin();
    return false;
  }
  if (!who.ok) {
    showLogin();
    return false;
  }
  const data = await who.json();
  if (!data.authenticated) {
    showLogin();
    return false;
  }
  $("login-banner").classList.add("hidden");
  $("user-chip").textContent = data.name || "已登录";
  const crumbRes = await api("/crumbIssuer/api/json");
  if (crumbRes.ok) {
    const crumb = await crumbRes.json();
    state.crumb = crumb.crumb;
    state.crumbField = crumb.crumbRequestField || "Jenkins-Crumb";
  }
  return true;
}

async function loadMeta() {
  const urls = ["./data/meta.json", "/userContent/wealth-data/meta.json"];
  for (const url of urls) {
    try {
      const res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
      if (res.ok) {
        state.meta = await res.json();
        return;
      }
    } catch (_e) {
      /* 下一处 */
    }
  }
}

function branchesFor(mod) {
  const fromMeta = (state.meta.branches && state.meta.branches[mod.repo]) || [];
  const list = fromMeta.length ? fromMeta.slice() : ["main"];
  if (!list.includes("main")) list.unshift("main");
  return [...new Set(list)];
}

function tagsFor(mod) {
  return (state.meta.tags && state.meta.tags[mod.image]) || [];
}

function renderModules() {
  const nav = $("module-nav");
  nav.innerHTML = "";
  MODULES.forEach((m) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mod" + (m.job === state.module.job ? " active" : "");
    btn.innerHTML = `<strong>${m.title}</strong><small>${m.job}</small>`;
    btn.addEventListener("click", () => {
      state.module = m;
      state.selectedTag = "auto";
      renderModules();
      renderForm();
      loadBuilds();
    });
    nav.appendChild(btn);
  });
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.mode === mode));
  $("build-fields").classList.toggle("hidden", mode === "rollback");
  $("rollback-fields").classList.toggle("hidden", mode !== "rollback");
  $("btn-submit").textContent = mode === "rollback" ? "启动所选历史版本" : "开始构建部署";
  if (mode === "rollback") $("image-tag").value = state.selectedTag === "auto" ? "" : state.selectedTag;
  else $("image-tag").value = "auto";
}

function renderHistory() {
  const box = $("history-list");
  const tags = tagsFor(state.module).slice(0, 10);
  if (!state.module.image) {
    box.innerHTML = "<p class=\"hint\">全量 Job 回滚需要每个模块都有相同 tag，建议在单模块里启动历史版本。</p>";
    return;
  }
  if (!tags.length) {
    box.innerHTML = "<p class=\"hint\">还没有缓存到镜像 tag。可先构建一次，或点左侧「刷新分支 / 镜像缓存」。</p>";
    return;
  }
  box.innerHTML = "";
  tags.forEach((item, idx) => {
    const tag = typeof item === "string" ? item : item.tag;
    const meta = typeof item === "string" ? "" : [item.created, item.size].filter(Boolean).join(" · ");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hist" + (state.selectedTag === tag ? " active" : "");
    btn.innerHTML = `<span class="tag">${tag}</span><span class="meta">${meta || "历史版本 " + (idx + 1)}</span>`;
    btn.addEventListener("click", () => {
      state.selectedTag = tag;
      $("image-tag").value = tag;
      renderHistory();
    });
    box.appendChild(btn);
  });
  if (state.selectedTag === "auto" && tags[0]) {
    state.selectedTag = typeof tags[0] === "string" ? tags[0] : tags[0].tag;
    $("image-tag").value = state.selectedTag;
    renderHistory();
  }
}

function renderForm() {
  const sel = $("branch");
  const branches = branchesFor(state.module);
  sel.innerHTML = branches.map((b) => `<option value="${b}">${b}</option>`).join("");
  $("skip-mvn-wrap").classList.toggle("hidden", !state.module.java);
  $("console-link").href = `/job/${state.module.job}/`;
  renderHistory();
}

function parseImageTag(desc) {
  if (!desc) return "";
  const m = desc.match(/IMAGE_TAG=([^\s]+)/);
  return m ? m[1] : "";
}

function fmtTime(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return d.toLocaleString("zh-CN", { hour12: false });
}

async function loadBuilds() {
  const ul = $("build-list");
  ul.textContent = "加载中…";
  const res = await api(
    `/job/${encodeURIComponent(state.module.job)}/api/json?tree=builds[number,result,building,description,timestamp,url]{0,10}`
  );
  if (!res.ok) {
    ul.textContent = "无法读取构建历史（需要登录）。";
    return;
  }
  const data = await res.json();
  const builds = data.builds || [];
  if (!builds.length) {
    ul.innerHTML = "<li class=\"muted\">暂无构建</li>";
    return;
  }
  ul.innerHTML = "";
  const histFromBuilds = [];
  builds.forEach((b) => {
    const tag = parseImageTag(b.description);
    const result = b.building ? "BUILDING" : b.result || "null";
    const li = document.createElement("li");
    li.innerHTML = `<span class="badge ${result}">#${b.number} ${result}</span>
      <span>${tag || b.description || "—"}<br /><span class="muted">${fmtTime(b.timestamp)}</span></span>
      <a href="${b.url}console" target="_blank" rel="noopener">日志</a>`;
    ul.appendChild(li);
    if (tag && tag !== "auto" && !histFromBuilds.includes(tag)) histFromBuilds.push(tag);
  });
  const image = state.module.image;
  if (image && histFromBuilds.length) {
    const current = tagsFor(state.module).map((t) => (typeof t === "string" ? t : t.tag));
    const merged = [...histFromBuilds, ...current];
    state.meta.tags = state.meta.tags || {};
    state.meta.tags[image] = [...new Set(merged)].slice(0, 10);
    renderHistory();
  }
}

async function triggerRefresh() {
  $("form-status").textContent = "正在刷新缓存…";
  const res = await api("/job/wealth-refresh-branches/build", { method: "POST" });
  if (res.status === 201 || res.ok) {
    $("form-status").className = "status ok";
    $("form-status").textContent = "已触发 wealth-refresh-branches，约十几秒后重新打开本页。";
  } else {
    $("form-status").className = "status bad";
    $("form-status").textContent = `刷新失败 HTTP ${res.status}`;
  }
}

function onShaInput() {
  const sha = $("git-sha").value.trim();
  const hint = $("sha-hint");
  if (sha.length >= 7) {
    hint.textContent = "已填写 Commit：构建时会按该 SHA 取代码，并自动选择它所属的分支（main / dev 等）。";
  } else {
    hint.textContent = "留空 = 构建所选分支最新代码。填完整 SHA 后，构建脚本会 fetch 该 commit 并自动选择所属分支。";
  }
}

async function onSubmit(ev) {
  ev.preventDefault();
  const btn = $("btn-submit");
  const status = $("form-status");
  const sha = $("git-sha").value.trim();
  const params = new URLSearchParams();
  params.set("MODE", state.mode);
  params.set("OVERLAY", $("overlay").value);
  params.set("SOURCE", $("source").value);
  params.set("BRANCH", $("branch").value || "main");
  params.set("GIT_SHA", sha);
  params.set("REGISTRY", $("registry").value.trim());
  if (state.module.java) params.set("SKIP_MVN", $("skip-mvn").checked ? "true" : "false");

  if (state.mode === "rollback") {
    const tag = $("image-tag").value.trim();
    if (!tag || tag === "auto") {
      status.className = "status bad";
      status.textContent = "请先在上方点选一个历史版本。";
      return;
    }
    params.set("IMAGE_TAG", tag);
  } else {
    params.set("IMAGE_TAG", "auto");
  }

  btn.disabled = true;
  status.className = "status";
  status.textContent = "已提交，正在排队…";
  const res = await api(`/job/${encodeURIComponent(state.module.job)}/buildWithParameters`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  btn.disabled = false;
  if (res.status === 201 || res.ok) {
    status.className = "status ok";
    status.textContent = "已触发。下方「最近构建」几秒后会刷新。";
    setTimeout(loadBuilds, 2500);
  } else if (res.status === 403 || res.status === 401) {
    showLogin();
    status.className = "status bad";
    status.textContent = "未登录或没有构建权限。";
  } else {
    status.className = "status bad";
    status.textContent = `触发失败 HTTP ${res.status}`;
  }
}

function bind() {
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setMode(t.dataset.mode)));
  $("build-form").addEventListener("submit", onSubmit);
  $("btn-refresh-meta").addEventListener("click", triggerRefresh);
  $("git-sha").addEventListener("input", onShaInput);
}

async function main() {
  bind();
  renderModules();
  await loadMeta();
  renderForm();
  setMode("build-deploy");
  const ok = await loadSession();
  if (ok) await loadBuilds();
}

main();
