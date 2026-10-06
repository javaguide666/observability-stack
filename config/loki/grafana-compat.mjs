// qryn 的 query_range 把纳秒时间戳写成 JSON 数字。
// Grafana Loki 插件按字符串读取，遇到数字会 400，看板空白。
// 这里只把日志流（resultType=streams）里的 `[数字,"日志"]` 改成 `["数字","日志"]`。
// 指标结果（matrix / vector，例如 count_over_time、健康检查的 vector(1)+vector(1)）
// 按 Prometheus 格式时间戳必须保持数字，不能改。其余请求原样转发。
import http from "node:http";

const upstream = process.env.UPSTREAM || "http://loki:3100";
const port = Number(process.env.PORT || 3100);

function fixLokiTimestamps(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return text;
  }
  const data = json && json.data;
  if (!data || data.resultType !== "streams" || !Array.isArray(data.result)) return text;
  for (const stream of data.result) {
    for (const v of stream.values || []) {
      if (typeof v[0] === "number") v[0] = String(v[0]);
    }
  }
  return JSON.stringify(json);
}

// 下拉框走 label / series。Grafana 会带上看板的时间范围（默认最近 1 小时），
// 这一小时没打日志的模块就不会出现。选项应覆盖保留期内出现过的标签，日志面板仍按时间范围查。
function lookupAllLabels(target) {
  const path = target.pathname;
  const isLabelLookup =
    path === "/loki/api/v1/labels" ||
    path.startsWith("/loki/api/v1/label/") ||
    path === "/loki/api/v1/series";
  if (!isLabelLookup) return;
  target.searchParams.delete("start");
  target.searchParams.delete("end");
}

const server = http.createServer((req, res) => {
  const target = new URL(req.url || "/", upstream);
  lookupAllLabels(target);
  const headers = { ...req.headers, host: target.host, "accept-encoding": "identity" };
  const preq = http.request(
    target,
    { method: req.method, headers },
    (pres) => {
      const chunks = [];
      pres.on("data", (chunk) => chunks.push(chunk));
      pres.on("end", () => {
        let body = Buffer.concat(chunks);
        const path = req.url || "";
        if (path.includes("/loki/api/v1/query")) {
          body = Buffer.from(fixLokiTimestamps(body.toString("utf8")));
        }
        const out = { ...pres.headers };
        delete out["content-length"];
        delete out["transfer-encoding"];
        delete out["content-encoding"];
        res.writeHead(pres.statusCode || 502, out);
        res.end(body);
      });
    }
  );
  preq.on("error", (err) => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(err.message);
  });
  req.pipe(preq);
});

server.listen(port, "0.0.0.0");
